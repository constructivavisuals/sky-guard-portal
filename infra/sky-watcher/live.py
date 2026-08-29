#!/usr/bin/env python3
"""
Sky Guard — živý obraz ze stavebních kamer.

═══ Co to dělá ═════════════════════════════════════════════════════
Dvě věci, obojí kolem go2rtc, který sám obraz z kamer bere a servíruje:

  1. SKLÁDÁ MU KONFIGURACI podle seznamu kamer z portálu. Adresa
     kamery se bere odtamtud, heslo z prostředí — portál hesla nezná
     a znát nemá, stejně jako u služby událostí.

  2. OVĚŘUJE LÍSTKY. Prohlížeč se na živý obraz připojuje PŘÍMO sem,
     protože serverless funkce portálu minutové spojení neudrží a video
     by teklo přes Vercel. Relay ale o přihlášených uživatelích nic
     neví, takže o přístupu rozhoduje portál a řekne to podepsaným
     lístkem. Tenhle proces ho ověří.

═══ Proč go2rtc a ne vlastní ═══════════════════════════════════════
Převod RTSP na něco, co umí prohlížeč, je práce s kodeky, ne pár řádků:
kontejnery, přerovnání paketů, prokládané zvuky, znovunavázání po
výpadku kamery. go2rtc to dělá, je to jeden binární soubor bez služeb
kolem a už se s ním v tomhle repu počítá — `/api/relay/cameras` ho
zmiňuje od začátku.

═══ Co tenhle proces NEDĚLÁ ════════════════════════════════════════
Nesahá na video. Neproxuje proud, nepřekóduje, nenahrává. Jen řekne
`ano`/`ne` a poskládá konfigurák. Video jde mimo něj, přímo z go2rtc
přes Caddy.

Bez závislostí, stejně jako zbytek relaye: standardní knihovna.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import logging
import os
import re
import sys
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import portal
from portal import PortalError

# ── Konfigurace ──────────────────────────────────────────────────

CAMERA_USERNAME = os.environ.get("CAMERA_USERNAME", "admin")
CAMERA_PASSWORD = os.environ.get("CAMERA_PASSWORD", "")

# Tajemství, kterým portál podepisuje lístky. VLASTNÍ, ne RELAY_SECRET:
# tímhle se podepisuje směrem K NÁM a relayovým tajemstvím my směrem
# k portálu. Kdyby to bylo jedno, znamenal by únik lístku i možnost
# zakládat záznamy jménem relaye.
LIVE_SECRET = os.environ.get("LIVE_STREAM_SECRET", "")

# Kde poslouchá ověřovací brána. Jen pro Caddy uvnitř sítě kontejnerů;
# ven se nepublikuje.
AUTH_HOST = os.environ.get("LIVE_AUTH_HOST", "0.0.0.0")
AUTH_PORT = int(os.environ.get("LIVE_AUTH_PORT", "8089"))

GO2RTC_CONFIG = Path(os.environ.get("GO2RTC_CONFIG", "/config/go2rtc.yaml"))
GO2RTC_API = os.environ.get("GO2RTC_API", "http://go2rtc:1984").rstrip("/")

CONFIG_REFRESH_SEC = float(os.environ.get("LIVE_CONFIG_REFRESH_SEC", "300"))

# Úniková cesta pro kontrolu původu na websocketu.
#
# Portál běží na jiné doméně než stream, takže go2rtc požadavek jako
# cizí odmítne. Řeší to Caddy přepisem hlavičky Origin (viz Caddyfile)
# a tohle má proto zůstat prázdné. Kdyby ten přepis nestačil, nastaví
# se `GO2RTC_ORIGIN=*` a povolí se to rovnou tady — bez čekání na
# novou verzi.
GO2RTC_ORIGIN = os.environ.get("GO2RTC_ORIGIN", "").strip()

# Standardní cesty Dahua. Kamera je smí přebít sloupcem v portálu;
# tohle je to, co platí, dokud jí nikdo nic nenastavil.
#
# Ověřit se je na místě zatím nepodařilo, takže se dají přenastavit
# z prostředí — doladění nemá vyžadovat nasazení nové verze.
RTSP_MAIN_DEFAULT = os.environ.get(
    "RTSP_MAIN_PATH", "/cam/realmonitor?channel=1&subtype=0"
)
RTSP_SUB_DEFAULT = os.environ.get(
    "RTSP_SUB_PATH", "/cam/realmonitor?channel=1&subtype=1"
)
RTSP_PORT = os.environ.get("RTSP_PORT", "554")

ONCE = os.environ.get("LIVE_ONCE", "0") == "1"

logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)s %(message)s",
    stream=sys.stdout,
)
log = logging.getLogger("live")


# ── Lístek ───────────────────────────────────────────────────────
#
# MUSÍ sedět s src/lib/live/token.ts v portálu. Kdyby se obě strany
# rozešly v tom, co přesně se podepisuje, projevilo by se to jako
# „neplatný lístek“ — tedy stejně jako špatné tajemství, a hledalo by
# se to v prostředí místo v kódu. Porovnává je scripts/hranice-listek.mjs.

PODPIS_RE = re.compile(r"^[0-9a-f]{64}$")


def overit_listek(stream: str, token: str, ted: float | None = None) -> str | None:
    """
    Vrátí důvod odmítnutí, nebo None když je lístek v pořádku.

    Jméno proudu je POVINNÝ vstup, ne něco, co by se četlo z lístku:
    ověřuje se tím, že lístek patří k té kameře, o kterou si volající
    řekl. Bez toho by lístek na vlastní kameru otevřel i cizí stavbu.
    """
    if not LIVE_SECRET:
        return "server_misconfigured"
    if not token:
        return "malformed"

    tecka = token.find(".")
    if tecka <= 0:
        return "malformed"

    vyprsi_raw, podpis = token[:tecka], token[tecka + 1:]
    if not vyprsi_raw.isdigit() or not PODPIS_RE.match(podpis):
        return "malformed"

    vyprsi = int(vyprsi_raw)
    if vyprsi <= 0:
        return "malformed"

    # Platnost dřív než podpis: propadlý lístek nemá cenu počítat.
    if (ted if ted is not None else time.time()) >= vyprsi:
        return "expired"

    ocekavany = hmac.new(
        LIVE_SECRET.encode("utf-8"),
        f"{stream}.{vyprsi}".encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()

    # Konstantní čas: rozdíl v době odpovědi by dal podpis uhádnout
    # po znacích.
    if not hmac.compare_digest(ocekavany, podpis):
        return "bad_signature"

    return None


# ── Konfigurace go2rtc ───────────────────────────────────────────


def rtsp_url(lan_ip: str, cesta: str) -> str:
    """
    Adresa proudu i s přihlášením.

    Heslo se kóduje: Dahua hesla běžně obsahují `@` a `/`, a nekódované
    by rozsekly adresu na nesmysl, který kamera odmítne jako špatné
    přihlášení. To se pak hledá v kameře místo v kódu.
    """
    uzivatel = urllib.parse.quote(CAMERA_USERNAME, safe="")
    heslo = urllib.parse.quote(CAMERA_PASSWORD, safe="")
    return f"rtsp://{uzivatel}:{heslo}@{lan_ip}:{RTSP_PORT}{cesta}"


def yaml_retezec(hodnota: str) -> str:
    """
    Uvozovkuje hodnotu do YAML.

    Vlastní, protože relay nemá závislosti. Stačí to na to, co sem
    chodí: adresy s heslem, kde jsou `@`, `?`, `&` a `:`.
    """
    return '"' + hodnota.replace("\\", "\\\\").replace('"', '\\"') + '"'


def slozit_config(kamery: list[dict]) -> str:
    """
    Konfigurák pro go2rtc.

    Jeden proud na kameru, hlavní i vedlejší. Vedlejší je tam schválně:
    stavební kamera má hlavní proud v rozlišení, které na mobilu přes
    LTE nemá šanci, a přepnout se musí být na co.

    go2rtc si proudy otevírá až na vyžádání, takže devět kamer
    v konfiguráku neznamená devět běžících spojení — nečinný proud se
    po chvíli sám zavře.
    """
    radky = [
        "# Generuje live.py podle /api/relay/cameras. Ručně needitovat —",
        "# při další obnově se to přepíše.",
        "",
        "api:",
        # Jen pro Caddy a pro live.py uvnitř sítě kontejnerů. Ven se
        # port nepublikuje: administrace go2rtc umí přidat proud
        # z libovolné adresy a to nesmí být vidět zvenčí.
        "  listen: :1984",
        *([f"  origin: {yaml_retezec(GO2RTC_ORIGIN)}"] if GO2RTC_ORIGIN else []),
        "",
        "rtsp:",
        # Server RTSP nepotřebujeme, obraz jde ven přes prohlížeč.
        '  listen: ""',
        "",
        "webrtc:",
        # WebRTC nepoužíváme — obraz jde přes MSE po websocketu, aby
        # prošel i ze sítě se zavřeným UDP. Otevřený port navíc by byl
        # plocha bez užitku.
        '  listen: ""',
        "",
        "log:",
        f"  level: {os.environ.get('GO2RTC_LOG_LEVEL', 'info')}",
        "",
        "streams:",
    ]

    if not kamery:
        radky.append("  # Portál nevrátil žádnou použitelnou kameru.")

    for kamera in kamery:
        serial = kamera["serial_number"]
        lan_ip = kamera["lan_ip"]
        hlavni = kamera.get("rtsp_main_path") or RTSP_MAIN_DEFAULT
        vedlejsi = kamera.get("rtsp_sub_path") or RTSP_SUB_DEFAULT

        radky.append(f"  # {kamera.get('site_name', '?')} — {kamera.get('name', '?')}")
        radky.append(f"  {serial}:")
        radky.append(f"    - {yaml_retezec(rtsp_url(lan_ip, hlavni))}")
        radky.append(f"  {serial}_sub:")
        radky.append(f"    - {yaml_retezec(rtsp_url(lan_ip, vedlejsi))}")

    return "\n".join(radky) + "\n"


def nacti_kamery() -> list[dict]:
    """Seznam kamer z portálu. Jen ty, které mají čím být adresované."""
    odpoved = portal.signed_get("/api/relay/cameras")
    kamery = [
        k for k in odpoved.get("cameras", [])
        if k.get("serial_number") and k.get("lan_ip")
    ]
    return kamery


def obnovit_config() -> bool:
    """
    Přegeneruje konfigurák. Vrací True, když se změnil.

    Zápis a restart JEN při změně: restart go2rtc shodí divákům obraz
    a dělat to každých pět minut kvůli konfiguráku, který je pořád
    stejný, by z živého obrazu udělalo blikající obraz.
    """
    kamery = nacti_kamery()
    novy = slozit_config(kamery)

    stary = GO2RTC_CONFIG.read_text(encoding="utf-8") if GO2RTC_CONFIG.exists() else ""
    if novy == stary:
        return False

    GO2RTC_CONFIG.parent.mkdir(parents=True, exist_ok=True)
    GO2RTC_CONFIG.write_text(novy, encoding="utf-8")
    log.info("Konfigurace go2rtc přegenerována: %d kamer", len(kamery))
    return True


def restartovat_go2rtc() -> None:
    """Řekne go2rtc, ať si přečte nový konfigurák."""
    import urllib.error
    import urllib.request

    try:
        request = urllib.request.Request(f"{GO2RTC_API}/api/restart", method="POST")
        with urllib.request.urlopen(request, timeout=10) as odpoved:
            odpoved.read()
        log.info("go2rtc restartován kvůli změně konfigurace")
    except (urllib.error.URLError, OSError) as exc:
        # Konfigurák je zapsaný, ale go2rtc pořád jede podle starého —
        # a to je stav, který vypadá jako „změna nezabrala“. Proto
        # ERROR a rovnou i to, co s tím: samotné přepsání souboru nic
        # nezmění, dokud si ho go2rtc nepřečte.
        log.error(
            "Restart go2rtc SELHAL (%s). Konfigurace je zapsaná, ale "
            "neuplatní se — spusť `docker compose restart go2rtc`.", exc,
        )


def smycka_konfigurace() -> None:
    while True:
        try:
            if obnovit_config():
                restartovat_go2rtc()
        except PortalError as exc:
            log.warning("Konfigurace se nenačetla (%s): %s", exc.status, exc)
        except Exception as exc:  # noqa: BLE001
            log.error("Obnova konfigurace selhala: %s", exc)
        if ONCE:
            return
        time.sleep(CONFIG_REFRESH_SEC)


# ── Ověřovací brána ──────────────────────────────────────────────
#
# Caddy se na každý požadavek zeptá sem (forward_auth) a původní adresu
# pošle v X-Forwarded-Uri. Odpověď 200 = pustit, cokoli jiného = ne.


class AuthHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):  # vlastní logování níž
        pass

    def _odpoved(self, status: int, telo: bytes = b"") -> None:
        self.send_response(status)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(telo)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(telo)

    def do_GET(self) -> None:
        if self.path.startswith("/zdravi"):
            self._odpoved(200, b"ok")
            return

        puvodni = self.headers.get("X-Forwarded-Uri", "")
        dotaz = urllib.parse.urlparse(puvodni).query
        parametry = urllib.parse.parse_qs(dotaz)

        stream = (parametry.get("src") or [""])[0]
        token = (parametry.get("token") or [""])[0]

        if not stream:
            log.warning("Živý obraz odmítnut: chybí src")
            self._odpoved(403, b"no_stream")
            return

        duvod = overit_listek(stream, token)
        if duvod:
            # Do logu jméno proudu, NE lístek: v logu nemá co dělat nic,
            # čím by se dalo znovu projít.
            log.warning("Živý obraz odmítnut (%s): %s", duvod, stream)
            self._odpoved(403, duvod.encode("utf-8"))
            return

        log.info("Živý obraz povolen: %s", stream)
        self._odpoved(200, b"ok")

    do_HEAD = do_GET
    do_POST = do_GET


def main() -> int:
    if not portal.PORTAL_URL or not portal.RELAY_SECRET:
        log.error("Chybí PORTAL_URL nebo RELAY_SECRET — živý obraz se nespustí.")
        return 1
    if not LIVE_SECRET:
        # Bez tajemství by brána pouštěla všechno nebo nic; obojí je
        # horší než se nespustit a říct proč.
        log.error("Chybí LIVE_STREAM_SECRET — živý obraz se nespustí.")
        return 1

    # Nastavení se vypisuje při startu schválně. Konfigurace přichází
    # z .env, které se čte při VYTVOŘENÍ kontejneru — samotný restart
    # ji nepřenačte. Bez tohohle řádku se rozdíl mezi „proměnná není
    # nastavená“ a „kontejner ji ještě nezná“ nedá poznat jinak než
    # exekem dovnitř.
    log.info(
        "Sky Guard živý obraz: brána na %s:%d, origin=%s, "
        "hlavní=%s, vedlejší=%s, obnova po %.0f s",
        AUTH_HOST, AUTH_PORT,
        GO2RTC_ORIGIN or "(nenastaveno, řeší Caddy)",
        RTSP_MAIN_DEFAULT, RTSP_SUB_DEFAULT, CONFIG_REFRESH_SEC,
    )

    if ONCE:
        smycka_konfigurace()
        return 0

    threading.Thread(target=smycka_konfigurace, daemon=True).start()

    server = ThreadingHTTPServer((AUTH_HOST, AUTH_PORT), AuthHandler)
    server.serve_forever()
    return 0


if __name__ == "__main__":
    sys.exit(main())
