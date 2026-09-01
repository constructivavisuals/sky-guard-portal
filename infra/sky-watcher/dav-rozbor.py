#!/usr/bin/env python3
"""
Rozbor DHAV kontejneru — co v .dav skutečně je a co z toho ffmpeg udělá.

═══ K čemu to je ══════════════════════════════════════════════════
Když se záznam nepřehraje a přitom prošel rozpoznaným kontejnerem
(žádné „VNUTIT" v logu), časování sedí a stopa je jedna, je vada
přímo v obrazových datech. Pak je potřeba vědět, čí. Tenhle skript
čte .dav NEZÁVISLE na ffmpegu a porovná, co z téhož souboru vyleze
jeho demuxeru.

═══ Jak DHAV vypadá ═══════════════════════════════════════════════
Soubor je řetěz úseků. Každý má pevnou hlavičku, rozšířenou hlavičku
proměnné délky, náklad a osmibajtovou patku:

  'DHAV' typ subtyp kanál PODČÍSLO číslo(4) délka(4) datum(4)   = 20 B
  značka(2) délka_ext(1) kontrola(1)                            =  4 B
  rozšířená hlavička                                  = délka_ext B
  náklad                            = délka - 32 - délka_ext B
  'dhav' zpět(4)                                                =  8 B

`délka` počítá celý úsek včetně patky, takže další 'DHAV' leží
přesně na začátek + délka. Na tom se dá rámování ověřit.

═══ Co se hledá ═══════════════════════════════════════════════════
Dvě věci, obě vidět ve zdrojáku demuxeru (libavformat/dhav.c):

1. PODČÍSLO ÚSEKU (frame_subnumber) se načte do struktury a pak se
   NIKDE nepoužije. Když kamera rozdělí jeden snímek do víc úseků —
   u 4K I-snímků běžné — udělá z každého demuxer samostatný paket
   a muxer samostatný vzorek MP4. Dekodér pak dostane kus řezu:
   „error while decoding MB x y, bytestream -5".

2. VŠECHNO, CO NENÍ 0xf0, JDE DO OBRAZU:
       stream_index = dhav->type == 0xf0 ? audio : video;
   Když kamera pošle úsek jiného typu (metadata, analytika), přistane
   jeho obsah uprostřed H.264 streamu jako by to byl obraz.

Obojí vyrobí platné MP4 se správným časováním a rozbitým obrazem.
Který z toho to je, řekne až skutečný soubor — proto tenhle skript.

═══ Bez závislostí ════════════════════════════════════════════════
Standardní knihovna, stejně jako watcher. ffmpeg jen na porovnání
a bez něj se zbytek stejně dopočítá.
"""

from __future__ import annotations

import argparse
import subprocess
import sys
from collections import Counter
from pathlib import Path

MAGIC = b"DHAV"
PATKA = b"dhav"

# Typy úseků, které demuxer zná. Cokoli mimo tenhle výčet (kromě 0xf0)
# spadne do obrazové stopy.
TYPY = {
    0xFD: "obraz, klíčový snímek",
    0xFC: "obraz, mezisnímek",
    0xF0: "zvuk",
    0xF1: "přeskakuje se (demuxer ho zahazuje)",
}

# Typy, které demuxer pošle do obrazové stopy.
JAKO_OBRAZ = lambda typ: typ != 0xF0 and typ != 0xF1  # noqa: E731


class Usek:
    __slots__ = ("pozice", "typ", "podcislo", "cislo", "delka",
                 "ext", "naklad_od", "naklad_delka", "zacatek_nalu")

    def __init__(self, **kw):
        for k, v in kw.items():
            setattr(self, k, v)


def start_code(b: bytes) -> bool:
    """Začíná náklad startovací značkou Annex-B? První úsek snímku ano."""
    return b[:4] == b"\x00\x00\x00\x01" or b[:3] == b"\x00\x00\x01"


def projdi(cesta: Path) -> tuple[list[Usek], list[str]]:
    """Projde celý soubor po úsecích. Vrací úseky a nálezy o rámování."""
    velikost = cesta.stat().st_size
    useky: list[Usek] = []
    potize: list[str] = []

    with cesta.open("rb") as f:
        # Soubory z novějších Dahua začínají blokem 'DAHUA' o 0x400 B.
        hlava = f.read(5)
        pozice = 0x400 if hlava == b"DAHUA" else 0
        f.seek(pozice)

        while pozice + 24 <= velikost:
            f.seek(pozice)
            hlavicka = f.read(24)
            if len(hlavicka) < 24:
                break

            if hlavicka[:4] != MAGIC:
                # Rámování se rozešlo: hledá se další značka, jako to
                # dělá demuxer (bajt po bajtu). Kolik se přitom zahodí,
                # je to podstatné číslo.
                dalsi = najdi_magic(f, pozice, velikost)
                if dalsi is None:
                    potize.append(
                        f"na {pozice} není 'DHAV' a další už v souboru "
                        f"není — konec čtení, {velikost - pozice} B se zahodilo"
                    )
                    break
                potize.append(
                    f"na {pozice} není 'DHAV'; nejbližší je na {dalsi}, "
                    f"mezi tím {dalsi - pozice} B mimo rámec"
                )
                pozice = dalsi
                continue

            typ = hlavicka[4]
            podcislo = hlavicka[7]
            cislo = int.from_bytes(hlavicka[8:12], "little")
            delka = int.from_bytes(hlavicka[12:16], "little")

            if delka < 24 or pozice + delka > velikost:
                potize.append(
                    f"úsek na {pozice} hlásí délku {delka}, což se do "
                    f"souboru nevejde — čtení končí"
                )
                break

            if typ == 0xF1:
                useky.append(Usek(pozice=pozice, typ=typ, podcislo=podcislo,
                                  cislo=cislo, delka=delka, ext=0,
                                  naklad_od=0, naklad_delka=0,
                                  zacatek_nalu=False))
                pozice += delka
                continue

            ext = hlavicka[22]
            naklad_od = pozice + 24 + ext
            naklad_delka = delka - 32 - ext

            if naklad_delka < 0:
                potize.append(
                    f"úsek na {pozice}: délka {delka} a rozšířená "
                    f"hlavička {ext} dávají záporný náklad"
                )
                break

            f.seek(naklad_od)
            prvni = f.read(4)

            # Patka: 'dhav' + kolik zpět. Kdyby neseděla, rámování je
            # jinde, než hlavička tvrdí.
            f.seek(pozice + delka - 8)
            patka = f.read(8)
            if patka[:4] != PATKA:
                potize.append(
                    f"úsek na {pozice}: na konci není 'dhav', ale "
                    f"{patka[:4]!r} — délka {delka} nesedí"
                )
            else:
                zpet = int.from_bytes(patka[4:8], "little")
                if zpet != delka - 8:
                    potize.append(
                        f"úsek na {pozice}: patka ukazuje {zpet} zpět, "
                        f"čekalo se {delka - 8}"
                    )

            useky.append(Usek(pozice=pozice, typ=typ, podcislo=podcislo,
                              cislo=cislo, delka=delka, ext=ext,
                              naklad_od=naklad_od, naklad_delka=naklad_delka,
                              zacatek_nalu=start_code(prvni)))
            pozice += delka

    return useky, potize


def najdi_magic(f, od: int, velikost: int) -> int | None:
    """Nejbližší 'DHAV' od dané pozice. Po blocích, ať to nesežere paměť."""
    blok = 1 << 20
    pozice = od
    zbytek = b""
    while pozice < velikost:
        f.seek(pozice)
        data = zbytek + f.read(blok)
        i = data.find(MAGIC)
        if i != -1:
            return pozice - len(zbytek) + i
        if len(data) < 4:
            return None
        zbytek = data[-3:]
        pozice += blok
    return None


def vypis_elementarni(cesta: Path, useky: list[Usek], cil: Path) -> None:
    """Náklady obrazových úseků za sebe — to, co dostane dekodér."""
    with cesta.open("rb") as f, cil.open("wb") as out:
        for u in useky:
            if not JAKO_OBRAZ(u.typ) or u.naklad_delka <= 0:
                continue
            f.seek(u.naklad_od)
            zbyva = u.naklad_delka
            while zbyva > 0:
                kus = f.read(min(zbyva, 1 << 20))
                if not kus:
                    break
                out.write(kus)
                zbyva -= len(kus)


def porovnej_s_ffmpegem(cesta: Path, muj: Path) -> str:
    """
    Týž soubor přes demuxer ffmpegu, bajt po bajtu proti našemu čtení.

    Shoda znamená, že se náklady čtou stejně — vada tedy není v tom,
    KTERÉ bajty demuxer bere, ale JAK je rámuje do paketů.
    """
    try:
        proc = subprocess.run(
            ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
             "-i", str(cesta), "-map", "0:v:0", "-c", "copy",
             "-f", "h264", "-"],
            capture_output=True, timeout=1800, check=False,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        return f"  ffmpeg se nepodařilo spustit: {exc}"

    if proc.returncode != 0:
        return "  ffmpeg skončil chybou: " + (proc.stderr.decode("utf-8", "replace")[:300])

    jeho = proc.stdout
    nas = muj.read_bytes()
    if jeho == nas:
        return (f"  shoda, {len(nas)} B — demuxer bere tytéž bajty.\n"
                f"  Vada tedy NENÍ ve výběru dat, ale v jejich rámování "
                f"do paketů.")

    # Kde se to rozejde: to místo je vodítko.
    n = min(len(jeho), len(nas))
    kde = next((i for i in range(n) if jeho[i] != nas[i]), n)
    return (f"  ROZCHÁZÍ SE na bajtu {kde} (ffmpeg {len(jeho)} B, "
            f"rozbor {len(nas)} B) — demuxer čte jiná data než hlavička "
            f"kontejneru popisuje")


def main() -> int:
    ap = argparse.ArgumentParser(description="Rozbor DHAV kontejneru")
    ap.add_argument("soubor", type=Path)
    ap.add_argument("--vypis", type=Path,
                    help="kam uložit elementární stream (jinak dočasně)")
    ap.add_argument("--bez-ffmpegu", action="store_true",
                    help="vynechá porovnání s demuxerem ffmpegu")
    args = ap.parse_args()

    if not args.soubor.is_file():
        print(f"Soubor neexistuje: {args.soubor}")
        return 2

    useky, potize = projdi(args.soubor)
    if not useky:
        print("V souboru se nenašel jediný úsek DHAV — tohle není .dav.")
        return 2

    velikost = args.soubor.stat().st_size
    print(f"\n{args.soubor.name}  ({velikost / 1_048_576:.1f} MB)")
    print("=" * 66)

    # ── 1. Z čeho se soubor skládá ────────────────────────────────
    typy = Counter(u.typ for u in useky)
    print(f"\nÚseků celkem: {len(useky)}")
    for typ, kolik in typy.most_common():
        popis = TYPY.get(typ, "NEZNÁMÝ TYP")
        znak = "" if typ in TYPY else "   ← nezná ho ani demuxer"
        print(f"  0x{typ:02x}  {kolik:>7}×  {popis}{znak}")

    # ── 2. Co z toho spadne do obrazu ─────────────────────────────
    cizi = [u for u in useky if JAKO_OBRAZ(u.typ) and u.typ not in (0xFD, 0xFC)]
    print("\n[1] Co demuxer pošle do OBRAZOVÉ stopy")
    if cizi:
        bajtu = sum(u.naklad_delka for u in cizi)
        print(f"  NÁLEZ: {len(cizi)} úseků, které nejsou obraz ani zvuk,")
        print(f"  skončí v obrazové stopě ({bajtu} B). Demuxer posílá do")
        print(f"  obrazu všechno, co není 0xf0 — jejich obsah se dekóduje")
        print(f"  jako H.264, protože nic jiného ffmpeg nezná.")
        print(f"  Typy: {sorted({hex(u.typ) for u in cizi})}")
    else:
        print("  Čisté: obrazová stopa dostane jen úseky 0xfd/0xfc.")

    # ── 3. Dělené snímky ──────────────────────────────────────────
    obraz = [u for u in useky if u.typ in (0xFD, 0xFC)]
    pokracovani = [u for u in obraz if not u.zacatek_nalu]
    podcisla = Counter(u.podcislo for u in obraz)

    print("\n[2] Dělené snímky (podčíslo úseku)")
    print(f"  Obrazových úseků: {len(obraz)}")
    print(f"  Rozdělení podčísel: "
          f"{dict(sorted(podcisla.items())[:8])}"
          f"{' …' if len(podcisla) > 8 else ''}")
    if pokracovani:
        podil = 100.0 * len(pokracovani) / len(obraz)
        print(f"  NÁLEZ: {len(pokracovani)} úseků ({podil:.1f} %) NEZAČÍNÁ")
        print(f"  startovací značkou Annex-B. To jsou pokračování snímku,")
        print(f"  který kamera rozdělila do víc úseků.")
        print(f"  Demuxer podčíslo ignoruje, takže z každého udělá")
        print(f"  samostatný paket a muxer samostatný vzorek MP4.")
        print(f"  Dekodér pak dostane useknutý řez — přesně to hlásí")
        print(f"  „bytestream -5\".")
        print(f"  Skutečných snímků je tedy {len(obraz) - len(pokracovani)}, "
              f"ne {len(obraz)}.")
    else:
        print("  Čisté: každý obrazový úsek začíná novým snímkem.")

    # ── 4. Rámování ───────────────────────────────────────────────
    print("\n[3] Rámování kontejneru")
    pokryto = sum(u.delka for u in useky)
    print(f"  Úseky pokrývají {pokryto} z {velikost} B "
          f"({100.0 * pokryto / velikost:.2f} %)")
    if potize:
        print(f"  NÁLEZ: {len(potize)} nesrovnalostí:")
        for radek in potize[:10]:
            print(f"    - {radek}")
        if len(potize) > 10:
            print(f"    … a dalších {len(potize) - 10}")
    else:
        print("  Čisté: délky i patky sedí, žádný bajt nevypadl z rámce.")

    # ── 5. Proti ffmpegu ──────────────────────────────────────────
    print("\n[4] Proti demuxeru ffmpegu")
    if args.bez_ffmpegu:
        print("  přeskočeno")
    else:
        cil = args.vypis or args.soubor.with_suffix(".rozbor.h264")
        vypis_elementarni(args.soubor, useky, cil)
        print(porovnej_s_ffmpegem(args.soubor, cil))
        if not args.vypis:
            cil.unlink(missing_ok=True)
        else:
            print(f"  elementární stream uložen: {cil}")

    # ── Závěr ─────────────────────────────────────────────────────
    print("\n" + "=" * 66)
    if pokracovani:
        print("ZÁVĚR: snímky jsou dělené do víc úseků a demuxer to")
        print("neskládá zpátky. To je ta vada v obrazových datech.")
    elif cizi:
        print("ZÁVĚR: do obrazové stopy padají cizí úseky. To je ta vada.")
    elif potize:
        print("ZÁVĚR: rozešlo se rámování kontejneru — viz [3].")
    else:
        print("ZÁVĚR: kontejner je čistý. Vada je jinde než v přebalení;")
        print("na řadě je porovnání s obrazem přímo z RTSP.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
