#!/usr/bin/env python3
"""
Příjem záznamů ze stavebních kamer pro Sky Guard.

Běží na TÉMŽE serveru jako cam-relay Constructivy a čte TÝŽ inbox —
kamera posílá obě větve jedním FTP účtem a rozdělují se až tady, podle
přípony:

    .dav → tenhle watcher    → Sky Guard (bezpečnostní záznamy)
    .jpg → watcher Constructivy → časosběr, beze změny

Každý ignoruje přípony toho druhého, takže si soubory neberou.
Prázdné adresáře uklízí watcher Constructivy — inbox je jeho.

═══ Nesahá do databáze ani do úložiště ════════════════════════════
Drží jediné tajemství, RELAY_SECRET, kterým podepisuje požadavky na
portál. Postup je:

    1. ohlásit soubor      POST /api/ingest/recording
    2. nahrát na adresu, kterou portál vrátil (PUT, jednorázová)
    3. potvrdit            POST /api/ingest/recording/confirm

Adresa vede do Hetzner Object Storage, ne do Supabase — video je
příliš objemné (devět kamer, ~300 GB denně) a Hetzner stojí ve stejném
datacentru, takže je nahrávání zadarmo.

Klíč k úložišti tu ale NENÍ ani tak: S3 klíč platí na celý bucket
a žádnou RLS nezná, takže by kompromitace téhle VPS znamenala přístup
k záznamům ze všech lokalit. Na serveru je jen tajemství, kterým jde
založit záznam u kamery, která tam už je.

═══ Bez závislostí ════════════════════════════════════════════════
Jen standardní knihovna a ffmpeg. Žádné psycopg, žádné boto3, žádné
requests — čím míň se na cizím serveru instaluje, tím míň se ho dá
napadnout skrz závislost.
"""

from __future__ import annotations

import logging
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import portal
from portal import PortalError

# ── Konfigurace ──────────────────────────────────────────────────

INBOX_DIR = Path(os.environ.get("INBOX_DIR", "/inbox"))
FAILED_DIR = Path(os.environ.get("FAILED_DIR", "/failed"))
SCAN_INTERVAL = float(os.environ.get("SCAN_INTERVAL_SEC", "5"))

# Kolikrát po sobě musí mít soubor stejnou velikost, než se bere za
# dokončený. FTP upload nemá signál „hotovo“.
STABLE_CHECKS = int(os.environ.get("STABLE_CHECKS", "3"))
MAX_ATTEMPTS = int(os.environ.get("MAX_ATTEMPTS", "3"))

# Kamera píše lokální čas bez zóny; do portálu jde UTC.
CAMERA_TZ = ZoneInfo(os.environ.get("CAMERA_TZ", "Europe/Prague"))

# PORTAL_URL, RELAY_SECRET a HTTP_TIMEOUT bydlí v portal.py — sdílí je
# se službou událostí.
HTTP_TIMEOUT = portal.HTTP_TIMEOUT
UPLOAD_TIMEOUT = float(os.environ.get("UPLOAD_TIMEOUT_SEC", "600"))

# Ping po každém průchodu. Prázdné = nehlídá se zvenčí.
HEALTHCHECK_URL = os.environ.get("HEALTHCHECK_URL", "").strip()

# Osiřelý .idx (video nedorazilo) se uklidí až po téhle době — pořadí
# uploadu není zaručené.
ORPHAN_IDX_TTL_SEC = int(os.environ.get("ORPHAN_IDX_TTL_SEC", "600"))

ONCE = os.environ.get("WATCHER_ONCE", "0") == "1"

# Čtyřznakový kód pro STARÉ soubory v H.265.
#
# Kamery nahrávají H.264 (viz MONTAZ.md) a jen ten je podporovaný.
# Tahle větev existuje proto, aby se dal přebalit záznam z SD karty
# pořízený dřív — ne jako volba pro provoz.
#
# ═══ H.265 se vzdalo po řadě měření ════════════════════════════════
# `hev1` odmítá Safari a iOS. `hvc1` parametry ze vzorků vyhodí, takže
# se ztrácejí jejich změny za běhu. Přepis kódu po remuxu dal na
# reálném záznamu rozpadlý obraz. `-bsf:v hevc_mp4toannexb` nemá na
# `.dav` žádný účinek (ffmpeg: „input looks like it is Annex B
# already"), výstup vyšel bajt po bajtu shodně.
#
# Poslední pokus — `hvc1`, vypnutý Smart Codec, I-frame 15,
# ffmpeg 7.1.5 — padal na -12909 i na iPhonu, tedy i tam, kde `hvc1`
# předtím hrál. Tím se to uzavřelo.
#
# Podrobnosti jsou v README; tady jsou proto, aby se to nezkoušelo
# znovu při čtení kódu.
HEVC_TAG = os.environ.get("HEVC_TAG", "hvc1").strip()

log = logging.getLogger("sky-watcher")


# ── Parsování Dahua cesty ────────────────────────────────────────
#
# Převzato z cam-relay Constructivy, jen bez větve pro snímky — ty sem
# nepatří. Reálná Dahua nahrává pod sériovým číslem a po 'dav' přidává
# složku s hodinou:
#
#   BK024AAPAGB5592/2026-08-19/001/dav/20/20.34.10-20.34.53[M][0@0][0].dav
#   └──sériové číslo─┘ └─datum──┘ └kan┘└typ┘└hod┘└──od───┘└──do───┘└příznaky┘
#
# Starší tvar bez sériového čísla a bez hodinové složky funguje taky:
#
#   cam-01/2026-08-19/001/dav/10.00.00-10.05.00[M][0@0][0].dav
#
# Pevné indexy proto nefungují. Kotvou je adresář s datem a zařízení je
# segment TĚSNĚ PŘED ním.

DATE_DIR_RE = re.compile(r"^(\d{4})-(\d{2})-(\d{2})$")
TIME_RANGE_RE = re.compile(r"^(\d{2})\.(\d{2})\.(\d{2})-(\d{2})\.(\d{2})\.(\d{2})")

EVENT_FLAGS = {"M": "motion", "R": "regular", "A": "alarm", "I": "intelligent"}
EVENT_DIRS = {"dav": "regular", "motion": "motion", "alarm": "alarm"}


class ParseError(ValueError):
    """Cesta nesedí na očekávaný Dahua tvar."""


def parse_dahua_path(rel_path: Path) -> dict:
    """Z cesty videa vytáhne sériové číslo, typ a časy."""
    parts = rel_path.parts
    if len(parts) < 2:
        raise ParseError(f"cesta je moc mělká: {rel_path}")

    date_part = None
    date_idx = None
    for i, seg in enumerate(parts):
        m = DATE_DIR_RE.match(seg)
        if m:
            date_part = tuple(int(g) for g in m.groups())
            date_idx = i
            break
    if date_part is None:
        raise ParseError(f"v cestě není adresář s datem YYYY-MM-DD: {rel_path}")

    # U starého tvaru cesty vyjde zařízení na FTP účet. Portál kameru
    # hledá podle sériového čísla, takže takový účet musí být v portálu
    # zapsaný jako serial_number — jinak se kamera nedohledá a soubor
    # skončí ve failed. Je to hlasitější než tichý fallback.
    device_id = parts[date_idx - 1] if date_idx > 0 else parts[0]

    filename = parts[-1]
    m = TIME_RANGE_RE.match(filename)
    if not m:
        raise ParseError(f"název nezačíná rozsahem HH.MM.SS-HH.MM.SS: {filename}")
    sh, sm, ss, eh, em, es = (int(g) for g in m.groups())

    y, mo, d = date_part
    started = datetime(y, mo, d, sh, sm, ss, tzinfo=CAMERA_TZ)
    ended = datetime(y, mo, d, eh, em, es, tzinfo=CAMERA_TZ)
    # Nahrávka přes půlnoc: konec spadl do dalšího dne.
    if ended < started:
        ended += timedelta(days=1)

    event_type = None
    for flag in re.findall(r"\[([A-Z])\]", filename):
        if flag in EVENT_FLAGS:
            event_type = EVENT_FLAGS[flag]
            break
    if event_type is None:
        for seg in reversed(parts[:-1]):
            if seg.lower() in EVENT_DIRS:
                event_type = EVENT_DIRS[seg.lower()]
                break

    return {
        "device_id": device_id,
        "event_type": event_type,
        "started_at": started.astimezone(timezone.utc),
        "ended_at": ended.astimezone(timezone.utc),
    }


# ── Portál ───────────────────────────────────────────────────────


def announce(payload: dict) -> dict:
    return portal.signed_post("/api/ingest/recording", payload)


def confirm(recording_id: str) -> dict:
    return portal.signed_post(
        "/api/ingest/recording/confirm", {"recording_id": recording_id}
    )


def upload(url: str, mp4: Path) -> None:
    """
    Pošle soubor na jednorázovou adresu od portálu.

    PUT, ne POST: adresa je podepsaná pro jedno konkrétní místo
    v úložišti a obsahem je rovnou tělo, bez formuláře.
    """
    size = mp4.stat().st_size
    with mp4.open("rb") as fh:
        request = urllib.request.Request(
            url,
            data=fh,
            method="PUT",
            headers={"Content-Type": "video/mp4", "Content-Length": str(size)},
        )
        try:
            with urllib.request.urlopen(request, timeout=UPLOAD_TIMEOUT) as response:
                response.read()
        except urllib.error.HTTPError as exc:
            text = exc.read().decode("utf-8", "replace")[:500]
            raise PortalError(f"nahrání selhalo {exc.code}", exc.code, text) from exc
        except urllib.error.URLError as exc:
            raise PortalError(f"nahrání selhalo: {exc.reason}") from exc


def ping_healthcheck(ok: bool) -> None:
    portal.ping_healthcheck(HEALTHCHECK_URL, ok)


# ── ffmpeg ───────────────────────────────────────────────────────


def probe_video_codec(src: Path) -> str | None:
    """Kodek prvního video streamu, nebo None když se nedá přečíst."""
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-select_streams", "v:0",
             "-show_entries", "stream=codec_name", "-of", "csv=p=0", str(src)],
            capture_output=True, text=True, timeout=60, check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    name = (out.stdout or "").strip().splitlines()
    return name[0] if name else None


def probe_duration(src: Path) -> float | None:
    """Délka podle hlavičky, nebo None. Čte jen hlavičku, ne obraz."""
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "csv=p=0", str(src)],
            capture_output=True, text=True, timeout=60, check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    try:
        return float((out.stdout or "").strip())
    except ValueError:
        return None


def probe_frame_rate(src: Path) -> str | None:
    """
    Snímková frekvence jako zlomek („15/1"), nebo None.

    Bere se `avg_frame_rate`, protože u DHAV pochází přímo z rozšířené
    hlavičky kontejneru (pole 0x81), kam ji píše kamera. `r_frame_rate`
    je odhad ffmpegu z časových značek a u .dav vychází dvojnásobný.

    Potřebuje ji dvoufázový remux: druhá fáze čte holý Annex-B, který
    žádné časování nenese, takže se jí musí říct.
    """
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-select_streams", "v:0",
             "-show_entries", "stream=avg_frame_rate", "-of", "csv=p=0", str(src)],
            capture_output=True, text=True, timeout=60, check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    hodnota = (out.stdout or "").strip().splitlines()
    if not hodnota:
        return None
    zlomek = hodnota[0].strip()
    try:
        citatel, jmenovatel = zlomek.split("/")
        if int(citatel) <= 0 or int(jmenovatel) <= 0:
            return None
    except ValueError:
        return None
    return zlomek


def tag_args(codec: str | None) -> list[str]:
    """
    Argumenty ffmpegu pro čtyřznakový kód video stopy.

    ═══ H.264 je NORMÁLNÍ případ ══════════════════════════════════
    Kamery se nastavují na H.264 (viz MONTAZ.md) a `avc1` je jeho
    obvyklý kód. Uvádí se výslovně, i když ho ffmpeg vybere sám —
    ověřeno, že výstup je s ním i bez něj bajt po bajtu totožný.
    Není to tedy nastavení, ale ZÁPIS ZÁMĚRU: kdyby se výchozí chování
    ffmpegu někdy změnilo, tohle drží.

    U H.264 ffmpeg parametry (SPS/PPS) nechává i ve vzorcích, ne jen
    v `avcC` — ověřeno. Tím u něj nevzniká to, co lámalo HEVC.

    ═══ HEVC už jen pro staré soubory ═════════════════════════════
    Kamery na něj nenahrávají. Tahle větev je tu, aby se dal přebalit
    záznam z SD karty pořízený dřív — ani jedna z jejích variant nebyla
    na reálném záznamu funkční, viz HEVC_TAG výš.
    """
    kodek = (codec or "").lower()

    if kodek in {"h264", "avc1"}:
        return ["-tag:v", "avc1"]

    if kodek in {"hevc", "h265"}:
        return ["-tag:v", HEVC_TAG] if HEVC_TAG else []

    # Neznámý nebo nepřečtený kodek: ffmpeg si vybere sám. Vnutit tag
    # naslepo by remux shodilo u něčeho, co jsme nečekali.
    return []


def remux_to_mp4(
    src: Path, dst: Path, ocekavana_delka: float | None = None
) -> None:
    """
    .dav → .mp4 bez překódování.

    `-c copy`: obraz se nepřepočítává, jen se přebalí.

    ═══ Kamery nahrávají H.264 ════════════════════════════════════
    A je to jediný podporovaný stav. Přehraje ho každý prohlížeč,
    `avc1` je jeho obvyklý kód a ffmpeg u něj parametry (SPS/PPS)
    NECHÁVÁ i ve vzorcích — ověřeno. Nemá se tedy co ztratit, ani když
    je kamera mění za běhu.

    Platí se za to zhruba dvojnásobným datovým tokem oproti H.265. To
    je cena za to, že se záznam dá přehrát; H.265 se po řadě měření
    vzdalo, protože se u něj nepodařilo najít kombinaci, která by
    prošla na desktopu i na iPhonu. Podrobnosti u HEVC_TAG a v README.

    Relay NIKDY nepřekódovává. Devět kamer nepřetržitě by z VPS udělalo
    překódovací farmu a obraz by se tím i zhoršil; co kamera natočí, to
    klient vidí — proto se kodek řeší v kameře, ne tady.

    ═══ Proč dvě fáze a ne prosté `-i .dav -c copy out.mp4` ═══════
    Protože demuxer DHAV ve ffmpegu neskládá dělené snímky. Kamera
    velký snímek — u 4K typicky I-snímek — rozdělí do několika úseků
    kontejneru se stejným číslem snímku a rostoucím PODČÍSLEM. Jenže
    `libavformat/dhav.c` podčíslo načte do struktury a víc s ním
    neudělá nic:

        dhav->frame_subnumber = avio_r8(s->pb);   // a dál nikde

    Z každého úseku tedy vznikne samostatný paket a z něj samostatný
    vzorek MP4. Dekodér pak dostane půlku řezu a hlásí

        error while decoding MB 54 16, bytestream -5

    Soubor přitom vypadá zdravě: jedna stopa, `avc1`, správné
    rozlišení i délka, časové značky sedí. Rozbitá jsou jen obrazová
    data. Ověřeno na syntetickém DHAV — viz test_watcher.py, kde se
    tahle vada vyrábí na povel.

    Kód je v ffmpegu 5.1 (co běží na relayi) i v současném masteru
    bajt po bajtu stejný, takže upgrade s tím nepohne.

    Řešení: fáze 1 vytáhne z kontejneru holý Annex-B, fáze 2 ho zabalí
    do MP4. Rámování ve druhé fázi se dělá podle STARTOVACÍCH ZNAČEK,
    ne podle paketů kontejneru — a tím se rozdělené kusy složí zpátky
    do celých snímků. Ověřeno: obrazový stream z opraveného souboru
    je bajt po bajtu shodný s tím z nedělené předlohy, takže se ani
    nic neztrácí, ani nepřidává.

    `+faststart` dá moov dopředu, aby šlo přehrávat od začátku stahování.

    ═══ `-an`: zvuk se zahazuje, jinak remux vůbec neprojde ═══════
    Dahua posílá zvuk jako `pcm_alaw` a ten se do MP4 zabalit NEDÁ —
    ffmpeg skončí chybou „Could not find tag for codec pcm_alaw in
    stream #1" a celý remux spadne. Nespadne ale viditelně: první
    pokus (rozpoznaný kontejner DHAV) selže kvůli zvuku a projde až
    záchranné `-f h264`, které čte soubor jako holý Annex-B — bez
    časování a s rámováním kontejneru v obraze. Přesně to je ten
    „rozpadlý obraz“, který se předtím sváděl na kodek.

    Zvuk se stejně nikde nepřehrává (viz živý pohled), takže se
    zahazuje rovnou a obrazová stopa se přebalí z kontejneru, jak má.

    `ocekavana_delka` je délka podle názvu souboru. Slouží ke kontrole,
    že přebalení nerozbilo časování — viz zkontroluj_vysledek().
    """
    kodek = (probe_video_codec(src) or "").lower()
    tag = tag_args(kodek)

    if kodek in {"hevc", "h265"}:
        # Po přepnutí kamer na H.264 může H.265 dorazit ze dvou důvodů:
        # je to starý soubor z SD karty, nebo někdo zapomněl kameru
        # přepnout. To druhé se jinak pozná až u klienta jako
        # nepřehratelné video, takže se to říká nahlas hned tady.
        log.warning(
            "Záznam je v H.265, ne v H.264: %s. Buď je to starý soubor "
            "z SD karty, nebo má kamera špatně nastavený kodek — viz "
            "MONTAZ.md.", src.name,
        )

    surovy = "hevc" if kodek in {"hevc", "h265"} else "h264"
    frekvence = probe_frame_rate(src)

    # Hlavní cesta: přes elementární stream, aby se snímky složily celé.
    if frekvence:
        chyba = remux_pres_elementarni(src, dst, surovy, frekvence, tag)
        if chyba is None:
            zkontroluj_vysledek(src, dst, [], ocekavana_delka)
            return
        log.warning(
            "Dvoufázový remux selhal (%s), zkouší se přímé přebalení: %s",
            chyba, src.name,
        )
    else:
        log.warning(
            "Nezjistila se snímková frekvence, dvoufázový remux se "
            "přeskakuje: %s. Dělené snímky se pak nesloží.", src.name,
        )

    # Záchrana: přímé přebalení. Rámování paketů zůstane takové, jaké ho
    # dá demuxer — u DHAV to znamená riziko rozdělených snímků, ale je to
    # pořád lepší než žádný soubor. Vnucený formát je poslední možnost
    # pro soubory, u kterých se kontejner vůbec nerozpozná.
    pokusy = [[], ["-f", "h264"], ["-f", "hevc"]]
    posledni = ""
    for vstup in pokusy:
        cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
               *vstup, "-i", str(src), "-c", "copy", "-an", *tag,
               "-movflags", "+faststart", str(dst)]
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=600, check=False)
        if proc.returncode == 0 and dst.exists() and dst.stat().st_size > 0:
            zkontroluj_vysledek(src, dst, vstup, ocekavana_delka)
            return
        posledni = (proc.stderr or "").strip()[:300]
        dst.unlink(missing_ok=True)

    raise RuntimeError(f"remux selhal: {posledni}")


def remux_pres_elementarni(
    src: Path, dst: Path, surovy: str, frekvence: str, tag: list[str]
) -> str | None:
    """
    Dvoufázový remux. Vrací None při úspěchu, jinak popis chyby.

    Fáze 1 vytáhne z kontejneru holý Annex-B, fáze 2 ho zabalí do MP4.
    Mezi nimi se stream NErámuje podle paketů kontejneru, ale podle
    startovacích značek — a právě tím se rozdělené snímky složí zpátky.

    Roury se propojují přímo, aby se nikde nedržel celý soubor v paměti:
    záznamy mají stovky MB. Chybové výstupy jdou do souborů, protože
    roura s chybami by se při delším běhu mohla zaplnit a obě fáze by
    se o sebe zasekly.

    `-r` na vstupu druhé fáze: holý Annex-B žádné časování nenese,
    takže by ffmpeg jinak dosadil svých 25/1. Frekvence je z hlavičky
    kontejneru, tedy od kamery. Výsledek je konstantní; jestli sedí,
    ověří kontrola délky proti názvu souboru.
    """
    with tempfile.TemporaryDirectory() as tmp:
        err1 = Path(tmp) / "faze1.err"
        err2 = Path(tmp) / "faze2.err"
        try:
            with err1.open("wb") as e1, err2.open("wb") as e2:
                faze1 = subprocess.Popen(
                    ["ffmpeg", "-hide_banner", "-loglevel", "error",
                     "-i", str(src), "-map", "0:v:0", "-c", "copy",
                     "-f", surovy, "-"],
                    stdout=subprocess.PIPE, stderr=e1,
                )
                try:
                    faze2 = subprocess.Popen(
                        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
                         "-r", frekvence, "-f", surovy, "-i", "pipe:0",
                         "-c", "copy", "-an", *tag,
                         "-movflags", "+faststart", str(dst)],
                        stdin=faze1.stdout, stderr=e2,
                    )
                finally:
                    # Rouru musí zavřít i tenhle proces, jinak by první
                    # fáze nikdy nedostala signál, že druhá skončila.
                    faze1.stdout.close()

                kod2 = faze2.wait(timeout=1800)
                kod1 = faze1.wait(timeout=60)
        except (OSError, subprocess.SubprocessError) as exc:
            dst.unlink(missing_ok=True)
            return f"nepodařilo se spustit: {exc}"

        if kod1 != 0 or kod2 != 0:
            dst.unlink(missing_ok=True)
            hlaska = (err1.read_bytes() + b" | " + err2.read_bytes())
            return hlaska.decode("utf-8", "replace").strip()[:300]

    if not dst.exists() or dst.stat().st_size == 0:
        dst.unlink(missing_ok=True)
        return "výsledek je prázdný"

    return None


def zkontroluj_vysledek(
    src: Path,
    dst: Path,
    vstup: list[str],
    ocekavana_delka: float | None,
) -> None:
    """
    Řekne, JAK se soubor přebalil a jestli výsledek dává smysl.

    ═══ Proč na tom záleží ════════════════════════════════════════
    Vnucený vstupní formát je poslední záchrana, ne rovnocenná cesta.
    `.dav` je kontejner (DHAV); když ho ffmpeg rozpozná, dostane obraz
    i ČASOVÁNÍ. Když se musí vnutit `-f hevc`, čte se soubor jako holý
    Annex-B — rámování kontejneru se pak bere jako obrazová data
    a časové značky nejsou vůbec.

    Takový remux SKONČÍ ÚSPĚŠNĚ. Výsledkem je MP4, které se tváří
    platně, ale dekodér z něj skládá nesmysl. Přesně tak vypadá
    „rozpadlý obraz“ a `-12909` — a bez tohohle řádku v logu se to
    nedá odlišit od vady kodeku.

    Nezastavuje se to: soubor se odesílá dál, protože i vadný záznam
    je pořád záznam. Jen se o tom ví.
    """
    if vstup:
        log.warning(
            "Remux musel VNUTIT formát %s: %s. Kontejner se nerozpoznal, "
            "takže se čte jako holý stream — bez časování a s rizikem, "
            "že se rámování kontejneru vezme jako obraz. Tohle je "
            "podezřelý soubor.", vstup[-1], src.name,
        )
    else:
        log.debug("Remux: kontejner rozpoznán sám, %s", src.name)

    delka = probe_duration(dst)
    if delka is None or delka <= 0:
        log.warning(
            "Přebalený soubor nemá použitelnou délku (%s): %s. Bez "
            "časových značek si prohlížeč neporadí se skládáním obrazu.",
            delka, dst.name,
        )
        return

    if ocekavana_delka and ocekavana_delka > 0:
        odchylka = abs(delka - ocekavana_delka)
        # Vteřina sem nebo tam je normální; násobek ne.
        if odchylka > max(2.0, ocekavana_delka * 0.25):
            log.warning(
                "Délka přebaleného souboru nesedí: %.1f s proti %.1f s "
                "podle názvu (%s). Ukazuje to na rozbité časování.",
                delka, ocekavana_delka, dst.name,
            )


# ── Zpracování ───────────────────────────────────────────────────


class Stability:
    """Soubor se bere za dokončený, až když se přestane měnit."""

    def __init__(self) -> None:
        self._sizes: dict[Path, tuple[int, int]] = {}

    def stable(self, path: Path) -> bool:
        try:
            size = path.stat().st_size
        except OSError:
            return False
        last, count = self._sizes.get(path, (-1, 0))
        count = count + 1 if size == last else 0
        self._sizes[path] = (size, count)
        return count >= STABLE_CHECKS and size > 0

    def forget(self, path: Path) -> None:
        self._sizes.pop(path, None)


def handle(path: Path) -> None:
    """Jeden .dav soubor: ohlásit, nahrát, potvrdit, uklidit."""
    rel = path.relative_to(INBOX_DIR)
    sd_file_path = str(rel)

    meta = parse_dahua_path(rel)

    with tempfile.TemporaryDirectory() as tmp:
        mp4 = Path(tmp) / "out.mp4"
        # Délka podle názvu souboru: kamera ji do něj píše jako rozsah
        # HH.MM.SS-HH.MM.SS, takže je to nezávislý údaj proti tomu, co
        # vyjde z přebalení.
        ocekavana = (
            (meta["ended_at"] - meta["started_at"]).total_seconds()
            if meta.get("ended_at")
            else None
        )
        remux_to_mp4(path, mp4, ocekavana)
        velikost = mp4.stat().st_size
        log.info("Remux OK: %s (%.1f MB)", sd_file_path, velikost / 1_048_576)

        odpoved = announce({
            "camera_serial": meta["device_id"],
            "sd_file_path": sd_file_path,
            "started_at": meta["started_at"].isoformat().replace("+00:00", "Z"),
            "ended_at": meta["ended_at"].isoformat().replace("+00:00", "Z"),
            "event_type": meta["event_type"],
            "media_type": "video/mp4",
        })

        recording_id = odpoved.get("recording_id")
        upload_url = odpoved.get("upload_url")

        if not recording_id:
            raise RuntimeError(f"portál nevrátil recording_id: {odpoved}")

        if not upload_url:
            # Soubor už v portálu je (opakované ohlášení hotového
            # záznamu). Není co nahrávat, jen uklidit lokál.
            log.info("Záznam už portál má, mažu lokál: %s", sd_file_path)
        else:
            upload(upload_url, mp4)
            confirm(recording_id)
            log.info("Hotovo: %s → %s", sd_file_path, recording_id)

    path.unlink(missing_ok=True)
    remove_sidecar(path)


def remove_sidecar(dav_path: Path) -> None:
    """Smaže .idx patřící k danému .dav (Dahua ho posílá ke každému videu)."""
    idx = dav_path.with_suffix(".idx")
    try:
        idx.unlink(missing_ok=True)
    except OSError as exc:
        log.warning("Nepodařilo se smazat %s: %s", idx, exc)


def sweep_orphan_idx(now: float) -> None:
    """
    Uklidí .idx, ke kterým video nedorazilo.

    Ne hned: pořadí uploadu není zaručené a .idx může přijít první.
    """
    for idx in INBOX_DIR.rglob("*.idx"):
        if idx.with_suffix(".dav").exists():
            continue
        try:
            if now - idx.stat().st_mtime > ORPHAN_IDX_TTL_SEC:
                idx.unlink(missing_ok=True)
                log.info("Uklizen osiřelý index: %s", idx.relative_to(INBOX_DIR))
        except OSError:
            continue


def quarantine(path: Path) -> None:
    """
    Odsune soubor stranou, ať neblokuje frontu.

    Nemaže se: soubor, který se nepodařilo zpracovat, je pořád záznam
    z kamery a někdo se na něj má podívat.
    """
    try:
        cil = FAILED_DIR / path.relative_to(INBOX_DIR)
        cil.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(path), str(cil))
        idx = path.with_suffix(".idx")
        if idx.exists():
            shutil.move(str(idx), str(cil.with_suffix(".idx")))
        log.error("Odsunuto do failed: %s", cil)
    except OSError as exc:
        log.error("Odsunutí selhalo (%s): %s", path, exc)


def main() -> int:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
        stream=sys.stdout,
    )

    if not portal.PORTAL_URL or not portal.RELAY_SECRET:
        log.error("Chybí PORTAL_URL nebo RELAY_SECRET — watcher se nespustí.")
        return 1

    FAILED_DIR.mkdir(parents=True, exist_ok=True)
    log.info("Sky Guard watcher: %s → %s", INBOX_DIR, portal.PORTAL_URL)

    stability = Stability()
    pokusy: dict[str, int] = {}

    while True:
        zpracovano = 0
        chyby = 0

        for path in sorted(INBOX_DIR.rglob("*.dav")):
            if not path.is_file():
                continue
            if not stability.stable(path):
                continue

            klic = str(path)
            try:
                handle(path)
                stability.forget(path)
                pokusy.pop(klic, None)
                zpracovano += 1
            except ParseError as exc:
                # Nečitelná cesta se opakováním nespraví.
                log.error("Nečitelná cesta: %s", exc)
                stability.forget(path)
                pokusy.pop(klic, None)
                quarantine(path)
                chyby += 1
            except PortalError as exc:
                chyby += 1
                if exc.permanent:
                    log.error("Portál požadavek odmítl (%s): %s", exc.status, exc.body)
                    stability.forget(path)
                    pokusy.pop(klic, None)
                    quarantine(path)
                elif exc.status == 507:
                    # Lokalita vyčerpala strop na objem záznamů. Není to
                    # vada souboru ani výpadek — portál schválně přestal
                    # přijímat, aby v Hetzneru nerostla faktura. Soubor
                    # zůstane ležet v inboxu; jakmile retence uvolní
                    # místo, příští průchod ho vezme.
                    #
                    # Hlásí se jako VAROVÁNÍ a vlastní větou: „portál
                    # nejde“ by poslalo technika hledat výpadek, který
                    # není.
                    log.warning(
                        "STROP ÚLOŽIŠTĚ vyčerpán — záznamy se nepřijímají. "
                        "Soubor zůstává v inboxu: %s", path,
                    )
                    break
                else:
                    # Nedostupný portál není vada souboru. Necháme ho
                    # ležet a zkusíme to příště — fronta se tím nezasekne,
                    # protože se stejně nedá dělat nic jiného.
                    log.warning("Portál teď nejde (%s): %s", exc.status, exc)
                    break
            except Exception as exc:  # noqa: BLE001
                chyby += 1
                pokusy[klic] = pokusy.get(klic, 0) + 1
                log.error("Zpracování selhalo (%d/%d): %s — %s",
                          pokusy[klic], MAX_ATTEMPTS, path, exc)
                if pokusy[klic] >= MAX_ATTEMPTS:
                    stability.forget(path)
                    pokusy.pop(klic, None)
                    quarantine(path)

        sweep_orphan_idx(time.time())

        if zpracovano or chyby:
            log.info("Průchod: zpracováno %d, chyb %d", zpracovano, chyby)

        # Ping po KAŽDÉM průchodu, i prázdném: hlídač venku hlídá ticho,
        # tedy že watcher žije, ne že zrovna něco přišlo.
        ping_healthcheck(chyby == 0)

        if ONCE:
            return 0 if chyby == 0 else 1
        time.sleep(SCAN_INTERVAL)


if __name__ == "__main__":
    sys.exit(main())
