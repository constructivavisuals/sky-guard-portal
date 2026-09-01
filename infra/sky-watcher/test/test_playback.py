#!/usr/bin/env python3
"""
Testy přehrávání ze SD karty a klipů kolem detekcí.

Bez kamery a bez portálu: co se dá ověřit čistě, ověřuje se čistě.
go2rtc zastupuje atrapa na localhostu — zajímá nás, JAKÉ požadavky
mu služba posílá, ne co s nimi udělá.

Co se tímhle ověřit NEDÁ, je v README pod „Co změřit na místě":
jestli kamera na adresu playbacku odpoví a jak rychle.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import sys
import tempfile
import threading
import time
import urllib.parse
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

KOREN = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(KOREN))

# Prostředí musí stát dřív, než se moduly načtou — čtou ho při importu.
LIVE_SECRET = "testovaci-listkove-tajemstvi"
os.environ.setdefault("LIVE_STREAM_SECRET", LIVE_SECRET)
os.environ.setdefault("PORTAL_URL", "http://127.0.0.1:1")
os.environ.setdefault("RELAY_SECRET", "testovaci-tajemstvi")
os.environ.setdefault("CAMERA_TZ", "Europe/Prague")
os.environ.setdefault("CAMERA_PASSWORD", "heslo")

import klipy  # noqa: E402
import playback  # noqa: E402

SERIAL = "BK024AAPAGB5592"


# ── Atrapa go2rtc ────────────────────────────────────────────────


class FakeGo2rtc(BaseHTTPRequestHandler):
    """Drží seznam proudů a zaznamenává, co se mu poslalo."""

    proudy: dict = {}
    volani: list = []
    odmitat: str = ""

    def log_message(self, *args):
        return

    def _telo(self, data: dict) -> None:
        telo = json.dumps(data).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(telo)))
        self.end_headers()
        self.wfile.write(telo)

    def _dotaz(self) -> dict:
        return {
            k: v[0]
            for k, v in urllib.parse.parse_qs(
                urllib.parse.urlparse(self.path).query
            ).items()
        }

    def do_GET(self):
        FakeGo2rtc.volani.append(("GET", self._dotaz()))
        self._telo(FakeGo2rtc.proudy)

    def do_PUT(self):
        dotaz = self._dotaz()
        FakeGo2rtc.volani.append(("PUT", dotaz))
        if FakeGo2rtc.odmitat:
            telo = FakeGo2rtc.odmitat.encode("utf-8")
            self.send_response(400)
            self.send_header("Content-Length", str(len(telo)))
            self.end_headers()
            self.wfile.write(telo)
            return
        FakeGo2rtc.proudy[dotaz["name"]] = {"producers": [], "consumers": []}
        self._telo({})

    def do_DELETE(self):
        dotaz = self._dotaz()
        FakeGo2rtc.volani.append(("DELETE", dotaz))
        FakeGo2rtc.proudy.pop(dotaz.get("src", ""), None)
        self._telo({})


def listek(stream: str, platnost_s: int = 300) -> str:
    """Lístek TÝMŽ postupem jako portál — viz src/lib/live/token.ts."""
    vyprsi = int(time.time()) + platnost_s
    podpis = hmac.new(
        LIVE_SECRET.encode("utf-8"),
        f"{stream}.{vyprsi}".encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()
    return f"{vyprsi}.{podpis}"


# ── Testy ────────────────────────────────────────────────────────


def test_jmeno_proudu(zkontroluj) -> None:
    """Čas se nese ve jméně proudu — na tom stojí platnost lístku."""
    jmeno = playback.jmeno_proudu(SERIAL, 1788000000)
    zkontroluj("jméno se složí a rozebere zpátky",
               playback.rozeber_jmeno(jmeno) == (SERIAL, 1788000000), jmeno)

    zkontroluj("živý proud se za playback nevydává",
               playback.rozeber_jmeno(SERIAL) is None
               and playback.rozeber_jmeno(f"{SERIAL}_sub") is None)

    zkontroluj("nesmysly se odmítnou",
               all(playback.rozeber_jmeno(x) is None for x in
                   ["", "-pb-1", f"{SERIAL}-pb-", f"{SERIAL}-pb-abc",
                    f"../{SERIAL}-pb-1788000000"]))


def test_adresa_playbacku(zkontroluj) -> None:
    """
    Čas jde do kamery MÍSTNÍ, ne v UTC.

    Kdyby se posílalo UTC, trefilo by se přehrávání o dvě hodiny vedle
    — a v zimě o jinou hodinu než v létě, takže by to vypadalo jako
    náhodná závada.
    """
    # 1. září 2026 12:00 UTC = 14:00 v Praze (letní čas)
    leto = int(datetime(2026, 9, 1, 12, 0, 0, tzinfo=timezone.utc).timestamp())
    url_leto = playback.playback_url("10.0.0.5", leto, okno_sec=3600)
    zkontroluj("letní čas se převedl na místní (14:00)",
               "starttime=2026_09_01_14_00_00" in url_leto, url_leto)
    zkontroluj("a endtime je o okno dál (15:00)",
               "endtime=2026_09_01_15_00_00" in url_leto, url_leto)

    # 15. ledna 2026 12:00 UTC = 13:00 v Praze (zimní čas)
    zima = int(datetime(2026, 1, 15, 12, 0, 0, tzinfo=timezone.utc).timestamp())
    url_zima = playback.playback_url("10.0.0.5", zima, okno_sec=3600)
    zkontroluj("zimní čas taky (13:00, ne 14:00)",
               "starttime=2026_01_15_13_00_00" in url_zima, url_zima)

    zkontroluj("bere se VEDLEJŠÍ proud — hlavní se přes tunel rozpadá",
               "subtype=1" in url_leto, url_leto)


def test_vynucene_tcp(zkontroluj) -> None:
    """
    UDP se změřeně rozpadá. TCP musí být vynucené, ne jen preferované.

    Výchozí šablona `rtsp` v go2rtc má `-rtsp_flags prefer_tcp`, což
    při potížích spadne na UDP — tedy tam, kde se obraz rozpadá. Proto
    vlastní šablona. Kdyby tenhle test spadl, znamená to, že proud
    může jet po UDP a vyrobit rozsypaný obraz, který vypadá platně.
    """
    zdroj = playback.go2rtc_zdroj("rtsp://10.0.0.5/cam/playback?channel=1")
    zkontroluj("jde se přes ffmpeg zdroj", zdroj.startswith("ffmpeg:"), zdroj)
    zkontroluj("odkazuje se na vstupní šablonu",
               zdroj.endswith(f"#input={playback.VSTUPNI_SABLONA}"), zdroj)
    zkontroluj("adresa zůstala uvnitř",
               "rtsp://10.0.0.5/cam/playback?channel=1" in zdroj, zdroj)

    # Zdroj nesmí obsahovat nic, co se při dvojím průchodu kódováním
    # (jednou do API go2rtc, podruhé při rozboru `#` parametrů) může
    # rozejít. Právě na tomhle se to lámalo.
    zkontroluj("a nemá mezery ani složené závorky",
               " " not in zdroj and "{" not in zdroj, zdroj)

    # Šablona bydlí v konfiguráku go2rtc a jméno se musí trefit. Kdyby
    # se přejmenovala tam a ne tady, projeví se to jako 400 z go2rtc.
    konfig = (KOREN / "playback-config" / "go2rtc.yaml").read_text(encoding="utf-8")
    zkontroluj("šablona v go2rtc.yaml existuje",
               f"\n  {playback.VSTUPNI_SABLONA}:" in konfig,
               f"hledalo se '{playback.VSTUPNI_SABLONA}:'")
    radek = next(
        (r for r in konfig.splitlines()
         if r.strip().startswith(f"{playback.VSTUPNI_SABLONA}:")), "")
    zkontroluj("a vynucuje TCP, ne jen preferuje",
               "-rtsp_transport tcp" in radek and "prefer_tcp" not in radek,
               radek.strip()[:120])
    zkontroluj("nezahodila -timeout — mrtvá kamera nemá viset donekonečna",
               "-timeout" in radek, radek.strip()[:120])


def test_uklid_sezeni(zkontroluj) -> None:
    """
    Proud bez diváka se ruší, ale ne hned.

    Při posunu na časové ose se prohlížeč na chvíli odpojí. Kdyby se
    rušilo okamžitě, každý posun by znamenal nové spojení na kameru.
    """
    sezeni = playback.Sezeni()
    jmeno = playback.jmeno_proudu(SERIAL, 1788000000)
    prazdny = {jmeno: {"consumers": []}}
    s_divakem = {jmeno: {"consumers": [{"type": "mse"}]}}

    zkontroluj("čerstvě opuštěný proud se neruší",
               sezeni.k_uklizeni(prazdny, 1000.0) == [])
    zkontroluj("a po chvíli ano",
               sezeni.k_uklizeni(prazdny, 1000.0 + playback.IDLE_SEC) == [jmeno])

    sezeni2 = playback.Sezeni()
    sezeni2.k_uklizeni(prazdny, 1000.0)
    sezeni2.k_uklizeni(s_divakem, 1000.0 + 5)
    zkontroluj("divák, který se vrátil, odpočet zruší",
               sezeni2.k_uklizeni(prazdny, 1000.0 + playback.IDLE_SEC) == [])

    zkontroluj("cizí proudy se neuklízejí",
               playback.Sezeni().k_uklizeni(
                   {SERIAL: {"consumers": []}}, 1e9) == [])


def test_brana(zkontroluj, port: int) -> None:
    """Lístek, založení proudu a strop souběžných sezení."""
    playback.GO2RTC_API = f"http://127.0.0.1:{port}"
    FakeGo2rtc.proudy = {}
    FakeGo2rtc.volani = []

    # Kamera se normálně bere z portálu; tady se podstrčí.
    playback.KAMERY._podle_serialu = {SERIAL: {
        "serial_number": SERIAL, "lan_ip": "10.0.0.5", "name": "Brána"}}
    playback.KAMERY._nacteno = time.time()

    jmeno = playback.jmeno_proudu(SERIAL, 1788000000)

    zkontroluj("platný lístek pustí a proud vznikne",
               playback.zajisti_proud(jmeno) is None and jmeno in FakeGo2rtc.proudy)

    puts = [d for m, d in FakeGo2rtc.volani if m == "PUT"]
    zkontroluj("proud se založil přes šablonu s vynuceným TCP",
               puts and puts[0]["src"].endswith(f"#input={playback.VSTUPNI_SABLONA}"),
               str(puts[:1]))

    FakeGo2rtc.volani = []
    zkontroluj("druhé otevření téhož času proud NEzakládá znovu",
               playback.zajisti_proud(jmeno) is None
               and not [m for m, _ in FakeGo2rtc.volani if m == "PUT"])

    zkontroluj("neznámá kamera se odmítne",
               playback.zajisti_proud("CIZI-pb-1788000000") == "unknown_camera")
    zkontroluj("a nesmyslné jméno taky",
               playback.zajisti_proud("neco") == "unknown_stream")

    # Strop: naplnit go2rtc až po okraj.
    for i in range(playback.MAX_PROUDU):
        FakeGo2rtc.proudy[playback.jmeno_proudu(SERIAL, 1788001000 + i)] = {
            "producers": [], "consumers": []}
    zkontroluj("přes strop souběžných přehrávání se nepustí",
               playback.zajisti_proud(playback.jmeno_proudu(SERIAL, 1788009999))
               == "too_many_streams")


def test_chyba_z_go2rtc_nese_duvod(zkontroluj, port: int) -> None:
    """
    Když go2rtc odmítne, musí být v logu PROČ.

    Vrací `http.Error(w, err.Error(), 400)`, tedy důvod v těle a nic
    v hlavičce. Bez něj je z toho holé „400" a hádá se, jestli je
    špatně adresa, šablona, nebo zápis do konfiguráku — což stálo
    jedno kolo ladění.
    """
    playback.GO2RTC_API = f"http://127.0.0.1:{port}"
    FakeGo2rtc.odmitat = "unsupported source type"
    try:
        chyba = ""
        try:
            playback.zaloz_proud("BK-pb-1788000000", "ffmpeg:rtsp://x")
        except RuntimeError as exc:
            chyba = str(exc)
        zkontroluj("chyba nese stavový kód", "400" in chyba, chyba)
        zkontroluj("a hlavně důvod od go2rtc",
                   "unsupported source type" in chyba, chyba)
    finally:
        FakeGo2rtc.odmitat = ""


def test_listek_je_vazany_na_cas(zkontroluj) -> None:
    """
    Lístek na jeden okamžik nesmí otevřít jiný.

    Tohle je celý důvod, proč je čas ve JMÉNĚ proudu: podpis se dělá
    přes jméno, takže jiný čas = jiné jméno = jiný podpis. Kdyby čas
    šel zvlášť jako parametr, otevřel by jeden lístek celý týden.
    """
    import live

    a = playback.jmeno_proudu(SERIAL, 1788000000)
    b = playback.jmeno_proudu(SERIAL, 1788003600)

    zkontroluj("lístek na svůj čas platí",
               live.overit_listek(a, listek(a)) is None)
    zkontroluj("na jiný čas NE",
               live.overit_listek(b, listek(a)) == "bad_signature")
    zkontroluj("a na živý proud téže kamery taky ne",
               live.overit_listek(SERIAL, listek(a)) == "bad_signature")


def test_fronta_klipu(zkontroluj) -> None:
    """Úkoly na klipy: stabilní jméno a počítadlo pokusů."""
    with tempfile.TemporaryDirectory() as tmp:
        fronta = Path(tmp)
        kdy = datetime(2026, 9, 1, 12, 0, 0, tzinfo=timezone.utc)

        a = klipy.zapis_ukol(fronta, SERIAL, kdy, "SmartMotionHuman")
        b = klipy.zapis_ukol(fronta, SERIAL, kdy, "SmartMotionHuman")
        zkontroluj("tatáž detekce = týž soubor, ne druhý úkol",
                   a == b and len(list(fronta.glob("*.json"))) == 1)

        zkontroluj("rozepsaný úkol po sobě nezůstane",
                   not list(fronta.glob("*.rozepsany")))

        ukol = klipy.nacti_ukol(a)
        zkontroluj("úkol nese kameru i čas",
                   ukol and ukol["camera_serial"] == SERIAL
                   and ukol["detected_at"].startswith("2026-09-01T12:00:00"),
                   str(ukol))

        zly = fronta / "necitelny.json"
        zly.write_text("{tohle není json")
        zkontroluj("nečitelný úkol se pozná", klipy.nacti_ukol(zly) is None)


def main() -> int:
    server = HTTPServer(("127.0.0.1", 0), FakeGo2rtc)
    port = server.server_port
    threading.Thread(target=server.serve_forever, daemon=True).start()

    chyby = []

    def zkontroluj(popis: str, podminka: bool, detail: str = "") -> None:
        if podminka:
            print(f"ok    {popis}")
        else:
            print(f"FAIL  {popis} {detail}")
            chyby.append(popis)

    test_jmeno_proudu(zkontroluj)
    test_adresa_playbacku(zkontroluj)
    test_vynucene_tcp(zkontroluj)
    test_uklid_sezeni(zkontroluj)
    test_brana(zkontroluj, port)
    test_chyba_z_go2rtc_nese_duvod(zkontroluj, port)
    test_listek_je_vazany_na_cas(zkontroluj)
    test_fronta_klipu(zkontroluj)

    print()
    if chyby:
        print(f"SELHALO: {len(chyby)}")
        return 1
    print("VŠECHNY TESTY PROŠLY")
    return 0


if __name__ == "__main__":
    sys.exit(main())
