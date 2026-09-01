#!/usr/bin/env python3
"""
Sky Guard — události ze stavebních kamer.

═══ Co to dělá ═════════════════════════════════════════════════════
Ke každé stavební kameře drží jedno dlouhé HTTP spojení na
`eventManager.cgi?action=attach`. Kamera po něm posílá události, jak
nastávají — žádné dotazování v cyklu, žádná prodleva. Když kamera
ohlásí člověka, služba si od ní stáhne snímek a pošle detekci do
portálu.

Detekci umí kamera sama: model má SMD s rozlišením člověka. Portál
tedy nevyhodnocuje obraz, jen přijímá, co kamera řekla.

═══ Proč vlastní služba a ne součást watcheru ══════════════════════
Watcher chodí po adresáři a přebírá hotové soubory; tahle služba visí
na spojení a čeká. Jedno je dávková práce s minutovým zpožděním, druhé
běží v reálném čase. Ve společném procesu by pád jednoho bral s sebou
druhé — a hlavně: záznam, který dorazí o dvě minuty později, nikoho
nebolí, kdežto detekce ano.

═══ Odkud ví o kamerách ════════════════════════════════════════════
Z portálu, ne z konfiguráku. Kamera se zakládá tam a druhý seznam by
se rozešel při první, kterou někdo přejmenuje nebo přepne na jinou IP
— a rozešel by se tiše: služba by dál poslouchala adresu, na které už
nikdo není.

Hesla ke kamerám portál nezná a znát nemá. Berou se odsud z prostředí;
jsou pro všechny kamery stejná.

═══ Co se stane, když kamera vypadne ═══════════════════════════════
Spojení se obnovuje samo s narůstající prodlevou (1 s → 60 s). Kamera
po výpadku proudu naběhne třeba za dvě minuty a nikdo u toho nemá
sedět. Prodleva má strop schválně: hodinová pauza po dvacátém pokusu
by znamenala, že se kamera po opravě sítě probere až večer.
"""

from __future__ import annotations

import base64
import json
import logging
import os
import random
import sys
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

import klipy
import portal
from portal import PortalError

# ── Konfigurace ──────────────────────────────────────────────────

CAMERA_USERNAME = os.environ.get("CAMERA_USERNAME", "admin")
CAMERA_PASSWORD = os.environ.get("CAMERA_PASSWORD", "")

# Na co se kamery ptáme. `All` schválně: přesný kód se u každého modelu
# jmenuje jinak a odběr všeho znamená, že se ten správný objeví v logu,
# místo aby se hádal. Filtruje se až REPORTED_CODES.
SUBSCRIBE_CODES = os.environ.get("SUBSCRIBE_CODES", "All")

# Co z toho je detekce člověka. Nastavitelné, protože se to na místě
# ověřuje — a bez restartu obrazu to jde změnit v .env a přepnout.
REPORTED_CODES = os.environ.get("EVENT_CODES", "SmartMotionHuman")

# Start = událost začala, Pulse = jednorázová. Stop se ignoruje: konec
# pohybu není detekce.
EVENT_ACTIONS = os.environ.get("EVENT_ACTIONS", "Start,Pulse")

OBJECT_CLASS = os.environ.get("EVENT_CLASS", "person")

# Kam se kladou úkoly na klipy. Sdílený svazek s sky-klipy — tahle
# služba do něj jen píše, druhá z něj bere.
KLIPY_FRONTA = Path(os.environ.get("KLIPY_FRONTA_DIR", "/fronta"))
# Kolik nejméně vteřin mezi dvěma hlášeními téže kamery a téhož kódu.
# Člověk procházející záběrem vyvolá událost každou vteřinu; bez tohohle
# by z deseti minut práce na place bylo šest set řádků v evidenci.
COOLDOWN_SEC = float(os.environ.get("EVENT_COOLDOWN_SEC", "30"))

CONFIG_REFRESH_SEC = float(os.environ.get("CONFIG_REFRESH_SEC", "300"))

# Kamera posílá tep, aby se poznalo živé spojení od zaseklého. Bez něj
# by mlčící kamera vypadala stejně jako klidná noc — a to je přesně ta
# závada, kterou tahle služba nesmí mít.
HEARTBEAT_SEC = int(os.environ.get("HEARTBEAT_SEC", "10"))
READ_TIMEOUT_SEC = float(
    os.environ.get("READ_TIMEOUT_SEC", str(max(30, HEARTBEAT_SEC * 3)))
)

SNAPSHOT_CHANNEL = os.environ.get("SNAPSHOT_CHANNEL", "1")
SNAPSHOT_TIMEOUT_SEC = float(os.environ.get("SNAPSHOT_TIMEOUT_SEC", "10"))

# Musí sedět s MAX_IMAGE_BYTES v portálu (src/lib/ingest/image.ts).
# Větší snímek portál odmítne i s detekcí, takže se radši pošle bez něj.
MAX_IMAGE_BYTES = 2 * 1024 * 1024

BACKOFF_MAX_SEC = float(os.environ.get("BACKOFF_MAX_SEC", "60"))

# Jak dlouho musí spojení vydržet, aby se počítalo za zdařilé. Kratší
# se bere jako selhání, jinak by kamera, která spojení hned zavírá,
# točila dokola bez prodlevy.
STABLE_CONNECTION_SEC = float(os.environ.get("STABLE_CONNECTION_SEC", "60"))

HEALTHCHECK_URL = os.environ.get("HEALTHCHECK_URL", "").strip()

ONCE = os.environ.get("EVENTS_ONCE", "0") == "1"

logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)s %(message)s",
)
log = logging.getLogger("events")


# ── Čisté funkce ─────────────────────────────────────────────────


def rozdel_seznam(raw: str) -> set[str]:
    """Čárkami oddělený seznam na množinu. Prázdné položky pryč."""
    return {kus.strip() for kus in raw.split(",") if kus.strip()}


def attach_url(lan_ip: str, codes: str, heartbeat: int) -> str:
    """Adresa dlouhého spojení, po kterém kamera hlásí události."""
    return (
        f"http://{lan_ip}/cgi-bin/eventManager.cgi"
        f"?action=attach&codes=[{codes}]&heartbeat={heartbeat}"
    )


def snapshot_url(lan_ip: str, channel: str) -> str:
    return f"http://{lan_ip}/cgi-bin/snapshot.cgi?channel={channel}"


def json_uzavrene(text: str) -> bool:
    """
    Má text vyrovnané složené závorky mimo řetězce?

    Kamera posílá `data=` jako JSON na VÍC ŘÁDCÍCH. Bez tohohle by se
    událost přečetla useknutá — a useknutý JSON se nepozná od celého,
    dokud ho někdo nezkusí rozparsovat.

    Uvozovky se hlídají schválně: `{` uvnitř textové hodnoty závorku
    neotevírá.
    """
    hloubka = 0
    v_retezci = False
    escape = False
    for znak in text:
        if escape:
            escape = False
            continue
        if znak == "\\":
            escape = True
            continue
        if znak == '"':
            v_retezci = not v_retezci
            continue
        if v_retezci:
            continue
        if znak == "{":
            hloubka += 1
        elif znak == "}":
            hloubka -= 1
    return hloubka <= 0


def cti_udalosti(radky):
    """
    Z proudu řádků dělá události.

    Proud vypadá takhle — hranice částí a hlavičky nás nezajímají,
    stačí řádky, které začínají na `Code=`:

        --myboundary
        Content-Type: text/plain
        Content-Length:36

        Code=SmartMotionHuman;action=Start;index=0;data={
           "Object" : { "ObjectType" : "Human" }
        }

    Generátor schválně: dá se pustit nad seznamem řádků v testu úplně
    stejně jako nad živým socketem.
    """
    it = iter(radky)
    for radek in it:
        radek = radek.rstrip("\r\n")
        if not radek.startswith("Code="):
            continue

        hlavicka, oddelovac, data_text = radek.partition(";data=")
        if oddelovac:
            # Dokud JSON není uzavřený, patří další řádky pořád k němu.
            while not json_uzavrene(data_text):
                dalsi = next(it, None)
                if dalsi is None:
                    return
                data_text += dalsi.rstrip("\r\n")

        udalost = {"code": "", "action": "", "index": "", "data": None}
        for kus in hlavicka.split(";"):
            klic, _, hodnota = kus.partition("=")
            klic = klic.strip().lower()
            if klic in udalost:
                udalost[klic] = hodnota.strip()

        if oddelovac:
            try:
                udalost["data"] = json.loads(data_text)
            except ValueError:
                # Nečitelný JSON detekci nezahazuje: kód události je to
                # podstatné, `data` jsou doplněk. Uloží se jako text,
                # ať je v evidenci vidět, co přesně přišlo.
                udalost["data"] = {"unparsed": data_text[:2000]}

        yield udalost


def backoff_delay(pokus: int, cap: float = BACKOFF_MAX_SEC) -> float:
    """
    Prodleva před dalším pokusem: 1, 2, 4, 8… se stropem.

    Rozptyl schválně: kdyby po výpadku proudu naskočilo pět kamer naráz,
    tloukly by na portál i na sebe v jednom rytmu.
    """
    zaklad = min(cap, 2.0**pokus)
    return zaklad * (0.7 + 0.6 * random.random())


class Cooldown:
    """Kdy se smí týž kód od téže kamery ohlásit znovu."""

    def __init__(self, seconds: float):
        self.seconds = seconds
        self._naposledy: dict[tuple[str, str], float] = {}
        self._zamek = threading.Lock()

    def povoleno(self, serial: str, code: str, now: float) -> bool:
        klic = (serial, code)
        with self._zamek:
            posledni = self._naposledy.get(klic)
            if posledni is not None and now - posledni < self.seconds:
                return False
            self._naposledy[klic] = now
            return True


# ── Kamera ───────────────────────────────────────────────────────

# Kódy, které jsme na téhle kameře viděli. Každý se zaloguje JEDNOU —
# jinak by se v logu ztratilo to podstatné. Je to zároveň jediný způsob,
# jak na místě zjistit, jak se událost na daném modelu doopravdy
# jmenuje: pustit službu a přečíst si, co kamera hlásí.
_videne: set[tuple[str, str]] = set()
_videne_zamek = threading.Lock()


def opener_pro(lan_ip: str) -> urllib.request.OpenerDirector:
    """
    Autorizace ke kameře. Digest i Basic — firmware se liší.

    Heslo se nikdy neloguje ani neposílá do portálu.
    """
    spravce = urllib.request.HTTPPasswordMgrWithDefaultRealm()
    spravce.add_password(None, f"http://{lan_ip}/", CAMERA_USERNAME, CAMERA_PASSWORD)
    return urllib.request.build_opener(
        urllib.request.HTTPDigestAuthHandler(spravce),
        urllib.request.HTTPBasicAuthHandler(spravce),
    )


def stahni_snimek(opener, lan_ip: str) -> bytes | None:
    """
    Snímek z kamery. Selhání NESMÍ shodit detekci.

    Přijít o obrázek je nepříjemné; přijít o záznam, že někdo byl na
    stavbě, je něco jiného.
    """
    try:
        with opener.open(
            snapshot_url(lan_ip, SNAPSHOT_CHANNEL), timeout=SNAPSHOT_TIMEOUT_SEC
        ) as odpoved:
            data = odpoved.read(MAX_IMAGE_BYTES + 1)
    except Exception as exc:  # noqa: BLE001
        log.warning("Snímek z %s se nepodařilo stáhnout: %s", lan_ip, exc)
        return None

    if len(data) > MAX_IMAGE_BYTES:
        # Portál by ho odmítl i s detekcí, takže radši detekce bez
        # obrázku než žádná.
        log.warning("Snímek z %s je větší než %d B — pošle se bez něj", lan_ip, MAX_IMAGE_BYTES)
        return None
    if not data:
        return None
    return data


def posli_detekci(kamera: dict, udalost: dict, snimek: bytes | None) -> None:
    """Detekce do portálu. Podepsaná RELAY_SECRET, ne klíčem kamery."""
    payload = {
        "camera_serial": kamera["serial_number"],
        "detected_at": datetime.now(timezone.utc)
        .isoformat(timespec="seconds")
        .replace("+00:00", "Z"),
        "object_class": OBJECT_CLASS,
        "raw": {
            "source": "eventManager",
            "code": udalost["code"],
            "action": udalost["action"],
            "index": udalost["index"],
            "data": udalost["data"],
        },
    }
    if snimek:
        payload["image"] = {
            "media_type": "image/jpeg",
            "data": base64.b64encode(snimek).decode("ascii"),
        }

    try:
        odpoved = portal.signed_post("/api/ingest/detection", payload)
    except PortalError as exc:
        if exc.status == 409:
            # Tatáž detekce už tam je. Není to závada.
            log.info("Detekce z %s už v portálu byla", kamera["name"])
            return
        log.warning(
            "Detekci z %s se nepodařilo odeslat (%s): %s",
            kamera["name"],
            exc.status,
            exc.body[:200],
        )
        return

    log.info(
        "Detekce z %s odeslána: %s (%s, snímek %s)",
        kamera["name"],
        udalost["code"],
        odpoved.get("detection_id", "?"),
        "ano" if snimek else "ne",
    )

    # ═══ Úkol na klip do fronty ════════════════════════════════════
    # Až TEĎ, po úspěšném odeslání. Na 409 (tatáž detekce už tam je)
    # se sem nedojde, takže se druhý klip nezaloží.
    #
    # Do fronty, ne rovnou: stažení klipu z karty trvá přes minutu a
    # tahle služba mezitím musí poslouchat další události. Detekce je
    # rychlá cesta, klip pomalá — proto jsou to dvě služby.
    #
    # ═══ O tom, JESTLI klip vůbec, rozhoduje portál ════════════════
    # Přes den se klipy nepořizují: na stavbě se pohybují lidé, kteří
    # tam být mají. Okno ostrého režimu má ale zónu, dny v týdnu
    # a přesahuje půlnoc — počítat si to tady by znamenalo druhý zdroj
    # pravdy, který se jednou rozejde. Portál to tedy řekne rovnou
    # v odpovědi na detekci.
    #
    # Chybějící `klip` v odpovědi se bere jako NE. Starší portál
    # o klipech neví a nemá se stát, že relay po nasazení začne
    # stahovat klipy nepřetržitě, protože si mlčení vyložil jako ano.
    if not odpoved.get("klip"):
        log.debug("Klip se u detekce z %s nepořizuje (mimo ostrý režim)",
                  kamera["name"])
        return

    # Selhání zápisu NESMÍ shodit detekci: ta už je odeslaná a je
    # důležitější než klip.
    try:
        klipy.zapis_ukol(
            KLIPY_FRONTA,
            kamera["serial_number"],
            datetime.fromisoformat(payload["detected_at"].replace("Z", "+00:00")),
            udalost["code"],
        )
    except OSError as exc:
        log.warning(
            "Úkol na klip se nepodařilo zapsat (%s). Detekce odeslaná "
            "je, ale video k ní nikdo nevytáhne.", exc,
        )


class CameraWorker(threading.Thread):
    """Jedno vlákno = jedna kamera = jedno dlouhé spojení."""

    def __init__(self, kamera: dict, cooldown: Cooldown, stop: threading.Event):
        super().__init__(name=f"cam-{kamera['serial_number']}", daemon=True)
        self.kamera = kamera
        self.cooldown = cooldown
        self.stop = stop
        self.opener = opener_pro(kamera["lan_ip"])
        self.reported = rozdel_seznam(REPORTED_CODES)
        self.actions = rozdel_seznam(EVENT_ACTIONS)

    # ── smyčka s obnovou ─────────────────────────────────────────
    def run(self) -> None:
        pokus = 0
        while not self.stop.is_set():
            zacatek = time.monotonic()
            try:
                self.poslouchej()
            except Exception as exc:  # noqa: BLE001
                log.warning("Spojení s %s spadlo: %s", self.kamera["name"], exc)
            else:
                log.info("Kamera %s spojení ukončila", self.kamera["name"])

            if self.stop.is_set():
                return

            # Prodleva se počítá od nuly jen po spojení, které vydrželo.
            # Kamera, která spojení hned zavírá, by jinak točila dokola
            # bez pauzy a zatížila by síť i sebe.
            if time.monotonic() - zacatek >= STABLE_CONNECTION_SEC:
                pokus = 0
            prodleva = backoff_delay(pokus)
            pokus += 1
            log.info(
                "Další pokus o %s za %.0f s", self.kamera["name"], prodleva
            )
            self.stop.wait(prodleva)

    def poslouchej(self) -> None:
        url = attach_url(self.kamera["lan_ip"], SUBSCRIBE_CODES, HEARTBEAT_SEC)
        with self.opener.open(url, timeout=READ_TIMEOUT_SEC) as odpoved:
            log.info(
                "Poslouchám %s (%s)", self.kamera["name"], self.kamera["lan_ip"]
            )
            radky = (b.decode("utf-8", "replace") for b in odpoved)
            for udalost in cti_udalosti(radky):
                if self.stop.is_set():
                    return
                self.zpracuj(udalost)

    def zpracuj(self, udalost: dict) -> None:
        kod = udalost["code"]
        serial = self.kamera["serial_number"]

        # Tep není událost.
        if kod in ("Heartbeat", "KeepAlive"):
            return

        klic = (serial, kod)
        with _videne_zamek:
            nove = klic not in _videne
            if nove:
                _videne.add(klic)
        if nove:
            # Tenhle řádek je celý smysl odběru `All`: takhle se na
            # místě zjistí, jak se událost na daném modelu jmenuje.
            log.info(
                "Kamera %s hlásí kód %s (hlásí se dál: %s)",
                self.kamera["name"],
                kod,
                "ano" if kod in self.reported else "ne",
            )

        if kod not in self.reported:
            return
        if udalost["action"] and udalost["action"] not in self.actions:
            return

        if not self.cooldown.povoleno(serial, kod, time.time()):
            return

        snimek = stahni_snimek(self.opener, self.kamera["lan_ip"])
        posli_detekci(self.kamera, udalost, snimek)


# ── Konfigurace z portálu ────────────────────────────────────────


def nacti_kamery() -> list[dict] | None:
    """
    Seznam stavebních kamer. None = portál nedostupný.

    Rozdíl proti prázdnému seznamu je podstatný: při výpadku portálu se
    běžící vlákna NESMÍ pozavírat. Kamera hlásí dál a detekce se ztratí
    až tou nedoručenou zprávou, ne tím, že přestaneme poslouchat.
    """
    try:
        odpoved = portal.signed_get("/api/relay/cameras")
    except PortalError as exc:
        log.warning("Konfiguraci se nepodařilo stáhnout: %s", exc)
        return None

    kamery = [k for k in odpoved.get("cameras", []) if k.get("lan_ip")]
    chybi = odpoved.get("incomplete", 0)
    if chybi:
        log.warning(
            "Portál hlásí %d kamer bez adresy nebo sériového čísla — ty se neobsluhují",
            chybi,
        )
    return kamery


def klic_kamery(kamera: dict) -> tuple:
    """Co znamená „jiná kamera“. Změna adresy vyžaduje nové spojení."""
    return (kamera["serial_number"], kamera["lan_ip"])


def main() -> int:
    if not portal.PORTAL_URL or not portal.RELAY_SECRET:
        log.error("Chybí PORTAL_URL nebo RELAY_SECRET — služba se nespustí.")
        return 2
    if not CAMERA_PASSWORD:
        log.error("Chybí CAMERA_PASSWORD — bez něj kamera spojení nepovolí.")
        return 2

    log.info(
        "Sky Guard události: hlásí se %s, odebírá se [%s]",
        REPORTED_CODES,
        SUBSCRIBE_CODES,
    )

    # Fronta klipů: nezapisovatelná se jinak pozná až tím, že klipy
    # prostě nejsou — služba přitom běží a detekce chodí dál.
    duvod = klipy.fronta_je_zapisovatelna(KLIPY_FRONTA)
    if duvod:
        log.error(
            "Do fronty klipů (%s) SE NEDÁ ZAPSAT: %s. Detekce půjdou "
            "dál, ale žádný klip nevznikne. Obvykle je to svazek, který "
            "vyrobil Docker jako root — kontejner běží pod uid 10001.",
            KLIPY_FRONTA, duvod,
        )
    else:
        log.info("Fronta klipů: %s", KLIPY_FRONTA)

    stop = threading.Event()
    cooldown = Cooldown(COOLDOWN_SEC)
    bezici: dict[tuple, tuple[CameraWorker, threading.Event]] = {}

    try:
        while True:
            kamery = nacti_kamery()

            if kamery is not None:
                chtene = {klic_kamery(k): k for k in kamery}

                for klic, (vlakno, vlastni_stop) in list(bezici.items()):
                    if klic not in chtene or not vlakno.is_alive():
                        vlastni_stop.set()
                        del bezici[klic]
                        log.info("Kamera %s odpojena", klic[0])

                for klic, kamera in chtene.items():
                    if klic in bezici:
                        continue
                    vlastni_stop = threading.Event()
                    vlakno = CameraWorker(kamera, cooldown, vlastni_stop)
                    vlakno.start()
                    bezici[klic] = (vlakno, vlastni_stop)
                    log.info(
                        "Kamera %s (%s) na %s",
                        kamera["name"],
                        kamera.get("site_name", "?"),
                        kamera["lan_ip"],
                    )

                if not bezici:
                    log.warning("Žádná stavební kamera k obsluze")

            # Hlídači se hlásí jen běžící obsluha. Služba, která má
            # nula vláken, je ticho — a ticho je přesně to, co má
            # hlídač poznat.
            portal.ping_healthcheck(HEALTHCHECK_URL, bool(bezici))

            if ONCE:
                return 0
            if stop.wait(CONFIG_REFRESH_SEC):
                return 0
    except KeyboardInterrupt:
        log.info("Končím.")
        return 0
    finally:
        for _, (_, vlastni_stop) in bezici.items():
            vlastni_stop.set()


if __name__ == "__main__":
    sys.exit(main())
