#!/usr/bin/env python3
"""
Markdown → HTML pro tisk montážního postupu.

    python3 md2html.py MONTAZ.md > montaz.html

Vlastní soubor, ne heredoc uvnitř md2pdf.sh: takhle se to dá otestovat
a chyba v převodu se pozná dřív než v PDF, kde se špatně rozpoznaná
tabulka pozná jako „nějak divně vypadá“.

═══ Podmnožina, ne Markdown ═══════════════════════════════════════
Umí to, co MONTAZ.md používá: nadpisy, tabulky, bloky kódu, citace,
seznamy, oddělovače, tučné, *kurzívu*, `kód` a odkazy. Kdyby dokument potřeboval
víc, je to signál sáhnout po hotovém nástroji, ne tenhle převodník
nafukovat.

═══ Escapuje se PRVNÍ ═════════════════════════════════════════════
Vstup je náš vlastní dokument, ne cizí vstup, ale i tak: `<` v ukázce
konfigurace by jinak zmizel do neexistující značky a v PDF by chyběl
kus příkazu. To je přesně ta chyba, která se najde až na stavbě.
"""

from __future__ import annotations

import html
import re
import sys

# Značky, na kterých odstavec končí.
ZNACKA = re.compile(r"^(#{1,4}\s|\s*```|\||>|---$|\s*([-*]|\d+\.)\s)")
POLOZKA = re.compile(r"^\s*([-*]|\d+\.)\s+")
ODDELOVAC = re.compile(r"^\|[\s:|-]+\|?$")
# Blok kódu smí být odsazený — uvnitř položky seznamu to tak MONTAZ.md
# používá. Bez zachycení odsazení by se fence nepoznal a inline pravidlo
# pro `kód` by ho rozsekalo na nesmysl.
PLOT = re.compile(r"^(\s*)```")

STYL = """
@page { size: A4; margin: 16mm 15mm 18mm; }
body { font: 11.5pt/1.55 -apple-system, "Helvetica Neue", Arial, sans-serif;
       color: #111; }
h1 { font-size: 22pt; margin: 0 0 4mm; }
h2 { font-size: 15pt; margin: 9mm 0 3mm; padding-bottom: 1.5mm;
     border-bottom: 1.5px solid #111; }
h3 { font-size: 12.5pt; margin: 6mm 0 2mm; }
h4 { font-size: 11.5pt; margin: 5mm 0 2mm; }
/* Nadpis se nesmí odtrhnout od toho, co uvozuje. */
h1, h2, h3, h4 { break-after: avoid; page-break-after: avoid; }
p, li { margin: 0 0 2.5mm; }
code { font: 10pt/1.4 ui-monospace, Menlo, monospace;
       background: #f0f0f0; padding: 0.4mm 1mm; border-radius: 1mm; }
pre { background: #f6f6f6; border: 1px solid #ddd; border-radius: 1.5mm;
      padding: 3mm; white-space: pre-wrap; overflow-wrap: break-word;
      break-inside: avoid; page-break-inside: avoid; }
pre code { background: none; padding: 0; font-size: 9.5pt; }
table { border-collapse: collapse; width: 100%; margin: 3mm 0 4mm;
        break-inside: avoid; page-break-inside: avoid; }
th, td { border: 1px solid #999; padding: 2mm 2.5mm; text-align: left;
         vertical-align: top; font-size: 10.5pt; }
th { background: #ececec; }
blockquote { margin: 3mm 0; padding: 2.5mm 4mm; background: #f6f6f6;
             border-left: 3px solid #999; break-inside: avoid; }
blockquote > :first-child { margin-top: 0; }
blockquote > :last-child { margin-bottom: 0; }
hr { border: none; border-top: 1px solid #ccc; margin: 7mm 0; }
ul, ol { padding-left: 6mm; margin: 0 0 3mm; }
a { color: #111; }
em { font-style: italic; }
"""


def inline(text: str) -> str:
    """
    Tučné, kurzíva, `kód` a odkazy.

    ═══ Kód se odstíní PRVNÍ ══════════════════════════════════════
    Uvnitř zpětných apostrofů je text doslovný. Kdyby přes něj běžela
    pravidla pro tučné a kurzívu, udělal by z `a * b * c` v příkazu
    kurzívu a na papíře by zmizely hvězdičky — tedy kus příkazu.

    Proto se kódové úseky nejdřív vymění za značky, které v textu být
    nemůžou, a vrátí se až nakonec.
    """
    text = html.escape(text)

    # \x00 v Markdownu nikdy nebude, takže se nemá s čím srazit.
    schovane: list[str] = []

    def schovej(m: re.Match[str]) -> str:
        schovane.append(m.group(1))
        return f"\x00{len(schovane) - 1}\x00"

    text = re.sub(r"`([^`]+)`", schovej, text)

    text = re.sub(r"\*\*([^*]+)\*\*", r"<strong>\1</strong>", text)
    # Kurzíva až po tučném a jen tam, kde hvězdička nestojí u další —
    # jinak by `**text**` rozebrala zevnitř. MONTAZ.md ji používá na
    # cesty v menu kamery (*Nastavení → Kamera → Video*).
    text = re.sub(r"(?<!\*)\*([^*\n]+)\*(?!\*)", r"<em>\1</em>", text)
    text = re.sub(r"\[([^\]]+)\]\(([^)]+)\)", r'<a href="\2">\1</a>', text)

    return re.sub(
        r"\x00(\d+)\x00",
        lambda m: f"<code>{schovane[int(m.group(1))]}</code>",
        text,
    )


def bunky(radek: str) -> list[str]:
    return [b.strip() for b in radek.strip().strip("|").split("|")]


def prevod(zdroj: str) -> str:
    radky = zdroj.split("\n")
    out: list[str] = []
    i, n = 0, len(radky)

    while i < n:
        radek = radky[i]

        # Blok kódu, případně odsazený
        plot = PLOT.match(radek)
        if plot:
            odsazeni = len(plot.group(1))
            i += 1
            telo = []
            while i < n and not PLOT.match(radky[i]):
                kod = radky[i]
                # Odsazení fence se odečte, ať kód v PDF nezačíná
                # zbytečně od poloviny řádku. Jen když je to opravdu
                # mezera — jinak by se ukrojil kus příkazu.
                if odsazeni and kod[:odsazeni].strip() == "":
                    kod = kod[odsazeni:]
                telo.append(html.escape(kod))
                i += 1
            i += 1  # zavírací ```
            out.append("<pre><code>" + "\n".join(telo) + "</code></pre>")
            continue

        # Tabulka: hlavička, oddělovač, řádky
        if radek.startswith("|") and i + 1 < n and ODDELOVAC.match(radky[i + 1]):
            hlavicka = bunky(radek)
            i += 2
            telo_radky = []
            while i < n and radky[i].startswith("|"):
                telo_radky.append(bunky(radky[i]))
                i += 1
            th = "".join(f"<th>{inline(b)}</th>" for b in hlavicka)
            trs = "".join(
                "<tr>" + "".join(f"<td>{inline(b)}</td>" for b in r) + "</tr>"
                for r in telo_radky
            )
            out.append(
                f"<table><thead><tr>{th}</tr></thead><tbody>{trs}</tbody></table>"
            )
            continue

        if radek.strip() == "---":
            out.append("<hr>")
            i += 1
            continue

        nadpis = re.match(r"^(#{1,4})\s+(.*)$", radek)
        if nadpis:
            uroven = len(nadpis.group(1))
            out.append(f"<h{uroven}>{inline(nadpis.group(2))}</h{uroven}>")
            i += 1
            continue

        # Citace — může být na víc řádků a mít uvnitř cokoli
        if radek.startswith(">"):
            telo = []
            while i < n and radky[i].startswith(">"):
                # Jeden `>` a nanejvýš jednu mezeru za ním; zbytek
                # odsazení patří obsahu.
                telo.append(re.sub(r"^>\s?", "", radky[i]))
                i += 1
            # Rekurzivně: v citaci bývá blok kódu, a ten se musí převést
            # stejně jako venku. Sloučit citaci do jednoho odstavce by
            # z něj udělalo rozsekaný nesmysl.
            out.append("<blockquote>" + prevod("\n".join(telo)) + "</blockquote>")
            continue

        # Seznam — položka může pokračovat odsazeným řádkem
        if POLOZKA.match(radek):
            cislovany = bool(re.match(r"^\s*\d+\.", radek))
            polozky: list[str] = []
            while i < n and (
                POLOZKA.match(radky[i])
                or (
                    radky[i].startswith("  ")
                    and radky[i].strip()
                    and polozky
                    # Odsazený blok kódu do položky nepatří — patří za ni.
                    and not PLOT.match(radky[i])
                )
            ):
                if POLOZKA.match(radky[i]):
                    polozky.append(POLOZKA.sub("", radky[i]))
                else:
                    polozky[-1] += " " + radky[i].strip()
                i += 1
            tag = "ol" if cislovany else "ul"
            out.append(
                f"<{tag}>"
                + "".join(f"<li>{inline(p)}</li>" for p in polozky)
                + f"</{tag}>"
            )
            continue

        if not radek.strip():
            i += 1
            continue

        # Odstavec — spojí se, dokud nepřijde prázdný řádek nebo jiná značka
        telo = []
        while i < n and radky[i].strip() and not ZNACKA.match(radky[i]):
            telo.append(radky[i].strip())
            i += 1
        out.append("<p>" + inline(" ".join(telo)) + "</p>")

    return "\n".join(out)


def stranka(telo: str, titulek: str) -> str:
    return (
        "<!doctype html><html lang=cs><meta charset=utf-8>"
        f"<title>{html.escape(titulek)}</title>"
        f"<style>{STYL}</style>\n{telo}\n</html>"
    )


def main() -> int:
    if len(sys.argv) < 2:
        print("Použití: md2html.py soubor.md", file=sys.stderr)
        return 2
    zdroj = open(sys.argv[1], encoding="utf-8").read()
    # Titulek z prvního nadpisu, ať má PDF rozumné jméno v prohlížeči.
    prvni = next((r[2:].strip() for r in zdroj.split("\n") if r.startswith("# ")), "")
    print(stranka(prevod(zdroj), prvni))
    return 0


if __name__ == "__main__":
    sys.exit(main())
