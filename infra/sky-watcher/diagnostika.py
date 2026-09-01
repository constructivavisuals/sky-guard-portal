#!/usr/bin/env python3
"""
Proč se záznam nepřehraje v prohlížeči.

    ./diagnostika.py zaznam.mp4
    ./diagnostika.py zaznam.mp4 --zdroj original.dav

Bere hotové .mp4 z úložiště a hledá důvod, proč ho přehrávač odmítne.
Se `--zdroj` navíc zkusí týž .dav přebalit bez `-tag:v hvc1` a porovná —
tím odliší vadu kamery od vady remuxu.

Bez závislostí, stejně jako watcher: standardní knihovna a ffmpeg.

═══ Na co se ptá ══════════════════════════════════════════════════
Klíčová otázka je, KDE leží parametry streamu (VPS/SPS/PPS). `-tag:v
hvc1` je nechá jen v hlavičce `hvcC` a z jednotlivých vzorků je
VYHODÍ. Když kamera mění parametry za běhu (Dahua Smart Codec), ty
změny se tím zahodí a přehrávač dekóduje podle neplatné hlavičky:

    Chrome  → PIPELINE_ERROR_DECODE, VideoToolbox -12909
    iOS     → často projde, AVFoundation si dekodér přestaví

Proto „na iPhonu to hraje" nestačí jako důkaz, že je soubor v pořádku.
"""

from __future__ import annotations

import argparse
import struct
import subprocess
import sys
import tempfile
from pathlib import Path

# HEVC: typ NAL jednotky je (první_bajt >> 1) & 0x3F
NAL_HEVC = {32: "VPS", 33: "SPS", 34: "PPS", 35: "AUD", 39: "SEI"}
# H.264: typ je první_bajt & 0x1F
NAL_H264 = {7: "SPS", 8: "PPS", 9: "AUD", 6: "SEI", 5: "IDR"}
PARAMETRY = {"VPS", "SPS", "PPS"}


def ffprobe(soubor: Path, pole: str) -> str:
    """Jedno pole ze streamu. Zvlášť schválně — ffprobe si řadí výstup po svém."""
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", f"stream={pole}", "-of", "csv=p=0", str(soubor)],
        capture_output=True, text=True, timeout=60, check=False,
    )
    return (out.stdout or "").strip().splitlines()[0] if out.stdout.strip() else ""


def uroven(kodek: str, syrova: str) -> str:
    """general_level_idc na lidský tvar. HEVC dělí 30, H.264 deset."""
    try:
        n = int(syrova)
    except ValueError:
        return syrova or "?"
    delitel = 30 if kodek == "hevc" else 10
    return f"{n / delitel:.1f}"


def nal_ve_vzorcich(soubor: Path, kodek: str) -> tuple[dict[str, int], int]:
    """
    Typy NAL uložené ve vzorcích (v mdat), ne v hlavičce.

    Vrací i počet různých SPS — víc než jeden znamená, že kamera měnila
    parametry za běhu, a to je přesně případ, který `hvc1` rozbije.
    """
    data = soubor.read_bytes()
    i, zacatek, konec = 0, None, None
    while i < len(data) - 8:
        velikost = struct.unpack(">I", data[i:i + 4])[0]
        if data[i + 4:i + 8] == b"mdat":
            zacatek = i + 8
            konec = i + velikost if velikost > 1 else len(data)
            break
        i += velikost if velikost > 1 else 8
    if zacatek is None:
        return {}, 0

    tabulka = NAL_HEVC if kodek == "hevc" else NAL_H264
    nalezene: dict[str, int] = {}
    sps_varianty: set[bytes] = set()
    p = zacatek
    while p < konec - 4:
        delka = struct.unpack(">I", data[p:p + 4])[0]
        if delka == 0 or p + 4 + delka > konec:
            break
        b = data[p + 4]
        typ = (b >> 1) & 0x3F if kodek == "hevc" else b & 0x1F
        jmeno = tabulka.get(typ, f"typ{typ}")
        nalezene[jmeno] = nalezene.get(jmeno, 0) + 1
        if jmeno == "SPS":
            sps_varianty.add(data[p + 4:p + 4 + delka])
        p += 4 + delka
    return nalezene, len(sps_varianty)


def zkouska_dekodovani(soubor: Path) -> tuple[bool, str]:
    """
    Projede celý soubor dekodérem. Nic nezapisuje, jen sbírá chyby.

    Zahazuje stížnosti výstupního muxeru (`... to muxer`) — ty mluví
    o zápisu do /dev/null, ne o vadě streamu, a braly by se jako
    falešný poplach. Zajímají nás jen hlášky dekodéru.
    """
    proc = subprocess.run(
        ["ffmpeg", "-hide_banner", "-v", "error", "-i", str(soubor), "-f", "null", "-"],
        capture_output=True, text=True, timeout=600, check=False,
    )
    radky = [
        r for r in (proc.stderr or "").splitlines()
        if r.strip() and "to muxer" not in r and not r.startswith("[null @")
    ]
    return not radky, "\n".join(radky)[:600]


def moov_pred_mdat(soubor: Path) -> bool:
    """+faststart: moov musí být před mdat, jinak se čeká na celé stažení."""
    data = soubor.read_bytes()
    m, d = data.find(b"moov"), data.find(b"mdat")
    return m != -1 and (d == -1 or m < d)


def remux_bez_tagu(zdroj: Path, cil: Path) -> bool:
    """
    Týž vstup jako watcher, ale bez -tag:v hvc1 — parametry zůstanou in-band.

    `-an` je stejné jako ve watcheru: pcm_alaw z kamery se do MP4
    nezabalí a bez něj by srovnávací remux spadl na zvuku, ne na obrazu.
    """
    for vstup in ([], ["-f", "hevc"], ["-f", "h264"]):
        proc = subprocess.run(
            ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", *vstup,
             "-i", str(zdroj), "-c", "copy", "-an",
             "-movflags", "+faststart", str(cil)],
            capture_output=True, text=True, timeout=600, check=False,
        )
        if proc.returncode == 0 and cil.exists() and cil.stat().st_size > 0:
            return True
        cil.unlink(missing_ok=True)
    return False


def rozbor(soubor: Path) -> dict:
    kodek = ffprobe(soubor, "codec_name").lower()
    nal, sps_variant = nal_ve_vzorcich(soubor, kodek)
    ok, chyby = zkouska_dekodovani(soubor)
    return {
        "kodek": kodek,
        "tag": ffprobe(soubor, "codec_tag_string"),
        "profil": ffprobe(soubor, "profile"),
        "uroven": uroven(kodek, ffprobe(soubor, "level")),
        "rozliseni": f"{ffprobe(soubor, 'width')}×{ffprobe(soubor, 'height')}",
        "pix_fmt": ffprobe(soubor, "pix_fmt"),
        "fps": ffprobe(soubor, "r_frame_rate"),
        "nal": nal,
        "in_band": bool(PARAMETRY & set(nal)),
        "sps_variant": sps_variant,
        "dekoduje": ok,
        "chyby": chyby,
        "faststart": moov_pred_mdat(soubor),
    }


def vypis(r: dict, soubor: Path) -> None:
    print(f"═══ {soubor.name} ({soubor.stat().st_size / 1_048_576:.1f} MB)")
    print(f"  kodek      {r['kodek']}  (tag {r['tag']})")
    print(f"  profil     {r['profil']} @ L{r['uroven']}")
    print(f"  rozlišení  {r['rozliseni']}  {r['pix_fmt']}  {r['fps']} fps")
    print(f"  NAL        {r['nal'] or 'nepřečteno'}")
    print(f"  parametry  {'in-band' if r['in_band'] else 'jen v hlavičce (hvcC)'}")
    print(f"  faststart  {'ano' if r['faststart'] else 'NE — moov až za mdat'}")
    print(f"  dekóduje   {'ano' if r['dekoduje'] else 'NE'}")
    if r["chyby"]:
        for radek in r["chyby"].splitlines()[:8]:
            print(f"             {radek}")


def verdikt(r: dict, srov: dict | None) -> int:
    """
    Vyhodnocení.

    POZOR na jednu past: ffmpeg je při dekódování shovívavý — když
    parametry chybí, drží si poslední známé a dojede do konce. Chrome
    si postaví VTDecompressionSession jednou z hvcC a na první vzorek
    kódovaný jinak spadne. `dekóduje: ano` tedy NENÍ důkaz, že to
    přehrávač vezme; rozhoduje, jestli parametry v souboru vůbec jsou.
    """
    print("\n═══ Verdikt")

    parametry_pryc = r["kodek"] == "hevc" and r["tag"] == "hvc1" and not r["in_band"]
    # Kolik různých SPS zdroj obsahoval. Ze samotného hvc1 souboru se to
    # zjistit nedá — jsou vyházené. Proto se počítá na srovnávacím remuxu.
    varianty = srov["sps_variant"] if srov else r["sps_variant"]

    if not r["dekoduje"]:
        print("  Stream je vadný — nedojede ani ve ffmpegu.")
        if srov and srov["dekoduje"]:
            print("  Bez `-tag:v hvc1` projde → rozbil to remux, ne kamera.")
            return 1
        if srov:
            print("  Vadný je i bez tagu → vada je ve zdroji z kamery.")
        return 1

    if parametry_pryc and varianty > 1:
        print(f"  ROZBITO REMUXEM. Zdroj má {varianty} různé sady parametrů —")
        print("  kamera je mění za běhu. `-tag:v hvc1` je z vzorků vyhodil")
        print("  a v hvcC zůstala jen ta první. Chrome dekóduje podle")
        print("  neplatné hlavičky → PIPELINE_ERROR_DECODE (-12909).")
        print("  Že to ffmpeg přehraje, nic neznamená — je shovívavý.")
        print("\n  → Ve watcheru ten tag zrušit (nebo přebalovat bez -c copy).")
        return 1

    if parametry_pryc and srov is None:
        print("  Parametry jsou jen v hvcC — `-tag:v hvc1` je z vzorků vyhodil.")
        print("  Jestli to vadí, závisí na tom, jestli je kamera mění za běhu.")
        print("  Pusť znovu s `--zdroj <original.dav>` — bez něj to nerozhodnu.")
        return 1

    if varianty > 1:
        print(f"  Zdroj má {varianty} různé sady parametrů, ale v souboru zůstaly.")
        print("  Tohle přehrávač zvládne.")

    print("  Na souboru vadu nevidím. Příčina bude jinde — Content-Type,")
    print("  podepsaná adresa nebo Range requesty.")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="Proč se záznam nepřehraje v prohlížeči.")
    ap.add_argument("soubor", type=Path, help="hotové .mp4 z úložiště")
    ap.add_argument("--zdroj", type=Path, help="původní .dav — ověří, jestli za to může remux")
    args = ap.parse_args()

    if not args.soubor.is_file():
        print(f"Soubor nenalezen: {args.soubor}", file=sys.stderr)
        return 2

    r = rozbor(args.soubor)
    vypis(r, args.soubor)

    srov = None
    if args.zdroj:
        if not args.zdroj.is_file():
            print(f"\nZdroj nenalezen: {args.zdroj}", file=sys.stderr)
            return 2
        with tempfile.TemporaryDirectory() as tmp:
            srovnani = Path(tmp) / "bez_tagu.mp4"
            if remux_bez_tagu(args.zdroj, srovnani):
                print()
                srov = rozbor(srovnani)
                vypis(srov, srovnani)
            else:
                print("\nPřebalení zdroje bez tagu selhalo — nedá se porovnat.")

    return verdikt(r, srov)


if __name__ == "__main__":
    sys.exit(main())
