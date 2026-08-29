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

# Čtyřznakový kód, který se u HEVC vynutí. Prázdné = nevynucovat nic,
# tedy `hev1` s parametry u každého vzorku.
#
# `hvc1` vrátí chování pro Safari a iOS, ale za cenu desktopu — viz
# remux_to_mp4(). Je to proměnná schválně: která strana té výměny
# zrovna bolí víc, se pozná v provozu, ne při psaní.
HEVC_TAG = os.environ.get("HEVC_TAG", "").strip()

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

    ═══ HEVC zůstává kvůli STARÝM souborům ════════════════════════
    Kamery na něj už nenahrávají, ale relay může dostat záznam z SD
    karty pořízený dřív, a ten se musí přebalit stejně jako dřív.
    Výchozí je nevynucovat nic (`hev1`, parametry u každého vzorku);
    `HEVC_TAG=hvc1` vrátí chování pro Safari.
    """
    kodek = (codec or "").lower()

    if kodek in {"h264", "avc1"}:
        return ["-tag:v", "avc1"]

    if kodek in {"hevc", "h265"}:
        return ["-tag:v", HEVC_TAG] if HEVC_TAG else []

    # Neznámý nebo nepřečtený kodek: ffmpeg si vybere sám. Vnutit tag
    # naslepo by remux shodilo u něčeho, co jsme nečekali.
    return []


def remux_to_mp4(src: Path, dst: Path) -> None:
    """
    .dav → .mp4 bez překódování.

    `-c copy`: obraz se nepřepočítává, jen se přebalí.

    ═══ Kamery nahrávají H.264 ════════════════════════════════════
    A to je celé řešení toho, co následuje: H.264 přehraje každý
    prohlížeč, kód `avc1` je jeho obvyklý a parametry streamu zůstávají
    i ve vzorcích. Žádná výměna mezi platformami se neřeší.

    HEVC větev zůstává kvůli starým souborům z SD karet.

    ═══ Proč se u HEVC `hvc1` NEVYNUCUJE ══════════════════════════
    Vynucovalo se, protože `hev1` neumí přehrát Safari ani iOS. Jenže
    `-tag:v hvc1` není přejmenování čtyřznakového kódu: ffmpeg při něm
    parametry streamu (VPS/SPS/PPS) ze VZORKŮ VYHODÍ a nechá je jen
    v hlavičce `hvcC`. Když kamera parametry za běhu mění, ty změny se
    tím ztratí — Chrome si postaví dekodér jednou z `hvcC`, narazí na
    vzorek kódovaný jinak a spadne:

        MediaError code 3, PIPELINE_ERROR_DECODE
        VTDecompressionOutputCallback (-12909)

    Bez toho tagu zůstanou parametry u každého vzorku a stream se
    popisuje sám.

    ═══ U HEVC se vybrat nedá ═════════════════════════════════════
    `hev1` odmítá Safari a iOS, `hvc1` láme Chrome. Obojím se jedna
    strana ztratí, a proto se kamery přepnuly na H.264 — tady se to
    řešit nedá. `HEVC_TAG=hvc1` je jen páka pro starý materiál, kde
    záleží víc na iPhonu.

    Relay NIKDY nepřekódovává. Devět kamer nepřetržitě by z VPS udělalo
    překódovací farmu a obraz by se tím i zhoršil; co kamera natočí, to
    klient vidí.

    `+faststart` dá moov dopředu, aby šlo přehrávat od začátku stahování.
    """
    tag = tag_args(probe_video_codec(src))

    # .dav bývá holý Annex-B stream. Když ho ffmpeg neuhodne, zkusí se
    # vnutit formát podle kodeku.
    pokusy = [[], ["-f", "h264"], ["-f", "hevc"]]
    posledni = ""
    for vstup in pokusy:
        cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
               *vstup, "-i", str(src), "-c", "copy", *tag,
               "-movflags", "+faststart", str(dst)]
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=600, check=False)
        if proc.returncode == 0 and dst.exists() and dst.stat().st_size > 0:
            return
        posledni = (proc.stderr or "").strip()[:300]
        dst.unlink(missing_ok=True)

    raise RuntimeError(f"remux selhal: {posledni}")


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
        remux_to_mp4(path, mp4)
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
