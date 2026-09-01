#!/usr/bin/env python3
"""
Sky Guard — hodiny kamer.

═══ Proč vlastní nástroj ═══════════════════════════════════════════
Adresa playbacku nese čas KAMERY. Když jdou její hodiny jinak, ptáme
se na okamžik, který u ní nenastal, a ona odpoví 404 — přestože karta
je plná a zdravá. Změřeno na dvou kamerách z devíti; obě měly přesně
hodinový posun.

Příčina nebyla zóna, ale VYPNUTÝ LETNÍ ČAS. Zóna (UTC+01:00) byla
správná, jenže od konce března do konce října je u nás UTC+02:00.
Kamera tedy poctivě ukazovala zimní čas.

═══ Proč to nespraví ruční přestavení ══════════════════════════════
Protože v říjnu, až letní čas skončí, bude ta samá kamera zase
o hodinu vedle — jen na druhou stranu. A protože bez NTP hodiny
pomalu ujíždějí samy.

Správně je: NTP zapnuté, zóna UTC+01:00, letní čas zapnutý podle
evropského pravidla (poslední neděle v březnu a v říjnu). Pak si
kamera drží čas sama a přechody zvládne bez zásahu.

═══ Jak se to pouští ═══════════════════════════════════════════════
    docker compose exec sky-playback python /app/hodiny.py
    docker compose exec sky-playback python /app/hodiny.py --oprav
    docker compose exec sky-playback python /app/hodiny.py --oprav --kamera BK024...

Bez `--oprav` jen čte a nic nemění.
"""

from __future__ import annotations

import argparse
import re
import sys
import urllib.parse
from datetime import datetime

import events
import playback

# Evropské pravidlo: poslední neděle v březnu 2:00 → poslední neděle
# v říjnu 3:00. U Dahuy se týden 5 rozumí jako „poslední v měsíci"
# a den 1 jako neděle.
LETNI_CAS = {
    "Locales.DSTEnable": "true",
    "Locales.DSTStart.Month": "3",
    "Locales.DSTStart.Week": "5",
    "Locales.DSTStart.Day": "1",
    "Locales.DSTStart.Hour": "2",
    "Locales.DSTStart.Minute": "0",
    "Locales.DSTEnd.Month": "10",
    "Locales.DSTEnd.Week": "5",
    "Locales.DSTEnd.Day": "1",
    "Locales.DSTEnd.Hour": "3",
    "Locales.DSTEnd.Minute": "0",
}

NTP_SERVER = "tik.cesnet.cz"


def cti(lan_ip: str, dotaz: str) -> tuple[str, str]:
    """GET na CGI kamery. Vrací (tělo, chyba)."""
    opener = events.opener_pro(lan_ip)
    try:
        with opener.open(f"http://{lan_ip}{dotaz}", timeout=15) as odpoved:
            return odpoved.read(20_000).decode("utf-8", "replace"), ""
    except Exception as exc:  # noqa: BLE001
        return "", str(exc)[:150]


def hodnota(telo: str, klic: str) -> str | None:
    shoda = re.search(rf"^{re.escape(klic)}=(.*)$", telo, re.MULTILINE)
    return shoda.group(1).strip() if shoda else None


def stav(lan_ip: str) -> dict:
    """Co kamera o čase tvrdí."""
    ven: dict = {}

    telo, chyba = cti(lan_ip, "/cgi-bin/global.cgi?action=getCurrentTime")
    if chyba:
        return {"chyba": chyba}
    shoda = re.search(r"(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})", telo)
    if shoda:
        r, m, d, h, mi, sec = (int(x) for x in shoda.groups())
        ven["cas"] = datetime(r, m, d, h, mi, sec, tzinfo=playback.CAMERA_TZ)

    telo, _ = cti(lan_ip, "/cgi-bin/configManager.cgi?action=getConfig&name=Locales")
    ven["letni_cas"] = hodnota(telo, "table.Locales.DSTEnable")

    telo, _ = cti(lan_ip, "/cgi-bin/configManager.cgi?action=getConfig&name=NTP")
    ven["ntp"] = hodnota(telo, "table.NTP.Enable")
    ven["ntp_server"] = hodnota(telo, "table.NTP.Address")
    # Zóna bývá u NTP, na starších firmwarech u Locales. Bere se, co je.
    ven["zona"] = hodnota(telo, "table.NTP.TimeZone")
    if ven["zona"] is None:
        telo2, _ = cti(
            lan_ip, "/cgi-bin/configManager.cgi?action=getConfig&name=Locales")
        ven["zona"] = hodnota(telo2, "table.Locales.TimeZone")

    return ven


# Zóna, ve které dává evropské pravidlo letního času smysl. U Dahuy
# je to index, ne posun v hodinách — středoevropský čas bývá 1.
ZONA_STREDNI_EVROPA = {"1", "+1", "1.0", "UTC+01:00"}


def oprav(lan_ip: str, zona: str | None) -> tuple[bool, str]:
    """
    Zapne NTP i letní čas. Vrací (povedlo se, popis).

    ═══ Past, kvůli které se kontroluje zóna ══════════════════════
    Kamera, které někdo srovnal čas posunutím ZÓNY na UTC+02:00
    místo zapnutím letního času, ukazuje teď správně. Kdyby se jí
    k tomu letní čas zapnul, sečetlo by se to a byla by o hodinu
    napřed — z fungující kamery by se stala rozbitá.

    Proto se na takovou nesahá a řekne se to nahlas: napřed jí patří
    vrátit zónu na +1, teprve pak letní čas.
    """
    if zona is not None and zona not in ZONA_STREDNI_EVROPA:
        return False, (
            f"zóna je {zona}, ne středoevropská — zapnout k tomu letní čas "
            "by kameru posunulo o hodinu NAPŘED. Srovnej nejdřív zónu "
            "na UTC+01:00."
        )
    parametry = dict(LETNI_CAS)
    parametry["NTP.Enable"] = "true"
    parametry["NTP.Address"] = NTP_SERVER
    parametry["NTP.UpdatePeriod"] = "60"

    dotaz = "/cgi-bin/configManager.cgi?action=setConfig&" + urllib.parse.urlencode(
        parametry
    )
    telo, chyba = cti(lan_ip, dotaz)
    if chyba:
        return False, chyba
    if "OK" not in telo.upper() and "ok" not in telo:
        return False, telo.strip()[:120] or "kamera neodpověděla OK"
    return True, ""


def popis_stavu(s: dict, ted: datetime) -> tuple[str, bool]:
    """Řádek do výpisu a jestli je něco špatně."""
    if s.get("chyba"):
        return f"nedostupná ({s['chyba']})", True

    kusy = []
    spatne = False

    if s.get("cas"):
        rozdil = (s["cas"] - ted).total_seconds()
        kusy.append(f"{s['cas'].strftime('%H:%M:%S')} ({rozdil:+.0f} s)")
        if abs(rozdil) > 60:
            spatne = True
    else:
        kusy.append("čas nepřečten")
        spatne = True

    lc = s.get("letni_cas")
    kusy.append(f"letní čas: {lc or '?'}")
    if lc != "true":
        spatne = True

    ntp = s.get("ntp")
    kusy.append(f"NTP: {ntp or '?'}" + (f" ({s['ntp_server']})" if s.get("ntp_server") else ""))
    if ntp != "true":
        spatne = True

    zona = s.get("zona")
    kusy.append(f"zóna: {zona or '?'}")
    if zona is not None and zona not in ZONA_STREDNI_EVROPA:
        spatne = True

    return "  |  ".join(kusy), spatne


def main() -> int:
    ap = argparse.ArgumentParser(description="Hodiny kamer: kontrola a oprava")
    ap.add_argument("--oprav", action="store_true",
                    help="zapnout NTP a letní čas (bez toho jen čte)")
    ap.add_argument("--kamera", help="sériové číslo; bez něj všechny")
    args = ap.parse_args()

    if not playback.KAMERY.obnov():
        print("Portál nevrátil seznam kamer.")
        return 2

    kamery = list(playback.KAMERY._podle_serialu.values())
    if args.kamera:
        kamery = [k for k in kamery if k.get("serial_number") == args.kamera]
        if not kamery:
            print(f"Kamera {args.kamera} v portálu není.")
            return 2

    ted = datetime.now(playback.CAMERA_TZ)
    print(f"Náš čas: {ted.strftime('%d.%m.%Y %H:%M:%S %Z')}\n")

    spatnych = 0
    for kamera in sorted(kamery, key=lambda k: k.get("name") or ""):
        serial = kamera.get("serial_number", "?")
        lan_ip = kamera.get("lan_ip")
        jmeno = f"{serial}  ({kamera.get('name', '?')})"
        if not lan_ip:
            print(f"{jmeno}\n  bez adresy v LAN\n")
            spatnych += 1
            continue

        radek, spatne = popis_stavu(stav(lan_ip), ted)
        print(f"{jmeno}\n  {radek}")

        if spatne and args.oprav:
            povedlo, chyba = oprav(lan_ip, stav(lan_ip).get("zona"))
            if povedlo:
                # Kamera si čas srovná až po dotazu na NTP; přečte se
                # znovu, ať je vidět, jestli to zabralo.
                novy, _ = popis_stavu(stav(lan_ip), datetime.now(playback.CAMERA_TZ))
                print(f"  → nastaveno; teď: {novy}")
            else:
                print(f"  → NASTAVENÍ SELHALO: {chyba}")
                spatnych += 1
        elif spatne:
            spatnych += 1
        print()

    if spatnych and not args.oprav:
        print(f"Špatně: {spatnych}. Spusť znovu s --oprav.")
        return 1
    if spatnych:
        print(f"Zůstalo špatně: {spatnych}.")
        return 1
    print("Hodiny všech kamer sedí.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
