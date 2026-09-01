#!/usr/bin/env python3
"""
Test služby událostí — čtení proudu z kamery a odeslání detekce.

    python3 infra/sky-watcher/test/test_events.py

Kamera se nahrazuje falešným serverem, který mluví TÝMŽ protokolem:
multipart proud s řádky `Code=...`, digest autorizace, snapshot.cgi.
Portál taky — a ověřuje podpis stejnou cestou jako ten skutečný, takže
kdyby se relay a portál rozešly v tom, co se podepisuje, projeví se to
tady, ne až na stavbě.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

KOREN = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(KOREN))

SECRET = "testovaci-tajemstvi"
SERIAL = "BK024AAPAGB5592"

selhani: list[str] = []
kontrol = 0


def zkontroluj(popis: str, podminka: bool, detail: str = "") -> None:
    global kontrol
    kontrol += 1
    if podminka:
        print(f"ok    {popis}")
    else:
        print(f"FAIL  {popis} {detail}")
        selhani.append(popis)


# ═══ Čisté funkce ═══════════════════════════════════════════════════

os.environ.setdefault("PORTAL_URL", "http://127.0.0.1:1")
os.environ.setdefault("RELAY_SECRET", SECRET)
os.environ.setdefault("CAMERA_PASSWORD", "tajne")

import events  # noqa: E402


def test_cteni_proudu() -> None:
    print("\n── čtení proudu ──")

    jednoduche = [
        "--myboundary\r\n",
        "Content-Type: text/plain\r\n",
        "Content-Length:36\r\n",
        "\r\n",
        "Code=VideoMotion;action=Start;index=0\r\n",
    ]
    out = list(events.cti_udalosti(jednoduche))
    zkontroluj("hlavičky a hranice se přeskočí", len(out) == 1, str(out))
    zkontroluj("kód se přečte", out and out[0]["code"] == "VideoMotion")
    zkontroluj("akce se přečte", out and out[0]["action"] == "Start")

    # Tohle je ten tvar, na kterém by naivní parser po řádcích spadl:
    # kamera posílá data= jako JSON na víc řádků.
    viceradkove = [
        "Code=SmartMotionHuman;action=Start;index=0;data={\r\n",
        '   "Object" : {\r\n',
        '      "ObjectType" : "Human"\r\n',
        "   }\r\n",
        "}\r\n",
        "--myboundary\r\n",
        "Code=SmartMotionHuman;action=Stop;index=0\r\n",
    ]
    out = list(events.cti_udalosti(viceradkove))
    zkontroluj("víceřádkový JSON se poskládá", len(out) == 2, str(out))
    zkontroluj(
        "a rozparsuje",
        out and out[0]["data"] == {"Object": {"ObjectType": "Human"}},
        str(out[0]["data"]) if out else "",
    )
    zkontroluj("Stop se přečte taky, filtruje se jinde",
               len(out) == 2 and out[1]["action"] == "Stop")

    # Závorka v textové hodnotě nesmí plést počítání.
    s_zavorkou = ['Code=X;action=Pulse;index=0;data={"name":"a{b"}\r\n']
    out = list(events.cti_udalosti(s_zavorkou))
    zkontroluj("závorka v uvozovkách JSON neroztrhne",
               len(out) == 1 and out[0]["data"] == {"name": "a{b"}, str(out))

    # Useknutý proud (kamera zavřela spojení uprostřed) nesmí zacyklit.
    out = list(events.cti_udalosti(["Code=X;action=Start;index=0;data={\r\n"]))
    zkontroluj("useknutá událost se zahodí, ne zacyklí", out == [], str(out))

    # Nečitelný JSON detekci nezahazuje — kód je to podstatné.
    out = list(events.cti_udalosti(["Code=X;action=Start;index=0;data={neco}\r\n"]))
    zkontroluj("nečitelný JSON se uloží jako text",
               len(out) == 1 and "unparsed" in out[0]["data"], str(out))


def test_prodlevy() -> None:
    print("\n── obnova spojení ──")
    prodlevy = [events.backoff_delay(i) for i in range(0, 12)]
    zkontroluj("první pokus je rychlý", prodlevy[0] < 2.0, f"{prodlevy[0]:.2f}")
    zkontroluj("prodleva roste", prodlevy[4] > prodlevy[1], str(prodlevy[:5]))
    zkontroluj(
        "a má strop — kamera po opravě sítě nesmí čekat do večera",
        max(prodlevy) <= events.BACKOFF_MAX_SEC * 1.31,
        f"{max(prodlevy):.1f}",
    )
    zkontroluj(
        "rozptyl je nenulový, kamery nenaskočí v jednom rytmu",
        len({round(events.backoff_delay(5), 4) for _ in range(20)}) > 1,
    )


def test_cooldown() -> None:
    print("\n── prodleva mezi hlášeními ──")
    c = events.Cooldown(30)
    zkontroluj("první událost projde", c.povoleno(SERIAL, "A", 1000.0))
    zkontroluj("druhá hned po ní ne", not c.povoleno(SERIAL, "A", 1005.0))
    zkontroluj("jiný kód není blokovaný", c.povoleno(SERIAL, "B", 1005.0))
    zkontroluj("jiná kamera taky ne", c.povoleno("JINA", "A", 1005.0))
    zkontroluj("po uplynutí lhůty zas projde", c.povoleno(SERIAL, "A", 1031.0))


def test_adresy() -> None:
    print("\n── adresy ──")
    url = events.attach_url("192.168.11.51", "All", 10)
    zkontroluj("attach má heartbeat — bez něj se zaseklé spojení nepozná",
               "heartbeat=10" in url, url)
    zkontroluj("a odebírá vše, ať je kód vidět v logu", "codes=[All]" in url, url)


# ═══ Celý řetěz proti falešné kameře a falešnému portálu ════════════


class FakeCamera(BaseHTTPRequestHandler):
    """Kamera: proud událostí a snímek. Autorizaci neřeší."""

    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def do_GET(self):  # noqa: N802
        if self.path.startswith("/cgi-bin/snapshot.cgi"):
            telo = b"\xff\xd8\xff" + b"j" * 200
            self.send_response(200)
            self.send_header("Content-Type", "image/jpeg")
            self.send_header("Content-Length", str(len(telo)))
            self.end_headers()
            self.wfile.write(telo)
            return

        if not self.path.startswith("/cgi-bin/eventManager.cgi"):
            self.send_response(404)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return

        self.send_response(200)
        self.send_header("Content-Type", "multipart/x-mixed-replace; boundary=myboundary")
        self.end_headers()
        for radek in [
            "--myboundary\r\n",
            "Content-Type: text/plain\r\n",
            "\r\n",
            "Code=Heartbeat;action=Pulse;index=0\r\n",
            "--myboundary\r\n",
            "Code=VideoMotion;action=Start;index=0\r\n",
            "--myboundary\r\n",
            'Code=SmartMotionHuman;action=Start;index=0;data={\r\n',
            '  "Object" : { "ObjectType" : "Human" }\r\n',
            "}\r\n",
        ]:
            self.wfile.write(radek.encode())
        self.wfile.flush()
        # Spojení skončí — worker to bere jako výpadek a jde do prodlevy.


class FakePortal(BaseHTTPRequestHandler):
    """Portál: ověří podpis stejně jako ten skutečný."""

    protocol_version = "HTTP/1.1"
    prijato: dict = {"detections": [], "config": 0, "spatny_podpis": 0}
    kamery: list = []

    def log_message(self, *args):
        pass

    def _overit(self, telo: bytes) -> bool:
        ts = self.headers.get("X-Timestamp", "")
        sig = self.headers.get("X-Signature", "")
        ocekavany = hmac.new(
            SECRET.encode(), f"{ts}.".encode() + telo, hashlib.sha256
        ).hexdigest()
        if not hmac.compare_digest(sig, ocekavany):
            FakePortal.prijato["spatny_podpis"] += 1
            return False
        return True

    def _odpoved(self, status: int, payload: dict) -> None:
        telo = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(telo)))
        self.end_headers()
        self.wfile.write(telo)

    def do_GET(self):  # noqa: N802
        if not self._overit(b""):
            self._odpoved(401, {"error": "unauthorized"})
            return
        FakePortal.prijato["config"] += 1
        self._odpoved(200, {"cameras": FakePortal.kamery, "incomplete": 0})

    def do_POST(self):  # noqa: N802
        delka = int(self.headers.get("Content-Length", "0"))
        telo = self.rfile.read(delka)
        if not self._overit(telo):
            self._odpoved(401, {"error": "unauthorized"})
            return
        FakePortal.prijato["detections"].append(json.loads(telo))
        self._odpoved(200, {"detection_id": "det-1", "dispatch": "skipped"})


def spust(handler) -> tuple[HTTPServer, str]:
    server = HTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, f"127.0.0.1:{server.server_port}"


def test_klip_jen_v_ostrem_rezimu() -> None:
    """
    Úkol na klip vzniká JEN když to portál povolí.

    Přes den se klipy nepořizují — na stavbě se pohybují lidé, kteří
    tam být mají, a záznam je stejně na kartě. O tom, kdy je ostrý
    režim, rozhoduje portál: okno má zónu, dny v týdnu a přesahuje
    půlnoc, takže druhý výpočet na relayi by se jednou rozešel.

    Chybějící `klip` v odpovědi se bere jako NE. Starší portál
    o klipech neví a nemá se stát, že relay začne po nasazení
    stahovat klipy nepřetržitě, protože si mlčení vyložil jako ano.
    """
    print("\n── klipy jen v ostrém režimu ──")

    import tempfile

    kamera = {"serial_number": SERIAL, "name": "Klanečná — jeřáb"}
    udalost = {"code": "SmartMotionHuman", "action": "Start",
               "index": "0", "data": {}}

    puvodni = events.portal.signed_post
    puvodni_fronta = events.KLIPY_FRONTA

    def pust(odpoved: dict) -> int:
        """Pošle detekci a vrátí, kolik úkolů po ní ve frontě je."""
        with tempfile.TemporaryDirectory() as tmp:
            events.KLIPY_FRONTA = Path(tmp)
            events.portal.signed_post = lambda *a, **k: odpoved
            events.posli_detekci(kamera, udalost, None)
            return len(list(Path(tmp).glob("*.json")))

    try:
        zkontroluj("v ostrém režimu úkol vznikne",
                   pust({"detection_id": "d1", "klip": True}) == 1)
        zkontroluj("mimo ostrý režim NE",
                   pust({"detection_id": "d1", "klip": False}) == 0)
        zkontroluj("a když se portál nevyjádří, taky ne",
                   pust({"detection_id": "d1"}) == 0)
    finally:
        events.portal.signed_post = puvodni
        events.KLIPY_FRONTA = puvodni_fronta


def test_cely_retez() -> None:
    print("\n── celý řetěz ──")

    kamera_server, kamera_adresa = spust(FakeCamera)
    portal_server, portal_adresa = spust(FakePortal)

    FakePortal.kamery = [
        {
            "serial_number": SERIAL,
            "name": "Klanečná — jeřáb",
            "site_id": "site-1",
            "site_name": "Klanečná",
            "lan_ip": kamera_adresa,
            "rtsp_main_path": None,
            "rtsp_sub_path": None,
        }
    ]

    events.portal.PORTAL_URL = f"http://{portal_adresa}"
    events.portal.RELAY_SECRET = SECRET
    events.SUBSCRIBE_CODES = "All"

    kamery = events.nacti_kamery()
    zkontroluj("konfigurace se stáhne podepsaným GETem",
               kamery is not None and len(kamery) == 1, str(kamery))
    zkontroluj("portál podpis přijal", FakePortal.prijato["spatny_podpis"] == 0)

    stop = threading.Event()
    worker = events.CameraWorker(kamery[0], events.Cooldown(30), stop)
    worker.start()

    cekano = time.time() + 15
    while time.time() < cekano and not FakePortal.prijato["detections"]:
        time.sleep(0.1)
    stop.set()

    detekce = FakePortal.prijato["detections"]
    zkontroluj("detekce dorazila do portálu", len(detekce) == 1, str(len(detekce)))

    if detekce:
        d = detekce[0]
        zkontroluj("kamera se pojmenuje sériovým číslem",
                   d.get("camera_serial") == SERIAL, str(d.get("camera_serial")))
        zkontroluj("třída je person", d.get("object_class") == "person")
        zkontroluj("kód události zůstane v evidenci",
                   d.get("raw", {}).get("code") == "SmartMotionHuman", str(d.get("raw")))
        zkontroluj("data z kamery se dovezou",
                   d.get("raw", {}).get("data") == {"Object": {"ObjectType": "Human"}})
        zkontroluj("snímek se přiloží",
                   d.get("image", {}).get("media_type") == "image/jpeg")
        zkontroluj("snímek je čitelný base64",
                   base64.b64decode(d["image"]["data"]).startswith(b"\xff\xd8\xff"))
        zkontroluj("heslo ke kameře se do portálu nedostane",
                   "tajne" not in json.dumps(d))

    # VideoMotion přišel taky, ale hlásit se nemá: kamera hlásí pohyb
    # i na déšť a na světla aut.
    zkontroluj(
        "nehlášený kód se nepošle",
        all(d["raw"]["code"] != "VideoMotion" for d in detekce),
        str([d["raw"]["code"] for d in detekce]),
    )

    kamera_server.shutdown()
    portal_server.shutdown()


def main() -> int:
    test_cteni_proudu()
    test_prodlevy()
    test_cooldown()
    test_adresy()
    test_klip_jen_v_ostrem_rezimu()
    test_cely_retez()

    print()
    if selhani:
        print(f"SELHALO {len(selhani)} z {kontrol} kontrol")
        for s in selhani:
            print(f"  - {s}")
        return 1
    print(f"VŠECHNY TESTY PROŠLY ({kontrol} kontrol)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
