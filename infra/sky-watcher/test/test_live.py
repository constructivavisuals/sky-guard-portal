#!/usr/bin/env python3
"""
Test živého obrazu proti FALEŠNÉMU portálu.

    python3 infra/sky-watcher/test/test_live.py

Ověřuje dvě věci, na kterých to celé stojí:

  1. KONFIGURACE pro go2rtc — že se z kamer v portálu poskládají proudy
     se správnými adresami a že se heslo do adresy dostane zakódované.
  2. DVEŘNÍK — že brána pustí platný lístek a odmítne všechno ostatní,
     včetně lístku na jinou kameru.

Nepotřebuje síť ven, ffmpeg ani go2rtc.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import sys
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

KOREN = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(KOREN))

SECRET = "relay-tajemstvi"
LIVE_SECRET = "listkove-tajemstvi"
SERIAL = "BK024AAPAGB5592"

os.environ.update({
    "PORTAL_URL": "http://127.0.0.1:0",
    "RELAY_SECRET": SECRET,
    "LIVE_STREAM_SECRET": LIVE_SECRET,
    # Heslo se znaky, které by nekódované rozsekly adresu.
    "CAMERA_PASSWORD": "he@slo/2026",
    "CAMERA_USERNAME": "admin",
})

import importlib  # noqa: E402

import live  # noqa: E402
import portal  # noqa: E402


KAMERY = {
    "cameras": [
        {
            "serial_number": SERIAL,
            "name": "Jeřáb",
            "site_id": "s1",
            "site_name": "Klanečná",
            "lan_ip": "192.168.11.31",
            "rtsp_main_path": None,
            "rtsp_sub_path": None,
        },
        {
            "serial_number": "CAM-VLASTNI",
            "name": "Vjezd",
            "site_id": "s2",
            "site_name": "Mírovka",
            "lan_ip": "192.168.12.14",
            # Kamera s vlastní cestou — musí přebít výchozí.
            "rtsp_main_path": "/vlastni/main",
            "rtsp_sub_path": "/vlastni/sub",
        },
        # Bez adresy: relay ji nemá jak najít, musí vypadnout.
        {"serial_number": "BEZ-IP", "name": "?", "lan_ip": None},
    ],
    "incomplete": 0,
}


class FakePortal(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        podpis = self.headers.get("X-Signature", "")
        ts = self.headers.get("X-Timestamp", "")
        ocekavany = hmac.new(
            SECRET.encode(), f"{ts}.".encode(), hashlib.sha256
        ).hexdigest()
        if not hmac.compare_digest(ocekavany, podpis):
            self.send_response(401)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return

        telo = json.dumps(KAMERY).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(telo)))
        self.end_headers()
        self.wfile.write(telo)


def listek(stream: str, vyprsi: int) -> str:
    podpis = hmac.new(
        LIVE_SECRET.encode(), f"{stream}.{vyprsi}".encode(), hashlib.sha256
    ).hexdigest()
    return f"{vyprsi}.{podpis}"


def main() -> int:
    chyby = []

    def zkontroluj(popis, podminka, detail=""):
        if podminka:
            print(f"ok    {popis}")
        else:
            print(f"FAIL  {popis} {detail}")
            chyby.append(popis)

    # ── 1. Konfigurace go2rtc ──────────────────────────────────────
    server = HTTPServer(("127.0.0.1", 0), FakePortal)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    portal.PORTAL_URL = f"http://127.0.0.1:{server.server_port}"

    kamery = live.nacti_kamery()
    zkontroluj("kamera bez adresy vypadne", len(kamery) == 2, str(len(kamery)))

    config = live.slozit_config(kamery)

    zkontroluj("hlavní proud má jméno podle sériového čísla",
               f"\n  {SERIAL}:" in config, config)
    zkontroluj("vedlejší proud má příponu _sub",
               f"\n  {SERIAL}_sub:" in config)
    zkontroluj("výchozí cesta Dahua u kamery bez vlastní",
               "/cam/realmonitor?channel=1&subtype=0" in config)
    zkontroluj("vlastní cesta z portálu přebije výchozí",
               "/vlastni/main" in config and "/vlastni/sub" in config)
    zkontroluj("adresa nese IP i port",
               "192.168.11.31:554" in config)

    # Heslo `he@slo/2026` nekódované by adresu rozseklo na nesmysl,
    # který kamera odmítne jako špatné přihlášení — a hledalo by se to
    # v kameře místo v kódu.
    zkontroluj("heslo je v adrese zakódované",
               "he%40slo%2F2026" in config, config[:400])
    zkontroluj("a nikde není syrové",
               "he@slo/2026" not in config)

    zkontroluj("administrace go2rtc poslouchá jen uvnitř",
               "listen: :1984" in config)

    # Kontrolu původu řeší Caddy přepisem hlavičky Origin, ne go2rtc.
    # Kdyby se `origin` psal vždycky, byla by ta úniková cesta zapnutá
    # pořád a přepis v Caddy by se nikdy neuplatnil.
    zkontroluj("origin se ve výchozím stavu NEnastavuje",
               "origin:" not in config, config[:300])
    zkontroluj("RTSP server se nezapíná", 'rtsp:\n  listen: ""' in config)
    zkontroluj("WebRTC se nezapíná", 'webrtc:\n  listen: ""' in config)

    # Úniková cesta pro případ, že by přepis v Caddy nestačil.
    os.environ["GO2RTC_ORIGIN"] = "*"
    importlib.reload(live)
    zkontroluj("GO2RTC_ORIGIN=* se do konfigurace propíše",
               'origin: "*"' in live.slozit_config(kamery))
    os.environ.pop("GO2RTC_ORIGIN", None)
    importlib.reload(live)

    # ── 2. Dveřník ─────────────────────────────────────────────────
    brana = HTTPServer(("127.0.0.1", 0), live.AuthHandler)
    threading.Thread(target=brana.serve_forever, daemon=True).start()
    zaklad = f"http://127.0.0.1:{brana.server_port}"

    def zeptej(uri: str) -> int:
        request = urllib.request.Request(f"{zaklad}/auth")
        request.add_header("X-Forwarded-Uri", uri)
        try:
            with urllib.request.urlopen(request, timeout=5) as odpoved:
                return odpoved.status
        except urllib.error.HTTPError as exc:
            return exc.code

    platny = listek(SERIAL, int(time.time()) + 120)

    zkontroluj("platný lístek projde",
               zeptej(f"/api/ws?src={SERIAL}&token={platny}") == 200)

    # Tohle je celá pointa: lístek na vlastní kameru nesmí otevřít cizí.
    zkontroluj("lístek na JINOU kameru neprojde",
               zeptej(f"/api/ws?src=CAM-VLASTNI&token={platny}") == 403)

    zkontroluj("bez lístku neprojde",
               zeptej(f"/api/ws?src={SERIAL}") == 403)
    zkontroluj("bez jména proudu neprojde",
               zeptej(f"/api/ws?token={platny}") == 403)
    zkontroluj("propadlý lístek neprojde",
               zeptej(f"/api/ws?src={SERIAL}&token={listek(SERIAL, int(time.time()) - 1)}") == 403)
    zkontroluj("podvržený podpis neprojde",
               zeptej(f"/api/ws?src={SERIAL}&token={int(time.time()) + 120}.{'f' * 64}") == 403)
    zkontroluj("prodloužená platnost neprojde",
               zeptej(f"/api/ws?src={SERIAL}&token={platny.split('.')[0]}0.{platny.split('.')[1]}") == 403)

    server.shutdown()
    brana.shutdown()

    if chyby:
        print(f"\nSELHALO {len(chyby)} kontrol")
        return 1
    print("\nVŠECHNY TESTY PROŠLY")
    return 0


if __name__ == "__main__":
    sys.exit(main())
