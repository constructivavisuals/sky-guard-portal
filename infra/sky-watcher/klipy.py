#!/usr/bin/env python3
"""
Sky Guard — klipy kolem detekcí.

═══ Co to dělá ═════════════════════════════════════════════════════
Průběžný archiv je na SD kartě v kameře a přepisuje se dokola. To je
záměr: klient se podívá týden zpátky přímo z karty (viz playback.py).
Do Hetzneru se ukládá jen JEDNA věc — krátký klip kolem každé detekce
člověka, jako důkaz, který přežije i krádež kamery.

Tahle služba tedy dělá to jediné, co musí opustit stavbu:

  1. `events.py` po odeslané detekci položí do fronty úkol.
  2. Tahle služba počká, až kamera stihne úsek dopsat na kartu.
  3. Vytáhne ho Z KARTY přes playback (tedy i to, co bylo PŘED
     detekcí) a ohlásí ho portálu jako záznam.

═══ Proč z karty, a ne ze živého obrazu ════════════════════════════
Kvůli tomu, co bylo PŘED detekcí. Ze živého obrazu jde nahrát jen to,
co teprve přijde — a to zajímavé se typicky stane pár vteřin předtím,
než kamera člověka pozná. Zachytit to ze živého proudu by znamenalo
držet trvalé spojení na každou kameru a pořád do kruhu nahrávat, což
je přesně ten trvalý tok dat, kterého se tahle architektura zbavuje.

Karta ten úsek už má. Stačí si o něj říct.

Cena je zpoždění: klip je k dispozici až asi minutu po události.
Detekce sama letí do portálu hned, tou to nebrzdí — proto jsou to dvě
služby a ne jedna.

═══ Když playback nefunguje ════════════════════════════════════════
Adresa playbacku není ověřená na skutečné kameře (viz playback.py).
Kdyby nefungovala, je tu záchrana: klip se nahraje ze ŽIVÉHO proudu
dopředu. Přijde se tím o to, co bylo před detekcí, ale důkaz že někdo
na stavbě byl, zůstane. Hlásí se to nahlas — je to zhoršený stav, ne
rovnocenná cesta.
"""

from __future__ import annotations

import json
import logging
import os
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import live
import playback
import portal
import watcher
from portal import PortalError

# ── Konfigurace ──────────────────────────────────────────────────

FRONTA_DIR = Path(os.environ.get("KLIPY_FRONTA_DIR", "/fronta"))
FAILED_DIR = Path(os.environ.get("KLIPY_FAILED_DIR", "/failed-klipy"))
SCAN_INTERVAL = float(os.environ.get("KLIPY_SCAN_SEC", "5"))

# Kolik vteřin před a po detekci. Před: to podstatné se stane dřív,
# než kamera člověka rozpozná. Po: aby bylo vidět, kam šel.
PRE_SEC = int(os.environ.get("KLIPY_PRE_SEC", "15"))
POST_SEC = int(os.environ.get("KLIPY_POST_SEC", "45"))

# Jak dlouho po konci úseku se čeká, než se o něj kamera požádá.
# Karta má vyrovnávací paměť a úsek na ní ještě chvíli není celý.
DOPSANI_SEC = int(os.environ.get("KLIPY_DOPSANI_SEC", "20"))

MAX_POKUSU = int(os.environ.get("KLIPY_MAX_POKUSU", "5"))
STAHOVANI_TIMEOUT = float(os.environ.get("KLIPY_TIMEOUT_SEC", "600"))

# Záchrana ze živého obrazu, když playback nedá nic.
ZIVA_ZACHRANA = os.environ.get("KLIPY_ZIVA_ZACHRANA", "1") == "1"

ONCE = os.environ.get("KLIPY_ONCE", "0") == "1"

log = logging.getLogger("sky-klipy")


# ── Fronta ───────────────────────────────────────────────────────
#
# Adresář se soubory JSON, ne databáze ani broker. Ze stejného důvodu
# jako všude jinde v tomhle relayi: co se neinstaluje, to se nedá
# napadnout skrz závislost. A hlavně — úkol, který se nestihne
# zpracovat před restartem, zůstane ležet na disku.


def fronta_je_zapisovatelna(dir_fronty: Path) -> str | None:
    """
    Ověří, že se do fronty dá zapsat. Vrací důvod, nebo None.

    ═══ Proč to stojí za kontrolu při startu ══════════════════════
    Protože selhání zápisu je jinak vidět až na patnácté detekci —
    a i tam jen jako varování mezi ostatními řádky. Služba běží,
    detekce chodí, klipy nevznikají a nic nekřičí.

    Nejčastější příčina: svazek vyrobil Docker na hostiteli jako
    `root`, ale kontejner běží pod `watcher`. Proto se to zkouší
    zápisem, ne kontrolou existence — ta by prošla.
    """
    try:
        dir_fronty.mkdir(parents=True, exist_ok=True)
        zkouska = dir_fronty / ".zapis-test"
        zkouska.write_text("", encoding="utf-8")
        zkouska.unlink()
    except OSError as exc:
        return str(exc)
    return None


def zapis_ukol(dir_fronty: Path, serial: str, kdy: datetime, kod: str) -> Path:
    """
    Položí úkol do fronty. Volá se z events.py.

    Jméno souboru nese čas i kód, takže je stejná detekce vždycky týž
    soubor — dvojí zápis se přepíše místo aby vyrobil druhý klip.
    """
    dir_fronty.mkdir(parents=True, exist_ok=True)
    razitko = int(kdy.timestamp())
    bezpecny_kod = "".join(z for z in kod if z.isalnum())[:32] or "detekce"
    cil = dir_fronty / f"{serial}-{razitko}-{bezpecny_kod}.json"

    # Zápis přes dočasný soubor a přejmenování: služba čte tentýž
    # adresář a nesmí sáhnout na rozepsaný úkol.
    docasny = cil.with_suffix(".rozepsany")
    docasny.write_text(json.dumps({
        "camera_serial": serial,
        "detected_at": kdy.astimezone(timezone.utc)
        .isoformat(timespec="seconds").replace("+00:00", "Z"),
        "code": kod,
    }), encoding="utf-8")
    docasny.rename(cil)
    return cil


def nacti_ukol(cesta: Path) -> dict | None:
    try:
        data = json.loads(cesta.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        log.warning("Úkol %s se nedá přečíst (%s) — jde stranou", cesta.name, exc)
        return None
    if not data.get("camera_serial") or not data.get("detected_at"):
        log.warning("Úkol %s je neúplný — jde stranou", cesta.name)
        return None
    return data


# ── Stažení klipu ────────────────────────────────────────────────


def stahni(zdroj: str, cil: Path, delka: int) -> str | None:
    """
    Vytáhne úsek do MP4. Vrací None při úspěchu, jinak popis chyby.

    `-c copy`: relay nikdy nepřekódovává, tady stejně jako jinde.
    `-an`: kamera posílá pcm_alaw, který se do MP4 zabalit nedá a bez
    tohohle by celý převod spadl — viz remux ve watcher.py.
    """
    cmd = [
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
        "-rtsp_transport", "tcp",
        "-i", zdroj,
        "-t", str(delka),
        "-map", "0:v:0", "-c", "copy", "-an", "-tag:v", "avc1",
        "-movflags", "+faststart",
        str(cil),
    ]
    try:
        proc = subprocess.run(
            cmd, capture_output=True, text=True,
            timeout=STAHOVANI_TIMEOUT, check=False,
        )
    except subprocess.TimeoutExpired:
        cil.unlink(missing_ok=True)
        return "vypršel čas"
    except (OSError, subprocess.SubprocessError) as exc:
        cil.unlink(missing_ok=True)
        return f"ffmpeg se nepodařilo spustit: {exc}"

    if proc.returncode != 0 or not cil.exists() or cil.stat().st_size == 0:
        cil.unlink(missing_ok=True)
        return (proc.stderr or "").strip()[:300] or "prázdný výsledek"
    return None


def zdroje_klipu(lan_ip: str, od: datetime, delka: int) -> list[tuple[str, str]]:
    """
    Odkud zkusit klip vzít, v pořadí. Dvojice (popis, adresa).

    Playback je hlavní cesta, protože jako jediná umí to, co bylo
    před detekcí. Živý obraz je záchrana — viz hlavička.
    """
    cesty = [("karta", playback.playback_url(lan_ip, int(od.timestamp()), delka))]
    if ZIVA_ZACHRANA:
        # VEDLEJŠÍ proud, ne hlavní. Změřeno: 4K se přes tunel rozpadá
        # živě i z karty, vedlejší je čistý. Záchrana, která vyrobí
        # rozsypaný klip, by byla horší než žádná.
        cesty.append(("živý obraz", live.rtsp_url(lan_ip, live.RTSP_SUB_DEFAULT)))
    return cesty


# ── Zpracování ───────────────────────────────────────────────────


def zpracuj(cesta: Path) -> bool:
    """Jeden úkol. Vrací True, když je hotovo (nebo se nedá opakovat)."""
    ukol = nacti_ukol(cesta)
    if ukol is None:
        odsun(cesta)
        return True

    serial = ukol["camera_serial"]
    kdy = datetime.fromisoformat(ukol["detected_at"].replace("Z", "+00:00"))
    od = kdy - timedelta(seconds=PRE_SEC)
    do = kdy + timedelta(seconds=POST_SEC)
    delka = PRE_SEC + POST_SEC

    # Kamera musí úsek nejdřív dopsat na kartu.
    hotovo_v = do.timestamp() + DOPSANI_SEC
    if time.time() < hotovo_v:
        return False

    kamera = playback.KAMERY.najdi(serial)
    if not kamera or not kamera.get("lan_ip"):
        log.warning("Kamera %s není v portálu — úkol jde stranou", serial)
        odsun(cesta)
        return True

    with tempfile.TemporaryDirectory() as tmp:
        mp4 = Path(tmp) / "klip.mp4"
        posledni = ""
        for popis, zdroj in zdroje_klipu(kamera["lan_ip"], od, delka):
            chyba = stahni(zdroj, mp4, delka)
            if chyba is None:
                if popis != "karta":
                    log.warning(
                        "Klip pro %s se vzal ze ŽIVÉHO obrazu, ne z karty: "
                        "chybí v něm %d s před detekcí. Playback z karty "
                        "nefungoval (%s) — viz README.",
                        serial, PRE_SEC, posledni,
                    )
                break
            posledni = chyba
            log.info("Klip z %s (%s) nevyšel: %s", serial, popis, chyba)
        else:
            return dalsi_pokus(cesta, posledni)

        try:
            odeslat(kamera, serial, od, do, mp4)
        except PortalError as exc:
            if exc.status == 507:
                # Strop úložiště NENÍ vada klipu. Nechat ležet a počkat,
                # až se místo uvolní — stejně jako to dělá watcher.
                log.error("STROP ÚLOŽIŠTĚ — klip z %s počká: %s", serial, exc)
                return False
            if exc.status and 400 <= exc.status < 500 and exc.status != 429:
                log.warning("Portál klip z %s odmítl (%s): %s",
                            serial, exc.status, exc.body[:200])
                odsun(cesta)
                return True
            return dalsi_pokus(cesta, str(exc))

    cesta.unlink(missing_ok=True)
    log.info("Klip z %s odeslán (%s → %s)", serial,
             od.isoformat(timespec="seconds"), do.isoformat(timespec="seconds"))
    return True


def odeslat(kamera: dict, serial: str, od: datetime, do: datetime,
            mp4: Path) -> None:
    """Ohlásit, nahrát, potvrdit — týmž postupem jako watcher."""
    # Klíč idempotence. Musí být stabilní: opakovaný pokus o tentýž
    # klip má narazit na týž řádek, ne založit druhý.
    sd_file_path = f"{serial}/klipy/{int(od.timestamp())}.mp4"

    odpoved = watcher.announce({
        "camera_serial": serial,
        "sd_file_path": sd_file_path,
        "started_at": od.isoformat(timespec="seconds").replace("+00:00", "Z"),
        "ended_at": do.isoformat(timespec="seconds").replace("+00:00", "Z"),
        # `intelligent` = Analytika. Kamera to poznala vlastní chytrou
        # detekcí, ne obyčejným pohybem.
        "event_type": "intelligent",
        "media_type": "video/mp4",
    })

    recording_id = odpoved.get("recording_id")
    upload_url = odpoved.get("upload_url")
    if not recording_id:
        raise PortalError(f"portál nevrátil recording_id: {odpoved}")
    if not upload_url:
        # Záznam už je hotový z dřívějška — nahrávat není co.
        return
    watcher.upload(upload_url, mp4)
    watcher.confirm(recording_id)


def dalsi_pokus(cesta: Path, duvod: str) -> bool:
    """Počítadlo pokusů v názvu souboru. Po stropu jde úkol stranou."""
    jmeno = cesta.stem
    pokus = 0
    if ".pokus" in jmeno:
        jmeno, _, cislo = jmeno.rpartition(".pokus")
        pokus = int(cislo) if cislo.isdigit() else 0

    pokus += 1
    if pokus >= MAX_POKUSU:
        log.warning("Klip %s se nepodařilo pořídit ani na %d. pokus (%s)",
                    jmeno, pokus, duvod)
        odsun(cesta)
        return True

    novy = cesta.with_name(f"{jmeno}.pokus{pokus}.json")
    cesta.rename(novy)
    log.info("Klip %s se zkusí znovu (%d. pokus): %s", jmeno, pokus, duvod)
    return False


def odsun(cesta: Path) -> None:
    """Nezpracovatelný úkol do karantény, ať necykluje frontu donekonečna."""
    FAILED_DIR.mkdir(parents=True, exist_ok=True)
    try:
        cesta.rename(FAILED_DIR / cesta.name)
    except OSError as exc:
        log.warning("Úkol %s se nepodařilo odsunout: %s", cesta.name, exc)
        cesta.unlink(missing_ok=True)


def prubeh() -> None:
    if not FRONTA_DIR.is_dir():
        return
    for cesta in sorted(FRONTA_DIR.glob("*.json")):
        try:
            zpracuj(cesta)
        except Exception as exc:  # noqa: BLE001
            log.error("Úkol %s spadl: %s", cesta.name, exc)
            dalsi_pokus(cesta, str(exc))


def main() -> int:
    logging.basicConfig(
        level=os.environ.get("LOG_LEVEL", "INFO"),
        format="%(asctime)s %(levelname)s %(message)s",
        stream=sys.stdout,
    )
    if not portal.PORTAL_URL or not portal.RELAY_SECRET:
        log.error("PORTAL_URL nebo RELAY_SECRET není nastavené.")
        return 2

    # Táž kontrola jako v events.py, jen z druhé strany: tahle služba
    # z fronty čte a do karantény zapisuje. Prázdná fronta vypadá
    # stejně jako nezapisovatelná, tak ať se to dá rozlišit.
    duvod = fronta_je_zapisovatelna(FRONTA_DIR)
    if duvod:
        log.error(
            "Na frontu (%s) se nedá sáhnout: %s. Bez toho se žádný klip "
            "nezpracuje. Obvykle je to svazek vyrobený Dockerem jako "
            "root — kontejner běží pod uid 10001.", FRONTA_DIR, duvod,
        )

    playback.KAMERY.obnov()
    log.info("Klipy: fronta %s, %d s před a %d s po detekci",
             FRONTA_DIR, PRE_SEC, POST_SEC)

    while True:
        prubeh()
        if ONCE:
            return 0
        time.sleep(SCAN_INTERVAL)


if __name__ == "__main__":
    sys.exit(main())
