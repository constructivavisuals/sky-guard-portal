#!/usr/bin/env python3
"""
Sky Guard — přehrávání ze SD karty kamery.

═══ Co to dělá ═════════════════════════════════════════════════════
Kamera natáčí 24/7 na vlastní kartu a přepisuje ji dokola. Když se
klient chce podívat týden zpátky, otevře se RTSP proud z konkrétního
času přímo z karty — stejná cesta, jakou používá DMSS. Do Hetzneru se
nic průběžně neukládá; tam jdou jen klipy kolem detekcí jako důkaz
(viz klipy.py).

Tahle služba je k tomu vrátný a správce sezení:

  1. Caddy se jí zeptá (forward_auth), jestli lístek platí.
  2. Ona ho ověří TÝMŽ kódem jako živý obraz — `live.overit_listek`.
  3. Podle jména proudu složí adresu playbacku a založí proud
     v go2rtc.
  4. Když se na proud nikdo nedívá, po chvíli ho zase zruší.

═══ Proč VLASTNÍ instance go2rtc ═══════════════════════════════════
Protože `live.py` tou svou při každé změně seznamu kamer TŘESE:
přepíše konfigurák a zavolá `/api/restart`. Restart utne všechna
rozjetá spojení — u živého obrazu to znamená vteřinu bez obrazu,
u přehrávání ze záznamu by to zabilo každé sezení, které zrovna běží.

Druhý důvod: proudy playbacku vznikají a zanikají po každém posunu na
časové ose. Míchat je do konfiguráku, který se generuje z portálu, by
znamenalo, že si dvě věci přepisují tentýž soubor.

═══ Čas je MÍSTNÍ, ne UTC ══════════════════════════════════════════
Dahua bere `starttime` v čase kamery, ne v UTC. Portál i lístky mluví
v UTC, takže se to tady musí převést — jinak by se přehrávání trefilo
o dvě hodiny vedle a v létě jinak než v zimě. Je to tentýž převod,
jaký dělá watcher nad názvy souborů, a ze stejného důvodu.

═══ Co NENÍ ověřené ════════════════════════════════════════════════
Adresa playbacku se nepodařilo vyzkoušet na skutečné kameře. Ví se,
že Dahua tenhle tvar má, ale konkrétní model a firmware to může mít
jinak — a tenhle projekt už dvakrát zaplatil za odhad místo měření.
Proto jde tvar adresy přenastavit z prostředí (PLAYBACK_PATH), aby se
doladil bez nasazení nové verze. Co změřit, je v README.
"""

from __future__ import annotations

import json
import logging
import os
import re
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer
from zoneinfo import ZoneInfo

import live
import portal
from portal import PortalError

# ── Konfigurace ──────────────────────────────────────────────────

AUTH_HOST = os.environ.get("PLAYBACK_AUTH_HOST", "0.0.0.0")
AUTH_PORT = int(os.environ.get("PLAYBACK_AUTH_PORT", "8090"))

# VLASTNÍ instance, ne ta od živého obrazu — viz hlavička.
GO2RTC_API = os.environ.get(
    "PLAYBACK_GO2RTC_API", "http://go2rtc-playback:1984"
).rstrip("/")

CAMERA_TZ = ZoneInfo(os.environ.get("CAMERA_TZ", "Europe/Prague"))

# Tvar adresy playbacku. `{od}` a `{do}` se nahradí časem kamery.
#
# ═══ Změřeno na skutečné kameře přes tunel ═════════════════════════
# Tenhle tvar funguje, čas sedí a `endtime` zabírá. `subtype=1` je
# tam POVINNĚ, ne pro úsporu: hlavní proud (4K) se přes tunel
# rozpadá — jak živý, tak z karty. Vedlejší je čistý. Není to vada
# kodeku ani kontejneru, je to prostě víc dat, než linka unese.
#
# Držené zvlášť od RTSP_MAIN_PATH schválně: tohle je jiná větev kódu
# v kameře než živý obraz a mezi firmwary se liší nejvíc.
PLAYBACK_PATH = os.environ.get(
    "PLAYBACK_PATH",
    "/cam/playback?channel=1&subtype=1&starttime={od}&endtime={do}",
)

# Jak daleko dopředu se otevře okno záznamu.
#
# Ne donekonečna: až proud dojede na `endtime`, go2rtc ho vidí jako
# odpojený zdroj a připojí se ZNOVU — tedy od téhož `starttime`.
# Divák by tím spadl na začátek. Čtyři hodiny jsou dost na to, aby to
# nikdo v jednom sezení nevyčerpal, a málo na to, aby kamera držela
# otevřené okno zbytečně dlouho.
OKNO_SEC = int(os.environ.get("PLAYBACK_WINDOW_SEC", "14400"))

# Jméno vstupní šablony v playback-config/go2rtc.yaml. Vynucuje TCP —
# viz go2rtc_zdroj() a komentář u té šablony.
VSTUPNI_SABLONA = os.environ.get("PLAYBACK_INPUT_TEMPLATE", "playback")

# Po jak dlouhé nečinnosti se proud zruší. Každý živý proud drží
# spojení na kameru a ta zároveň píše na tutéž kartu, takže zapomenutý
# proud stojí víc než místo v paměti.
IDLE_SEC = float(os.environ.get("PLAYBACK_IDLE_SEC", "60"))
REAP_INTERVAL_SEC = float(os.environ.get("PLAYBACK_REAP_SEC", "15"))

# Kolik nejvíc proudů naráz. Kamera i karta mají strop a překročit ho
# znamená, že se rozsype i živý obraz.
MAX_PROUDU = int(os.environ.get("PLAYBACK_MAX_STREAMS", "12"))

CAMERAS_REFRESH_SEC = float(os.environ.get("PLAYBACK_CAMERAS_REFRESH_SEC", "300"))
HTTP_TIMEOUT = float(os.environ.get("GO2RTC_HTTP_TIMEOUT_SEC", "10"))

ONCE = os.environ.get("PLAYBACK_ONCE", "0") == "1"

logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)s %(message)s",
    stream=sys.stdout,
)
log = logging.getLogger("sky-playback")


# ── Jméno proudu ─────────────────────────────────────────────────
#
# `<sériové číslo>-pb-<epocha UTC>`
#
# ═══ Proč se čas nese ve JMÉNU proudu ══════════════════════════════
# Aby se nemusel měnit lístek. `live.overit_listek` podepisuje jméno
# proudu, takže lístek vydaný na 14:00 nejde použít na 3:00 — je to
# jiné jméno a podpis nesedí. Kdyby čas šel zvlášť jako parametr,
# musel by se do podpisu přidat a rozešly by se tím obě strany
# (relay a src/lib/live/token.ts v portálu).

JMENO_RE = re.compile(r"^([A-Za-z0-9_-]{1,64})-pb-(\d{9,12})$")


def jmeno_proudu(serial: str, od_epoch: int) -> str:
    return f"{serial}-pb-{od_epoch}"


def rozeber_jmeno(jmeno: str) -> tuple[str, int] | None:
    """Ze jména proudu zpátky sériové číslo a čas. None = není to playback."""
    shoda = JMENO_RE.match(jmeno or "")
    if not shoda:
        return None
    return shoda.group(1), int(shoda.group(2))


def playback_url(lan_ip: str, od_epoch: int, okno_sec: int = OKNO_SEC) -> str:
    """
    Adresa playbacku pro daný čas.

    Čas se převádí do zóny KAMERY — Dahua ho tak čeká. Formát
    `YYYY_MM_DD_HH_MM_SS` je ten, který se u Dahuy používá.
    """
    od = datetime.fromtimestamp(od_epoch, timezone.utc).astimezone(CAMERA_TZ)
    do = od + timedelta(seconds=okno_sec)
    tvar = "%Y_%m_%d_%H_%M_%S"
    cesta = PLAYBACK_PATH.format(od=od.strftime(tvar), do=do.strftime(tvar))
    return live.rtsp_url(lan_ip, cesta)


def go2rtc_zdroj(rtsp: str) -> str:
    """
    Zabalí adresu tak, aby go2rtc šlo přes TCP.

    ═══ Tohle NENÍ kosmetika ══════════════════════════════════════
    Změřeno na kameře: vedlejší proud přes UDP se rozpadal stejně
    jako 4K, přes TCP je čistý. UDP při ztrátě paketu nic neopakuje
    a přes tunel se pakety ztrácejí — obraz z toho vyjde rozsypaný,
    ale soubor i proud vypadají platně. Přesně ta třída závady, na
    které tenhle projekt už dvakrát pohořel.

    Nativní RTSP klient go2rtc přepínač transportu NEMÁ — `#transport=`
    umí jen WebSocket. Proto se jde přes `ffmpeg:` zdroj, kde se dá
    transport vynutit. Dokumentace go2rtc tuhle cestu sama doporučuje
    u proudů, které se rozpadají, a bez překódování nestojí procesor
    nic navíc.

    Nestačí ale nechat výchozí chování: šablona `rtsp` v go2rtc má
    `-rtsp_flags prefer_tcp`, což TCP jen PREFERUJE a při potížích
    spadne na UDP — tedy přesně tam, kde se obraz rozpadá.

    Odkazuje se na POJMENOVANOU šablonu z go2rtc.yaml, ne na argumenty
    psané rovnou sem. Dva důvody:

      * zdroj nemá mezery ani složené závorky, takže neprojde dvojím
        kódováním (jednou do API, podruhé při rozboru `#` parametrů);
      * v adrese i v logu zbyde `#input=playback`, což se dá přečíst.

    Šablona sama je v playback-config/go2rtc.yaml. Když se přejmenuje
    tam, musí se přejmenovat i tady — hlídá to test.
    """
    return f"ffmpeg:{rtsp}#input={VSTUPNI_SABLONA}"


# ── go2rtc ───────────────────────────────────────────────────────


def _go2rtc(metoda: str, dotaz: dict) -> dict | None:
    """
    Zavolá API go2rtc. Vrací tělo u GET, jinak None. Výjimka = selhalo.

    POZOR na jednu past v tom API: mazání proudu se dělá parametrem
    `src`, ale očekává JMÉNO proudu, ne adresu zdroje. Zakládání
    naopak bere `name` i `src`. Splést si to znamená, že se maže něco
    jiného, než si člověk myslí — proto to volá tahle jediná funkce.
    """
    # `quote` místo výchozího `quote_plus`: mezera se zakóduje jako
    # %20, ne jako +. go2rtc hodnotu `src` rozebírá ještě jednou (dělí
    # ji na `#` parametry) a `+` by se v tom druhém průchodu mohlo
    # vyložit jinak. Dnes v adrese žádná mezera není, ale tohle je
    # levnější než si na to vzpomenout, až tam bude.
    url = f"{GO2RTC_API}/api/streams?" + urllib.parse.urlencode(
        dotaz, quote_via=urllib.parse.quote
    )
    request = urllib.request.Request(url, method=metoda)
    try:
        with urllib.request.urlopen(request, timeout=HTTP_TIMEOUT) as odpoved:
            telo = odpoved.read()
    except urllib.error.HTTPError as exc:
        # Tělo odpovědi je to JEDINÉ, co říká PROČ. go2rtc vrací
        # `http.Error(w, err.Error(), 400)`, tedy důvod v těle a nic
        # v hlavičce — bez něj je z toho holé „400" a hádá se, jestli
        # je špatně adresa, šablona, nebo zápis do konfiguráku.
        try:
            duvod = exc.read().decode("utf-8", "replace").strip()[:300]
        except OSError:
            duvod = ""
        raise RuntimeError(
            f"go2rtc {metoda} {exc.code}" + (f": {duvod}" if duvod else "")
        ) from exc
    except (urllib.error.URLError, OSError) as exc:
        raise RuntimeError(f"go2rtc {metoda} nedostupné: {exc}") from exc

    if metoda != "GET":
        return None
    try:
        return json.loads(telo.decode("utf-8") or "{}")
    except ValueError as exc:
        raise RuntimeError(f"go2rtc vrátil nesrozumitelnou odpověď: {exc}") from exc


def overit_konfiguraci() -> list[str]:
    """
    Zkontroluje, co v konfiguraci go2rtc umí tiše zabít přehrávání.

    Dvě věci, obě ve stejném souboru a obě se stejným příznakem:
    proud se založí, websocket se naváže a obraz nenaskočí.

    ═══ 1. Vstupní šablona ════════════════════════════════════════
    Neznámé jméno šablony NESELŽE.

    ═══ Proč to stojí za vlastní kontrolu ═════════════════════════
    Protože neznámá šablona NESELŽE. `configTemplate()` v go2rtc
    vrátí neznámé jméno beze změny:

        if s := defaults[template]; s != "" { return s }
        return template

    a `inputTemplate()` v něm pak nahradí `{input}`, které tam ale
    není. ffmpeg tedy dostane jako celý vstup slovo „playback" —
    žádné `-i`, žádnou adresu.

    Navenek to vypadá zdravě: PUT projde, proud se založí, websocket
    se naváže (101) a nic se nepřehraje.

    A do třetice zástupné hodnoty: 1.9.9 dosazuje jen `{input}`,
    takže `{timeout}` opsané z novější dokumentace dojde do ffmpegu
    doslova a ten spadne.

    ═══ 2. Vypnutý RTSP server ════════════════════════════════════
    `ffmpeg:` zdroj si výstup z ffmpegu předává zpátky do go2rtc přes
    jeho VLASTNÍ RTSP server. Když je vypnutý, přijde po websocketu

        {"type":"error","value":"mse: streams: exec: rtsp module disabled"}

    Instance pro živý obraz ho vypnutý MÁ a je to správně — bere
    proudy nativním klientem. Tady se ale bez něj nepřehraje nic.

    Vrací seznam nálezů; prázdný = v pořádku.
    """
    url = f"{GO2RTC_API}/api/config"
    try:
        with urllib.request.urlopen(url, timeout=HTTP_TIMEOUT) as odpoved:
            config = odpoved.read().decode("utf-8", "replace")
    except (urllib.error.URLError, OSError) as exc:
        return [f"konfigurace go2rtc se nedá přečíst: {exc}"]

    # Hrubě, bez YAML parseru: relay nemá jedinou závislost mimo
    # standardní knihovnu a na tyhle dvě otázky parser netřeba.
    nalezy: list[str] = []

    radek = next(
        (r for r in config.splitlines()
         if r.strip().startswith(f"{VSTUPNI_SABLONA}:")), None,
    )
    if radek is None:
        nalezy.append(
            f"go2rtc nezná vstupní šablonu '{VSTUPNI_SABLONA}' — ffmpeg "
            f"nedostane vstupní adresu a nic se nepřehraje"
        )
    else:
        # ═══ 3. Nedosazená zástupná hodnota ════════════════════════
        # go2rtc 1.9.9 dosazuje ve vlastních šablonách JEDINÉ
        # `{input}`. Cokoli jiného ve složených závorkách dojde do
        # ffmpegu doslova a ten na tom spadne — typicky `{timeout}`,
        # opsané z dokumentace novější verze.
        zbyle = {z for z in re.findall(r"\{[a-z_]+\}", radek) if z != "{input}"}
        if zbyle:
            nalezy.append(
                f"šablona '{VSTUPNI_SABLONA}' obsahuje zástupné hodnoty, "
                f"které go2rtc 1.9.9 nedosazuje: {', '.join(sorted(zbyle))} "
                f"— dojdou do ffmpegu doslova a ten spadne"
            )
        if "{input}" not in radek:
            nalezy.append(
                f"šablona '{VSTUPNI_SABLONA}' nemá {{input}} — ffmpeg by "
                f"nedostal adresu kamery"
            )

    if re.search(r'^\s*listen:\s*(""|\'\'|)\s*$', config, re.MULTILINE) and (
        "rtsp:" in config
    ):
        # Prázdný `listen` může být i u webrtc, kde je v pořádku. Proto
        # se hledá až v sekci rtsp.
        sekce = config.split("rtsp:", 1)[1].split("\n\n", 1)[0]
        if re.search(r'listen:\s*(""|\'\'|)\s*$', sekce, re.MULTILINE):
            nalezy.append(
                "go2rtc má vypnutý RTSP server — `ffmpeg:` zdroj si přes "
                "něj předává výstup a bez něj vrátí "
                "'exec: rtsp module disabled'"
            )

    return nalezy


def seznam_proudu() -> dict:
    return _go2rtc("GET", {}) or {}


def zaloz_proud(jmeno: str, zdroj: str) -> None:
    _go2rtc("PUT", {"name": jmeno, "src": zdroj})


def zrus_proud(jmeno: str) -> None:
    # `src` tu znamená jméno proudu — viz poznámka v _go2rtc.
    _go2rtc("DELETE", {"src": jmeno})


def pocet_divaku(info: dict) -> int:
    """Kolik spotřebitelů proud má. Podle toho se pozná opuštěné sezení."""
    consumers = info.get("consumers")
    return len(consumers) if isinstance(consumers, list) else 0


# ── Kamery ───────────────────────────────────────────────────────


class Kamery:
    """
    Seznam kamer z portálu, s vlastní pamětí.

    Z portálu, ne z konfiguráku — ze stejného důvodu jako u events.py:
    druhý seznam by se rozešel při první kameře, kterou někdo přepne
    na jinou IP, a rozešel by se tiše.

    Poslední úspěšný seznam se drží i po výpadku portálu. Přehrávání
    je čtení z kamery a portál k němu není potřeba; kdyby se seznam
    zahazoval, znamenal by každý výpadek portálu i konec přehrávání.
    """

    def __init__(self) -> None:
        self._podle_serialu: dict[str, dict] = {}
        self._nacteno = 0.0
        self._zamek = threading.Lock()

    def obnov(self) -> bool:
        try:
            kamery = live.nacti_kamery()
        except PortalError as exc:
            log.warning("Seznam kamer se nenačetl (%s): %s", exc.status, exc)
            return False
        except Exception as exc:  # noqa: BLE001
            log.warning("Seznam kamer se nenačetl: %s", exc)
            return False

        with self._zamek:
            self._podle_serialu = {
                k["serial_number"]: k for k in kamery if k.get("serial_number")
            }
            self._nacteno = time.time()
        log.info("Seznam kamer obnoven: %d", len(self._podle_serialu))
        return True

    def najdi(self, serial: str) -> dict | None:
        with self._zamek:
            kamera = self._podle_serialu.get(serial)
            stary = time.time() - self._nacteno > CAMERAS_REFRESH_SEC
        if kamera is None and stary:
            # Nová kamera mohla přibýt až po posledním načtení.
            if self.obnov():
                with self._zamek:
                    return self._podle_serialu.get(serial)
        return kamera


KAMERY = Kamery()


# ── Sezení ───────────────────────────────────────────────────────


class Sezeni:
    """
    Které proudy playbacku běží a odkdy jsou bez diváka.

    Proud se NEruší hned, jakmile zmizí poslední divák: prohlížeč se
    při posunu na ose odpojí a hned připojí znovu, a mezi tím je
    krátká chvíle bez spotřebitele. Kdyby se rušilo okamžitě, každý
    posun by znamenal nové navazování spojení na kameru — tedy přesně
    tu vteřinovou prodlevu, které se chceme vyhnout.
    """

    def __init__(self) -> None:
        self._bez_divaka: dict[str, float] = {}
        self._zamek = threading.Lock()

    def zapomen(self, jmeno: str) -> None:
        with self._zamek:
            self._bez_divaka.pop(jmeno, None)

    def k_uklizeni(self, proudy: dict, ted: float) -> list[str]:
        """Jména proudů playbacku, které jsou dost dlouho bez diváka."""
        ke_zruseni = []
        with self._zamek:
            zive = set()
            for jmeno, info in proudy.items():
                if not rozeber_jmeno(jmeno):
                    continue  # cizí proud, nepatří nám
                zive.add(jmeno)
                if pocet_divaku(info) > 0:
                    self._bez_divaka.pop(jmeno, None)
                    continue
                od_kdy = self._bez_divaka.setdefault(jmeno, ted)
                if ted - od_kdy >= IDLE_SEC:
                    ke_zruseni.append(jmeno)
            # Proudy, které mezitím zmizely jinak, ať se nedrží v paměti.
            for jmeno in list(self._bez_divaka):
                if jmeno not in zive:
                    del self._bez_divaka[jmeno]
        return ke_zruseni


SEZENI = Sezeni()


def zajisti_proud(jmeno: str) -> str | None:
    """
    Postará se, aby proud v go2rtc existoval. Vrací důvod odmítnutí.

    Volá se z ověřovací brány, tedy AŽ po platném lístku. Proud tím
    vzniká přesně ve chvíli, kdy o něj někdo oprávněně požádá — ne
    dopředu podle konfiguráku, který by musel znát všechny časy.
    """
    rozebrano = rozeber_jmeno(jmeno)
    if not rozebrano:
        return "unknown_stream"
    serial, od_epoch = rozebrano

    kamera = KAMERY.najdi(serial)
    if not kamera or not kamera.get("lan_ip"):
        return "unknown_camera"

    try:
        proudy = seznam_proudu()
    except RuntimeError as exc:
        log.error("go2rtc neodpovídá: %s", exc)
        return "backend_unavailable"

    if jmeno in proudy:
        SEZENI.zapomen(jmeno)
        return None

    bezicich = sum(1 for j in proudy if rozeber_jmeno(j))
    if bezicich >= MAX_PROUDU:
        # Radši odmítnout, než rozsypat i živý obraz. Strop je na
        # kameře i na kartě, ne v téhle službě.
        log.warning("Strop souběžných přehrávání (%d) — odmítám %s",
                    MAX_PROUDU, jmeno)
        return "too_many_streams"

    zdroj = go2rtc_zdroj(playback_url(kamera["lan_ip"], od_epoch))
    try:
        zaloz_proud(jmeno, zdroj)
    except RuntimeError as exc:
        log.error("Proud %s se nepodařilo založit: %s", jmeno, exc)
        return "backend_unavailable"

    SEZENI.zapomen(jmeno)
    log.info("Přehrávání otevřeno: %s (kamera %s, od %s)", jmeno, serial,
             datetime.fromtimestamp(od_epoch, timezone.utc).isoformat())
    return None


def smycka_uklidu(stop: threading.Event) -> None:
    """Ruší proudy, na které se nikdo nedívá."""
    while not stop.is_set():
        try:
            proudy = seznam_proudu()
        except RuntimeError as exc:
            log.warning("Úklid: go2rtc neodpovídá: %s", exc)
        else:
            for jmeno in SEZENI.k_uklizeni(proudy, time.time()):
                try:
                    zrus_proud(jmeno)
                    log.info("Přehrávání zavřeno (bez diváka): %s", jmeno)
                except RuntimeError as exc:
                    log.warning("Proud %s se nepodařilo zrušit: %s", jmeno, exc)
        if ONCE:
            return
        stop.wait(REAP_INTERVAL_SEC)


# ── Ověřovací brána ──────────────────────────────────────────────


def stream_z_uri(uri: str) -> str:
    """Jméno proudu z dotazu, který Caddy posílá v X-Forwarded-Uri."""
    dotaz = urllib.parse.urlparse(uri).query
    hodnoty = urllib.parse.parse_qs(dotaz)
    for klic in ("src", "name"):
        if hodnoty.get(klic):
            return hodnoty[klic][0]
    return ""


class Brana(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):  # vlastní logování níž
        return

    def _odpoved(self, status: int, telo: bytes = b"") -> None:
        self.send_response(status)
        self.send_header("Content-Length", str(len(telo)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if telo:
            self.wfile.write(telo)

    def do_GET(self) -> None:
        cesta = urllib.parse.urlparse(self.path).path

        if cesta == "/zdravi":
            self._odpoved(200, b"ok")
            return

        if cesta != "/auth":
            self._odpoved(404, b"not found")
            return

        uri = self.headers.get("X-Forwarded-Uri", "")
        hodnoty = urllib.parse.parse_qs(urllib.parse.urlparse(uri).query)
        stream = stream_z_uri(uri)
        token = (hodnoty.get("listek") or hodnoty.get("token") or [""])[0]

        # Lístek TÝMŽ kódem jako živý obraz. Kdyby se to tu ověřovalo
        # zvlášť, rozešly by se dvě kopie téhož podpisu — a poznalo by
        # se to jako „neplatný lístek“, tedy stejně jako špatné heslo.
        duvod = live.overit_listek(stream, token)
        if duvod is None:
            duvod = zajisti_proud(stream)

        if duvod is None:
            self._odpoved(200, b"ok")
            return

        log.info("Přehrávání odmítnuto (%s): %s", duvod, stream or "?")
        self._odpoved(403, duvod.encode("ascii", "replace"))


def main() -> int:
    if not live.LIVE_SECRET:
        log.error("LIVE_STREAM_SECRET není nastavené — nikdo se nepodívá.")
        return 2
    if not portal.PORTAL_URL:
        log.error("PORTAL_URL není nastavené.")
        return 2

    KAMERY.obnov()

    # Šablona je jediné, co se dá zkazit tak, že se to nijak neprojeví
    # — viz overit_sablonu(). Proto se to říká nahlas hned při startu,
    # ne až u diváka, který kouká na černo.
    for nalez in overit_konfiguraci():
        log.error(
            "%s. Proud se přesto založí a websocket naváže, takže se to "
            "tváří jako vada kamery — zkontroluj "
            "playback-config/go2rtc.yaml a jestli si ho go2rtc načetl.",
            nalez,
        )

    stop = threading.Event()
    uklid = threading.Thread(target=smycka_uklidu, args=(stop,), daemon=True)
    uklid.start()

    if ONCE:
        uklid.join(timeout=30)
        return 0

    server = HTTPServer((AUTH_HOST, AUTH_PORT), Brana)
    log.info("Brána přehrávání poslouchá na %s:%d", AUTH_HOST, AUTH_PORT)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        stop.set()
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
