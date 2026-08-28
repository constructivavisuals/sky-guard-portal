#!/usr/bin/env python3
"""
Test celého řetězce proti FALEŠNÉMU portálu.

Pustí se lokálně, bez VPS a bez Sky Guardu:

    python3 infra/sky-watcher/test/test_watcher.py

Vyrobí syntetické .dav (ffmpegem), postaví portál na localhostu, pustí
watcher jedním průchodem a ověří, co se stalo — včetně toho, že podpis
sedí, že se soubor po úspěchu smaže a že se po odmítnutí odsune stranou.

Falešný portál ověřuje podpis TOUŽ cestou jako ten skutečný. Kdyby se
watcher a portál rozešly v tom, co přesně se podepisuje, projeví se to
tady, ne až v provozu.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import subprocess
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

KOREN = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(KOREN))

import watcher  # noqa: E402
SECRET = "testovaci-tajemstvi"
SERIAL = "BK024AAPAGB5592"

prijato: dict[str, list] = {"announce": [], "confirm": [], "upload": []}
chovani = {"announce_status": 200, "upload_url": True}


class FakePortal(BaseHTTPRequestHandler):
    def log_message(self, *args):  # ticho v testu
        pass

    def _telo(self) -> bytes:
        return self.rfile.read(int(self.headers.get("Content-Length", "0")))

    def _podpis_sedi(self, body: bytes) -> bool:
        ts = self.headers.get("X-Timestamp", "")
        sig = self.headers.get("X-Signature", "")
        ocekavany = hmac.new(
            SECRET.encode(), f"{ts}.".encode() + body, hashlib.sha256
        ).hexdigest()
        return hmac.compare_digest(ocekavany, sig)

    def _odpoved(self, status: int, payload: dict) -> None:
        data = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_PUT(self):
        prijato["upload"].append(len(self._telo()))
        self.send_response(200)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_POST(self):
        body = self._telo()
        if not self._podpis_sedi(body):
            self._odpoved(401, {"error": "unauthorized"})
            return

        payload = json.loads(body)

        if self.path == "/api/ingest/recording":
            prijato["announce"].append(payload)
            if chovani["announce_status"] != 200:
                chyba = ("storage_quota_exceeded"
                         if chovani["announce_status"] == 507 else "camera_not_ftp")
                self._odpoved(chovani["announce_status"], {"error": chyba})
                return
            self._odpoved(201, {
                "recording_id": "11111111-1111-1111-1111-111111111111",
                "storage_path": "site/cam/2026/08/27/100000-motion.mp4",
                "upload_url": f"http://127.0.0.1:{self.server.server_port}/upload"
                if chovani["upload_url"] else None,
            })
        elif self.path == "/api/ingest/recording/confirm":
            prijato["confirm"].append(payload)
            self._odpoved(200, {"status": "ready"})
        else:
            self._odpoved(404, {"error": "not_found"})


def ffmpeg_funguje() -> bool:
    """
    Bez ffmpegu se tenhle test pustit nedá — remux je jeho podstata.
    Rozlišuje se to od selhání: chybějící nástroj není vada kódu.
    """
    try:
        out = subprocess.run(["ffmpeg", "-version"], capture_output=True, timeout=30)
        return out.returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False


def vyrob_dav(cil: Path) -> None:
    """Syntetické video ve tvaru, jaký posílá kamera (holý H.264)."""
    cil.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
         "-f", "lavfi", "-i", "testsrc=size=320x240:rate=10:duration=1",
         "-c:v", "libx264", "-f", "h264", str(cil)],
        check=True, timeout=120,
    )


def pust_watcher(inbox: Path, failed: Path, port: int) -> subprocess.CompletedProcess:
    env = {
        **os.environ,
        "INBOX_DIR": str(inbox),
        "FAILED_DIR": str(failed),
        "PORTAL_URL": f"http://127.0.0.1:{port}",
        "RELAY_SECRET": SECRET,
        "WATCHER_ONCE": "1",
        "STABLE_CHECKS": "0",
        "HEALTHCHECK_URL": "",
    }
    return subprocess.run(
        [sys.executable, str(KOREN / "watcher.py")],
        env=env, capture_output=True, text=True, timeout=300,
    )


def test_tag_args(zkontroluj) -> None:
    """
    Vynucení čtyřznakového kódu u HEVC.

    Výchozí je NEvynucovat: `-tag:v hvc1` vyhazuje parametry streamu
    ze vzorků a Chrome pak spadne na PIPELINE_ERROR_DECODE. Zpátky se
    to dá zapnout proměnnou, protože `hev1` zase neumí Safari a iOS —
    je to výměna, ne čistá oprava.
    """
    import importlib

    puvodni = os.environ.get("HEVC_TAG")

    os.environ.pop("HEVC_TAG", None)
    importlib.reload(watcher)
    zkontroluj("výchozí stav tag NEvynucuje", watcher.tag_args("hevc") == [])
    zkontroluj("ani u h265", watcher.tag_args("h265") == [])

    os.environ["HEVC_TAG"] = "hvc1"
    importlib.reload(watcher)
    zkontroluj("HEVC_TAG=hvc1 se u HEVC uplatní",
               watcher.tag_args("hevc") == ["-tag:v", "hvc1"])
    zkontroluj("na H.264 se tag neaplikuje nikdy",
               watcher.tag_args("h264") == [])
    zkontroluj("neznámý kodek tag nedostane",
               watcher.tag_args(None) == [] and watcher.tag_args("") == [])

    if puvodni is None:
        os.environ.pop("HEVC_TAG", None)
    else:
        os.environ["HEVC_TAG"] = puvodni
    importlib.reload(watcher)


def main() -> int:
    if not ffmpeg_funguje():
        print("PŘESKOČENO: ffmpeg není k dispozici nebo se nespustí.")
        print("Na macOS s Homebrew bývá příčinou upgrade x265 bez rebuildu ffmpegu:")
        print("  brew reinstall ffmpeg")
        return 2

    server = HTTPServer(("127.0.0.1", 0), FakePortal)
    port = server.server_port
    threading.Thread(target=server.serve_forever, daemon=True).start()

    chyby = []

    def zkontroluj(popis: str, podminka: bool, detail: str = "") -> None:
        if podminka:
            print(f"ok    {popis}")
        else:
            print(f"FAIL  {popis} {detail}")
            chyby.append(popis)

    # Nepotřebuje ffmpeg ani portál — čistá funkce.
    test_tag_args(zkontroluj)

    with tempfile.TemporaryDirectory() as tmp:
        inbox = Path(tmp) / "inbox"
        failed = Path(tmp) / "failed"

        # ── 1. Reálný tvar cesty ───────────────────────────────────
        dav = inbox / SERIAL / "2026-08-27" / "001" / "dav" / "10" / "10.00.00-10.00.43[M][0@0][0].dav"
        vyrob_dav(dav)
        dav.with_suffix(".idx").write_bytes(b"index")

        out = pust_watcher(inbox, failed, port)
        zkontroluj("watcher doběhl", out.returncode == 0, out.stderr[-400:])
        zkontroluj("ohlásil jeden záznam", len(prijato["announce"]) == 1)

        if prijato["announce"]:
            a = prijato["announce"][0]
            zkontroluj("sériové číslo z cesty", a["camera_serial"] == SERIAL, a["camera_serial"])
            zkontroluj("typ události z příznaku", a["event_type"] == "motion", str(a["event_type"]))
            # 10:00 místní čas v srpnu = 08:00 UTC
            zkontroluj("začátek v UTC", a["started_at"].startswith("2026-08-27T08:00:00"), a["started_at"])
            zkontroluj("konec v UTC", a["ended_at"].startswith("2026-08-27T08:00:43"), a["ended_at"])
            zkontroluj("cesta v inboxu jako klíč", a["sd_file_path"].endswith(".dav"), a["sd_file_path"])

        zkontroluj("soubor nahrán", len(prijato["upload"]) == 1)
        zkontroluj("nahrané MP4 není prázdné", prijato["upload"] and prijato["upload"][0] > 0)
        zkontroluj("potvrzeno", len(prijato["confirm"]) == 1)
        zkontroluj("lokál smazán", not dav.exists())
        zkontroluj("index smazán", not dav.with_suffix(".idx").exists())

        # ── 2. Starý tvar cesty bez sériového čísla ────────────────
        prijato["announce"].clear()
        stary = inbox / "cam-01" / "2026-08-27" / "001" / "dav" / "11.00.00-11.05.00[R][0@0][0].dav"
        vyrob_dav(stary)
        pust_watcher(inbox, failed, port)
        zkontroluj("starý tvar cesty projde", len(prijato["announce"]) == 1)
        if prijato["announce"]:
            a = prijato["announce"][0]
            zkontroluj("zařízení z účtu", a["camera_serial"] == "cam-01", a["camera_serial"])
            zkontroluj("typ z příznaku [R]", a["event_type"] == "regular", str(a["event_type"]))

        # ── 3. Nečitelná cesta jde stranou hned ────────────────────
        prijato["announce"].clear()
        nesmysl = inbox / "cam-01" / "necitelna.dav"
        vyrob_dav(nesmysl)
        pust_watcher(inbox, failed, port)
        zkontroluj("nečitelná cesta se neohlašuje", len(prijato["announce"]) == 0)
        zkontroluj("nečitelná cesta odsunuta", (failed / "cam-01" / "necitelna.dav").exists())
        zkontroluj("a z inboxu zmizela", not nesmysl.exists())

        # ── 4. Trvalé odmítnutí portálem → stranou ─────────────────
        prijato["announce"].clear()
        chovani["announce_status"] = 409
        odmitnuty = inbox / "cam-02" / "2026-08-27" / "001" / "dav" / "12.00.00-12.00.10[M][0@0][0].dav"
        vyrob_dav(odmitnuty)
        pust_watcher(inbox, failed, port)
        zkontroluj("odmítnutý požadavek se neopakuje donekonečna",
                   not odmitnuty.exists() and len(prijato["announce"]) == 1)
        chovani["announce_status"] = 200

        # ── 5. Hotový záznam: nahrávat není co ─────────────────────
        prijato["announce"].clear()
        prijato["upload"].clear()
        prijato["confirm"].clear()
        chovani["upload_url"] = False
        hotovy = inbox / "cam-03" / "2026-08-27" / "001" / "dav" / "13.00.00-13.00.10[M][0@0][0].dav"
        vyrob_dav(hotovy)
        pust_watcher(inbox, failed, port)
        zkontroluj("bez adresy se nenahrává", len(prijato["upload"]) == 0)
        zkontroluj("a nepotvrzuje", len(prijato["confirm"]) == 0)
        zkontroluj("lokál se přesto uklidí", not hotovy.exists())
        chovani["upload_url"] = True

        # ── 6. Vyčerpaný strop úložiště ────────────────────────────
        #
        # 507 NENÍ vada souboru. Kdyby ho watcher odsunul do failed jako
        # odmítnutý požadavek, přišla by stavba o záznamy z celé doby,
        # než se uvolní místo — a nikdo by je odtamtud nevrátil. Musí
        # zůstat ležet v inboxu a počkat si.
        prijato["announce"].clear()
        prijato["upload"].clear()
        chovani["announce_status"] = 507
        pri_stropu = inbox / "cam-05" / "2026-08-27" / "001" / "dav" / "15.00.00-15.00.10[M][0@0][0].dav"
        vyrob_dav(pri_stropu)
        out = pust_watcher(inbox, failed, port)
        zkontroluj("strop: záznam se neohlásí jako přijatý", len(prijato["upload"]) == 0)
        zkontroluj("strop: soubor ZŮSTAL v inboxu", pri_stropu.exists())
        zkontroluj("strop: a NEskončil ve failed",
                   not (failed / "cam-05").exists())
        zkontroluj("strop: hlásí se vlastní hláškou, ne jako výpadek",
                   "STROP ÚLOŽIŠTĚ" in out.stdout, out.stdout[-300:])
        chovani["announce_status"] = 200

        # Jakmile se místo uvolní, tentýž soubor projde.
        prijato["announce"].clear()
        pust_watcher(inbox, failed, port)
        zkontroluj("strop: po uvolnění místa projde", len(prijato["announce"]) == 1)
        zkontroluj("strop: a z inboxu zmizí", not pri_stropu.exists())

        # ── 7. Špatné tajemství neprojde ───────────────────────────
        prijato["announce"].clear()
        cizi = inbox / "cam-04" / "2026-08-27" / "001" / "dav" / "14.00.00-14.00.10[M][0@0][0].dav"
        vyrob_dav(cizi)
        env_zaloha = os.environ.get("RELAY_SECRET")
        os.environ["RELAY_SECRET"] = "cizi-tajemstvi"
        out = subprocess.run(
            [sys.executable, str(KOREN / "watcher.py")],
            env={**os.environ, "INBOX_DIR": str(inbox), "FAILED_DIR": str(failed),
                 "PORTAL_URL": f"http://127.0.0.1:{port}", "WATCHER_ONCE": "1",
                 "STABLE_CHECKS": "0", "HEALTHCHECK_URL": ""},
            capture_output=True, text=True, timeout=300,
        )
        if env_zaloha is None:
            os.environ.pop("RELAY_SECRET", None)
        else:
            os.environ["RELAY_SECRET"] = env_zaloha
        zkontroluj("cizí tajemství portál odmítne", "401" in out.stdout or "401" in out.stderr,
                   out.stdout[-300:])
        zkontroluj("a soubor jde stranou", not cizi.exists())

    server.shutdown()

    if chyby:
        print(f"\nSELHALO {len(chyby)} kontrol")
        return 1
    print("\nVŠECHNY TESTY PROŠLY")
    return 0


if __name__ == "__main__":
    sys.exit(main())
