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

Kdyby měl klíč k úložišti, byl by to klíč ke VŠEM bucketům všech
klientů — Supabase S3 klíč se na jeden bucket omezit nedá. Takhle je
na serveru jen tajemství, kterým jde založit záznam u kamery, která
tam už je.

═══ Bez závislostí ════════════════════════════════════════════════
Jen standardní knihovna a ffmpeg. Žádné psycopg, žádné boto3, žádné
requests — čím míň se na cizím serveru instaluje, tím míň se ho dá
napadnout skrz závislost.
"""

from __future__ import annotations

import hashlib
import hmac
import json
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

PORTAL_URL = os.environ.get("PORTAL_URL", "").rstrip("/")
RELAY_SECRET = os.environ.get("RELAY_SECRET", "")
HTTP_TIMEOUT = float(os.environ.get("HTTP_TIMEOUT_SEC", "30"))
UPLOAD_TIMEOUT = float(os.environ.get("UPLOAD_TIMEOUT_SEC", "600"))

# Ping po každém průchodu. Prázdné = nehlídá se zvenčí.
HEALTHCHECK_URL = os.environ.get("HEALTHCHECK_URL", "").strip()

# Osiřelý .idx (video nedorazilo) se uklidí až po téhle době — pořadí
# uploadu není zaručené.
ORPHAN_IDX_TTL_SEC = int(os.environ.get("ORPHAN_IDX_TTL_SEC", "600"))

ONCE = os.environ.get("WATCHER_ONCE", "0") == "1"

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


class PortalError(RuntimeError):
    """Portál odpověděl chybou. Nese stav, ať se pozná dočasné od trvalého."""

    def __init__(self, message: str, status: int | None = None, body: str = ""):
        super().__init__(message)
        self.status = status
        self.body = body

    @property
    def permanent(self) -> bool:
        """4xx kromě 429 opakováním nespraví — je to vada požadavku."""
        if self.status is None:
            return False
        if self.status == 429:
            return False
        return 400 <= self.status < 500


def _signed_request(path: str, payload: dict) -> dict:
    """
    POST na portál, podepsaný RELAY_SECRET.

    Podepisuje se `${timestamp}.${tělo}` — svázání času s tělem, aby se
    odchycený požadavek nedal přehrát s čerstvou hlavičkou. Tělo se
    serializuje JEDNOU a použije dvakrát: podepisují se bajty, ne objekt.
    """
    if not PORTAL_URL:
        raise PortalError("PORTAL_URL není nastavená")
    if not RELAY_SECRET:
        raise PortalError("RELAY_SECRET není nastavený")

    body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    timestamp = str(int(time.time()))
    signature = hmac.new(
        RELAY_SECRET.encode("utf-8"),
        f"{timestamp}.".encode("utf-8") + body,
        hashlib.sha256,
    ).hexdigest()

    request = urllib.request.Request(
        f"{PORTAL_URL}{path}",
        data=body,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "X-Timestamp": timestamp,
            "X-Signature": signature,
        },
    )

    try:
        with urllib.request.urlopen(request, timeout=HTTP_TIMEOUT) as response:
            text = response.read().decode("utf-8", "replace")
            return json.loads(text) if text else {}
    except urllib.error.HTTPError as exc:
        text = exc.read().decode("utf-8", "replace")[:500]
        raise PortalError(f"portál odpověděl {exc.code}", exc.code, text) from exc
    except urllib.error.URLError as exc:
        raise PortalError(f"portál nedostupný: {exc.reason}") from exc


def announce(payload: dict) -> dict:
    return _signed_request("/api/ingest/recording", payload)


def confirm(recording_id: str) -> dict:
    return _signed_request(
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
    """
    Ohlásí průchod hlídači. Nikdy nevyhazuje.

    Je to smyčka, ne cron, takže ping patří na konec průchodu — ne do
    crontabu, který tu žádný není.
    """
    if not HEALTHCHECK_URL:
        return
    url = HEALTHCHECK_URL if ok else f"{HEALTHCHECK_URL.rstrip('/')}/fail"
    try:
        with urllib.request.urlopen(url, timeout=10) as response:
            response.read()
    except Exception as exc:  # noqa: BLE001
        log.warning("Ping hlídači selhal: %s", exc)


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


def remux_to_mp4(src: Path, dst: Path) -> None:
    """
    .dav → .mp4 bez překódování.

    `-c copy`: obraz se nepřepočítává, jen se přebalí. U HEVC se vynutí
    tag `hvc1` — ffmpeg jinak zapíše `hev1` a Safari ani iOS takové
    video nepřehrají. Na desktopu přitom běží, takže to vypadá jako
    chyba přehrávače, ne souboru.

    `+faststart` dá moov dopředu, aby šlo přehrávat od začátku stahování.
    """
    codec = (probe_video_codec(src) or "").lower()
    tag = ["-tag:v", "hvc1"] if codec in {"hevc", "h265"} else []

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

    if not PORTAL_URL or not RELAY_SECRET:
        log.error("Chybí PORTAL_URL nebo RELAY_SECRET — watcher se nespustí.")
        return 1

    FAILED_DIR.mkdir(parents=True, exist_ok=True)
    log.info("Sky Guard watcher: %s → %s", INBOX_DIR, PORTAL_URL)

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
