#!/usr/bin/env python3
"""
Sky Guard — zkouška celé cesty k obrazu, jedním během.

═══ K čemu to je ═══════════════════════════════════════════════════
Cesta od kamery k divákovi má hodně článků a každý z nich umí selhat
tak, že to vypadá jako vada toho vedlejšího. Za sebou to bylo:
kontejner DHAV, zvuk, transport, kódování adresy, vypnutý RTSP modul,
nedosazená zástupná hodnota v šabloně. Pokaždé se hledalo o vrstvu
jinde, než kde to bylo.

Tenhle skript projde tu cestu celou a řekne, KDE STOJÍ:

  1. konfigurace go2rtc   šablona, RTSP modul, zástupné hodnoty
  2. seznam kamer         odpovídá portál a bere náš podpis?
  3. kamera po síti       jde vůbec otevřít spojení na 554?
  4. přímo ffmpegem       dorazí snímek, když jdeme mimo go2rtc?
  5. přes go2rtc          dorazí snímek tou cestou, kterou vidí divák?

Rozdíl mezi 4 a 5 je to podstatné. Když projde 4 a neprojde 5, je vada
v go2rtc nebo v jeho konfiguraci — ne v kameře ani v lince, i když to
tak vypadá. Když neprojde ani 4, dál se nemusí hledat.

Krok 5 měří i ČAS DO PRVNÍHO SNÍMKU. U přehrávání ze záznamu je to
cena jednoho posunu na časové ose, tedy číslo, které se jinak jen
odhaduje.

═══ Jak se pouští ══════════════════════════════════════════════════
Zevnitř sítě kontejnerů, jinak na go2rtc nedosáhne:

    docker compose exec sky-playback python /app/zkouska.py
    docker compose exec sky-playback python /app/zkouska.py --kamera BK024AAPAGB5592
    docker compose exec sky-playback python /app/zkouska.py --rezim zaznam

Nic nemění a nic po sobě nenechává: proud, který si pro zkoušku
založí, zase zruší.
"""

from __future__ import annotations

import argparse
import os
import re
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

import events
import hodiny
import live
import playback

# Živý obraz obsluhuje JINÁ instance go2rtc než záznam — viz README.
GO2RTC_ZIVY = os.environ.get("GO2RTC_API", "http://go2rtc:1984").rstrip("/")
GO2RTC_ZAZNAM = playback.GO2RTC_API

RTSP_PORT = int(os.environ.get("RTSP_PORT", "554"))

# Kolik nejdéle čekat na první snímek, než se to bere za neúspěch.
SNIMEK_TIMEOUT = float(os.environ.get("ZKOUSKA_TIMEOUT_SEC", "30"))

ZELENA, CERVENA, ZLUTA, KONEC = "\033[32m", "\033[31m", "\033[33m", "\033[0m"


class Sesit:
    """Sbírá výsledky a hlídá, jestli něco selhalo."""

    def __init__(self) -> None:
        self.selhalo = 0
        self.preskoceno = 0

    def ok(self, popis: str, detail: str = "") -> None:
        print(f"  {ZELENA}ok{KONEC}    {popis}" + (f"  {detail}" if detail else ""))

    def chyba(self, popis: str, detail: str = "") -> None:
        self.selhalo += 1
        print(f"  {CERVENA}CHYBA{KONEC} {popis}")
        for radek in (detail or "").splitlines()[:4]:
            if radek.strip():
                print(f"        {radek.strip()[:150]}")

    def pozn(self, popis: str) -> None:
        self.preskoceno += 1
        print(f"  {ZLUTA}—{KONEC}     {popis}")


# ── Jeden snímek ─────────────────────────────────────────────────


ROZBOR_STREAMU = re.compile(
    r"Stream #\d+:\d+.*?: Video: (\w+).*?, (\d+)x(\d+)", re.DOTALL
)


def prvni_snimek(url: str, cil: Path) -> tuple[float, str, str]:
    """
    Vytáhne z proudu jeden snímek. Vrací (vteřiny, popis, chyba).

    Měří se čas do PRVNÍHO snímku, ne do konce běhu: to je ta veličina,
    kterou divák cítí jako prodlevu při otevření nebo posunu na ose.

    `-rtsp_transport tcp` vždycky. Přes UDP se obraz změřeně rozpadá
    a zkouška by lhala tím, že projde na něčem, co se pak v provozu
    nepoužívá.

    Běží se na `-loglevel info`, aby ffmpeg vypsal řádek o vstupním
    proudu — kodek a rozlišení jsou přesně to, co se u nasazení
    ověřuje ručně (MONTAZ.md: vedlejší proud, nejvyšší, co linka
    utáhne).
    """
    zacatek = time.monotonic()
    try:
        proc = subprocess.run(
            ["ffmpeg", "-hide_banner", "-loglevel", "info", "-y",
             "-rtsp_transport", "tcp", "-i", url,
             "-frames:v", "1", "-f", "image2", str(cil)],
            capture_output=True, text=True, timeout=SNIMEK_TIMEOUT, check=False,
        )
    except subprocess.TimeoutExpired:
        return SNIMEK_TIMEOUT, "", f"nedorazil snímek do {SNIMEK_TIMEOUT:.0f} s"
    except (OSError, subprocess.SubprocessError) as exc:
        return 0.0, "", f"ffmpeg se nepodařilo spustit: {exc}"

    doba = time.monotonic() - zacatek
    if proc.returncode != 0 or not cil.exists() or cil.stat().st_size == 0:
        # Zajímavé jsou poslední řádky; ty první jsou banner a verze.
        radky = [r for r in (proc.stderr or "").splitlines() if r.strip()]
        return doba, "", "\n".join(radky[-4:]) or "prázdný výsledek"

    shoda = ROZBOR_STREAMU.search(proc.stderr or "")
    popis = f"{shoda.group(1)} {shoda.group(2)}x{shoda.group(3)}" if shoda else ""
    return doba, popis, ""


def snimek_z_go2rtc(api: str, jmeno: str) -> tuple[float, int, str]:
    """
    Týž snímek, ale cestou, kterou vidí divák. Vrací (vteřiny, bajty, chyba).

    `/api/frame.jpeg` je jediná z povolených cest, která projde celou
    obsluhou — zdroj, šablonu, ffmpeg i RTSP modul — a skončí obrázkem,
    který se dá změřit. Websocket by k tomu potřeboval klienta.
    """
    url = f"{api}/api/frame.jpeg?" + urllib.parse.urlencode({"src": jmeno})
    zacatek = time.monotonic()
    try:
        with urllib.request.urlopen(url, timeout=SNIMEK_TIMEOUT) as odpoved:
            telo = odpoved.read()
    except urllib.error.HTTPError as exc:
        duvod = exc.read().decode("utf-8", "replace").strip()[:200]
        return time.monotonic() - zacatek, 0, f"{exc.code}: {duvod}"
    except (urllib.error.URLError, OSError, socket.timeout) as exc:
        return time.monotonic() - zacatek, 0, str(exc)

    doba = time.monotonic() - zacatek
    if len(telo) < 1000 or not telo.startswith(b"\xff\xd8"):
        return doba, len(telo), "odpověď není JPEG"
    return doba, len(telo), ""


# ── Hodiny kamery ────────────────────────────────────────────────


def cas_kamery(lan_ip: str) -> tuple[datetime | None, str]:
    """
    Co si kamera myslí, že je za čas. Vrací (čas, chyba).

    ═══ Proč na tom u záznamu záleží ══════════════════════════════
    Adresa playbacku nese `starttime` v čase KAMERY. Portál i lístky
    počítají v UTC a relay to převádí do zóny lokality — jenže kamera
    se řídí SVÝMI hodinami. Když jdou špatně, ptáme se na okamžik,
    který u ní ještě nenastal (nebo dávno vypadl z karty), a ona
    odpoví 404.

    Zvenčí je to k nerozeznání od „karta nic nemá": kamera odpovídá,
    karta je plná, a přehrávání přesto nejde. Proto se to měří.
    """
    opener = events.opener_pro(lan_ip)
    url = f"http://{lan_ip}/cgi-bin/global.cgi?action=getCurrentTime"
    try:
        with opener.open(url, timeout=10) as odpoved:
            telo = odpoved.read(200).decode("utf-8", "replace")
    except Exception as exc:  # noqa: BLE001
        return None, str(exc)[:120]

    # Odpověď: `result=2026-09-01 21:11:02`. Pořadí se ale mezi
    # firmwary liší podle nastaveného formátu, takže se nespoléhá.
    kdy = hodiny.rozeber_cas(telo)
    if kdy is None:
        return None, f"nesrozumitelná odpověď: {telo.strip()[:60]}"
    return kdy, ""


REZIMY_NAHRAVANI = {
    "0": "podle rozvrhu",
    "1": "nepřetržitě",
    "2": "VYPNUTO",
}


def rezim_nahravani(lan_ip: str) -> tuple[str | None, str]:
    """
    Nahrává kamera na kartu, a jak? Vrací (kód režimu, chyba).

    Druhá otázka po hodinách. Když jdou hodiny dobře a záznam přesto
    není, bývá to tím, že kamera nahrává jen podle rozvrhu — a v tu
    chvíli zrovna nenahrávala.
    """
    opener = events.opener_pro(lan_ip)
    url = (
        f"http://{lan_ip}/cgi-bin/configManager.cgi"
        "?action=getConfig&name=RecordMode"
    )
    try:
        with opener.open(url, timeout=10) as odpoved:
            telo = odpoved.read(500).decode("utf-8", "replace")
    except Exception as exc:  # noqa: BLE001
        return None, str(exc)[:120]

    shoda = re.search(r"RecordMode\[0\]\.Mode=(\d+)", telo)
    if not shoda:
        return None, f"nesrozumitelná odpověď: {telo.strip()[:60]}"
    return shoda.group(1), ""


# `table.Record[0].TimeSection[den][úsek]=1 00:00:00-23:59:59`
# První číslo je zapnuto/vypnuto, za ním rozsah v čase kamery.
#
# Volně schválně: firmwary se liší v počtu cifer i v mezerách a
# u konce dne se objevuje 23:59:59 i 24:00:00.
USEK_RE = re.compile(
    r"TimeSection\[(\d+)\]\[\d+\]\s*=\s*"
    r"(\d)\s+(\d{1,2}):(\d{1,2}):(\d{1,2})\s*-\s*(\d{1,2}):(\d{1,2}):(\d{1,2})"
)


def rozvrh_nahravani(lan_ip: str) -> tuple[set[int] | None, str]:
    """
    Které dny v týdnu kamera nahrává CELÉ. Vrací (dny, chyba).

    ═══ Proč nestačí režim ════════════════════════════════════════
    „Podle rozvrhu" samo o sobě není závada — rozvrh může pokrývat
    celý týden. Ale taky nemusí, a pak má karta díry: přehrávání
    v nich vrátí 404 a časová osa slibuje dny, které tam nejsou.
    Rozdíl mezi tím je právě tenhle dotaz.
    """
    opener = events.opener_pro(lan_ip)
    url = (
        f"http://{lan_ip}/cgi-bin/configManager.cgi"
        "?action=getConfig&name=Record"
    )
    try:
        with opener.open(url, timeout=15) as odpoved:
            telo = odpoved.read(20_000).decode("utf-8", "replace")
    except Exception as exc:  # noqa: BLE001
        return None, str(exc)[:120]

    useky = list(USEK_RE.finditer(telo))
    if not useky:
        # ═══ Nepřečteno NENÍ totéž co nenastaveno ══════════════════
        # Tohle rozlišení tu chybělo a stálo jeden falešný poplach:
        # devět kamer bylo obviněno z prázdného rozvrhu, přestože
        # všem devíti záznam z karty normálně chodil. Vzor prostě
        # nesedl na jejich tvar odpovědi.
        #
        # Když se nedá přečíst, řekne se to — a přiloží se kus toho,
        # co kamera poslala, aby se vzor dal opravit.
        ukazka = " | ".join(
            r.strip() for r in telo.splitlines() if "TimeSection" in r
        )[:200]
        return None, (
            "rozvrh se nepodařilo přečíst"
            + (f"; kamera posílá: {ukazka}" if ukazka else "; bez TimeSection")
        )

    cele: set[int] = set()
    for shoda in useky:
        den = int(shoda.group(1))
        if shoda.group(2) != "1":
            continue
        od = int(shoda.group(3)) * 3600 + int(shoda.group(4)) * 60 + int(shoda.group(5))
        do = int(shoda.group(6)) * 3600 + int(shoda.group(7)) * 60 + int(shoda.group(8))
        # Celý den: od půlnoci nejméně do 23:59. Konec se píše
        # 23:59:59 i 24:00:00, oboje je celý den.
        if od == 0 and do >= 23 * 3600 + 59 * 60:
            cele.add(den)

    return cele, ""


def krok_nahravani(s: Sesit, lan_ip: str) -> None:
    kod, chyba = rezim_nahravani(lan_ip)
    if kod is None:
        s.pozn(f"režim nahrávání se nepodařilo přečíst ({chyba})")
        return

    popis = REZIMY_NAHRAVANI.get(kod, f"neznámý ({kod})")

    if kod == "1":
        s.ok(f"kamera nahrává {popis}")
        return

    if kod != "0":
        s.chyba(
            f"kamera má nahrávání {popis}",
            "na kartu nic nepřibývá, takže přehrávat není co — "
            "viz MONTAZ.md, nahrávání má být nepřetržité",
        )
        return

    # Režim „podle rozvrhu": rozhodne až ten rozvrh.
    dny, chyba = rozvrh_nahravani(lan_ip)
    if dny is None:
        # Poznámka, ne chyba. Že si s odpovědí neporadíme, není vada
        # kamery — a vydávat jedno za druhé je horší než mlčet.
        s.pozn(f"kamera nahrává {popis}; {chyba}")
        return

    if len(dny) >= 7:
        s.ok("kamera nahrává podle rozvrhu, a ten pokrývá celý týden")
        return

    chybi = sorted(set(range(7)) - dny)
    s.chyba(
        f"rozvrh nepokrývá celý týden — celé dny jen {len(dny)} ze 7",
        "v nepokrytých časech na kartě záznam není a přehrávání tam "
        f"vrátí 404 (dny bez celodenního nahrávání: {chybi}; "
        "0 = neděle podle číslování Dahuy)",
    )


def krok_hodiny(s: Sesit, lan_ip: str) -> None:
    """Rozdíl mezi hodinami kamery a našimi, v zóně lokality."""
    kamera, chyba = cas_kamery(lan_ip)
    if kamera is None:
        s.pozn(f"hodiny kamery se nepodařilo přečíst ({chyba})")
        return

    nas = datetime.now(playback.CAMERA_TZ)
    rozdil = (kamera - nas).total_seconds()

    if abs(rozdil) <= 60:
        s.ok(f"hodiny kamery sedí ({kamera.strftime('%H:%M:%S')})",
             f"rozdíl {rozdil:+.0f} s")
        return

    s.chyba(
        f"hodiny kamery jdou o {rozdil / 60:+.0f} min jinak "
        f"(kamera {kamera.strftime('%d.%m. %H:%M:%S')}, my "
        f"{nas.strftime('%d.%m. %H:%M:%S')})",
        "adresa playbacku nese čas KAMERY — na okamžik, který u ní "
        "nenastal, odpoví 404, i když je karta plná. Nastav jí NTP "
        "a správnou časovou zónu.",
    )


# ── Kroky ────────────────────────────────────────────────────────


def krok_konfigurace(s: Sesit) -> None:
    print("\n[1] Konfigurace go2rtc pro záznam")
    nalezy = playback.overit_konfiguraci()
    if not nalezy:
        s.ok("šablona, RTSP modul i zástupné hodnoty sedí")
        return
    for nalez in nalezy:
        s.chyba(nalez)


def krok_kamery(s: Sesit, jen: str | None) -> list[dict]:
    print("\n[2] Seznam kamer z portálu")
    if not playback.KAMERY.obnov():
        s.chyba("portál seznam kamer nevrátil",
                "bez něj se nedá zkoušet nic dalšího")
        return []

    vsechny = list(playback.KAMERY._podle_serialu.values())
    s.ok(f"portál odpověděl a podpis vzal ({len(vsechny)} kamer)")

    if jen:
        vybrane = [k for k in vsechny if k.get("serial_number") == jen]
        if not vybrane:
            s.chyba(f"kamera {jen} v portálu není",
                    "zkontroluj sériové číslo a lokalitu")
        return vybrane
    return vsechny


def krok_kamera(s: Sesit, kamera: dict, rezimy: list[str], pred_sec: int) -> None:
    serial = kamera.get("serial_number", "?")
    lan_ip = kamera.get("lan_ip")
    print(f"\n── {serial}  ({kamera.get('name', '?')})")

    if not lan_ip:
        s.chyba("kamera nemá v portálu vyplněnou adresu v LAN")
        return

    # ── Síť ───────────────────────────────────────────────────────
    zacatek = time.monotonic()
    try:
        with socket.create_connection((lan_ip, RTSP_PORT), timeout=5):
            pass
    except OSError as exc:
        s.chyba(f"spojení na {lan_ip}:{RTSP_PORT} nejde navázat: {exc}",
                "dál se nemá cenu ptát — je to síť nebo tunel, ne go2rtc")
        return
    s.ok(f"kamera odpovídá na {lan_ip}:{RTSP_PORT}",
         f"({(time.monotonic() - zacatek) * 1000:.0f} ms)")

    # Hodiny jen u záznamu — u živého obrazu na nich nezáleží.
    if "zaznam" in rezimy:
        krok_hodiny(s, lan_ip)
        krok_nahravani(s, lan_ip)

    with tempfile.TemporaryDirectory() as tmp:
        for rezim in rezimy:
            if rezim == "zivy":
                url = live.rtsp_url(lan_ip, live.RTSP_SUB_DEFAULT)
                jmeno = f"{serial}_sub"
                api = GO2RTC_ZIVY
                zalozit = False
                stitek = "živý obraz"
            else:
                od = int(time.time()) - pred_sec
                url = playback.playback_url(lan_ip, od)
                jmeno = playback.jmeno_proudu(serial, od)
                api = GO2RTC_ZAZNAM
                zalozit = True
                kdy = datetime.fromtimestamp(od, timezone.utc).astimezone(
                    playback.CAMERA_TZ)
                stitek = f"záznam od {kdy.strftime('%H:%M:%S')}"

            print(f"\n  {stitek}")

            # ── Přímo ffmpegem, mimo go2rtc ───────────────────────
            doba, popis, chyba = prvni_snimek(url, Path(tmp) / f"{rezim}.jpg")

            # ═══ 404 u záznamu ještě nemusí být konec ═════════════
            # `subtype` u playbacku znamená „který proud byl NAHRANÝ".
            # Kamera, která vedlejší na kartu nepíše, na něj odpoví
            # 404 — přestože karta je v pořádku a plná. Zkusí se tedy
            # ten druhý a řekne se, který ta kamera má.
            if chyba and rezim == "zaznam" and "404" in chyba:
                druhy = "1" if playback.PLAYBACK_SUBTYPE == "0" else "0"
                url2 = playback.playback_url(lan_ip, od, subtype=druhy)
                doba2, popis2, chyba2 = prvni_snimek(
                    url2, Path(tmp) / f"{rezim}-2.jpg")
                if not chyba2:
                    s.chyba(
                        f"na subtype={playback.PLAYBACK_SUBTYPE} vrací 404, "
                        f"ale na subtype={druhy} obraz JE",
                        "kamera nahrává na kartu jiný proud než ostatní — "
                        f"nastav jí PLAYBACK_SUBTYPE={druhy}",
                    )
                    url, doba, popis, chyba = url2, doba2, popis2, chyba2
                    jmeno = playback.jmeno_proudu(serial, od)
                else:
                    s.chyba(
                        "na kartě není záznam z té doby (404 na obou proudech)",
                        "kamera odpovídá, ale požadovaný čas na kartě nemá — "
                        "zkontroluj rozvrh nahrávání a dosah karty",
                    )
                    continue

            if chyba:
                s.chyba(f"přímo ffmpegem snímek nedorazil ({doba:.1f} s)", chyba)
                # Přes go2rtc to pak nemá jak fungovat a hláška by jen
                # ukazovala na nesprávné místo.
                continue
            s.ok(f"přímo ffmpegem snímek dorazil za {doba:.1f} s",
                 popis and f"[{popis}]")

            # ── Cestou, kterou vidí divák ─────────────────────────
            zalozeno = False
            if zalozit:
                try:
                    # Ta adresa, která právě prošla — včetně případně
                    # opraveného subtype.
                    playback.zaloz_proud(jmeno, playback.go2rtc_zdroj(url))
                    zalozeno = True
                except RuntimeError as exc:
                    s.chyba("proud se v go2rtc nepodařilo založit", str(exc))
                    continue
            try:
                doba, bajtu, chyba = snimek_z_go2rtc(api, jmeno)
                if chyba:
                    s.chyba(f"přes go2rtc snímek nedorazil ({doba:.1f} s)", chyba)
                    print("        Přímá cesta přitom prošla — vada je"
                          " v go2rtc nebo jeho konfiguraci,")
                    print("        ne v kameře ani v lince.")
                else:
                    s.ok(f"přes go2rtc snímek dorazil za {doba:.1f} s",
                         f"({bajtu // 1024} kB)")
                    if rezim == "zaznam":
                        print(f"        ↳ tolik trvá jeden posun na časové ose")
            finally:
                if zalozeno:
                    try:
                        playback.zrus_proud(jmeno)
                    except RuntimeError:
                        pass


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Zkouška cesty k obrazu: konfigurace → kamera → snímek")
    ap.add_argument("--kamera", help="sériové číslo; bez něj se zkouší všechny")
    ap.add_argument("--rezim", choices=["zivy", "zaznam", "oba"], default="oba")
    ap.add_argument("--pred", type=int, default=600,
                    help="jak daleko zpátky zkoušet záznam, ve vteřinách")
    args = ap.parse_args()

    rezimy = ["zivy", "zaznam"] if args.rezim == "oba" else [args.rezim]
    s = Sesit()

    print("═" * 62)
    print("Zkouška cesty k obrazu")
    print("═" * 62)

    if "zaznam" in rezimy:
        krok_konfigurace(s)

    kamery = krok_kamery(s, args.kamera)
    for kamera in sorted(kamery, key=lambda k: k.get("name") or ""):
        krok_kamera(s, kamera, rezimy, args.pred)

    print("\n" + "═" * 62)
    if s.selhalo:
        print(f"{CERVENA}Selhalo: {s.selhalo}{KONEC}")
        print("Čti odshora — první chyba bývá příčinou těch dalších.")
        return 1
    if not kamery:
        print(f"{ZLUTA}Nezkoušelo se nic — žádná kamera.{KONEC}")
        return 1
    print(f"{ZELENA}Celá cesta prošla.{KONEC}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
