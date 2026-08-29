#!/usr/bin/env python3
"""
Test převodu Markdownu pro tisk.

    python3 infra/sky-watcher/test/test_md2html.py

Proč to má test: chyba v převodu se v PDF pozná jako „nějak divně to
vypadá“, a to typicky až na stavbě, kde s tím nikdo nic neudělá.
Rozsekaný blok kódu přitom vypadá jako platný příkaz.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from md2html import prevod  # noqa: E402


def main() -> int:
    chyby = []

    def zkontroluj(popis: str, podminka: bool, detail: str = "") -> None:
        if podminka:
            print(f"ok    {popis}")
        else:
            print(f"FAIL  {popis} {detail}")
            chyby.append(popis)

    # ── Základní bloky ─────────────────────────────────────────────
    zkontroluj("nadpis", prevod("## Nadpis") == "<h2>Nadpis</h2>")
    zkontroluj("oddělovač", prevod("---") == "<hr>")
    zkontroluj("tučné", "<strong>ano</strong>" in prevod("text **ano** dál"))
    zkontroluj("inline kód", "<code>ls</code>" in prevod("spusť `ls` a čekej"))
    # Cesty v menu kamery jsou v MONTAZ.md kurzívou. Bez převodu
    # zůstaly na papíře syrové hvězdičky.
    zkontroluj("kurzíva",
               prevod("*Nastavení → Video*") == "<p><em>Nastavení → Video</em></p>",
               prevod("*Nastavení → Video*"))
    zkontroluj("kurzíva nerozebere tučné",
               prevod("**tučné**") == "<p><strong>tučné</strong></p>",
               prevod("**tučné**"))
    zkontroluj("násobení hvězdičkou v kódu se nepoplete",
               "<em>" not in prevod("`a * b * c`"), prevod("`a * b * c`"))
    zkontroluj("ani dvě hvězdičky v kódu",
               "<strong>" not in prevod("`glob **/*.mp4 tady`"),
               prevod("`glob **/*.mp4 tady`"))
    zkontroluj("odkaz mimo kód pořád funguje",
               '<a href="MONTAZ.md">postup</a>' in prevod("[postup](MONTAZ.md)"))

    # ── Tabulka ────────────────────────────────────────────────────
    tabulka = prevod("| A | B |\n|---|---|\n| 1 | 2 |")
    zkontroluj("tabulka má hlavičku", "<th>A</th>" in tabulka)
    zkontroluj("tabulka má tělo", "<td>1</td>" in tabulka, tabulka)

    # ── Blok kódu ──────────────────────────────────────────────────
    blok = prevod("```bash\necho ahoj\n```")
    zkontroluj("blok kódu", "<pre><code>echo ahoj</code></pre>" == blok, blok)

    # Odsazený uvnitř seznamu. Tohle se předtím NEROZPOZNALO a inline
    # pravidlo pro `kód` z toho udělalo nesmysl.
    odsazeny = prevod("- položka\n\n  ```bash\n  echo ahoj\n  ```")
    zkontroluj("odsazený blok kódu se rozpozná",
               "<pre><code>echo ahoj</code></pre>" in odsazeny, odsazeny)
    zkontroluj("a nezůstane v něm syrový plot",
               "```" not in odsazeny, odsazeny)

    # ── Citace ─────────────────────────────────────────────────────
    citace = prevod("> **Pozor.**\n> Druhý řádek.")
    zkontroluj("citace spojí řádky",
               "<blockquote>" in citace and "Druhý řádek" in citace, citace)

    # Blok kódu UVNITŘ citace — MONTAZ.md to používá u pravidla iptables.
    vcitace = prevod("> Text:\n>\n> ```bash\n> iptables -I DOCKER-USER\n> ```")
    zkontroluj("blok kódu v citaci se převede",
               "<pre><code>iptables -I DOCKER-USER</code></pre>" in vcitace, vcitace)
    zkontroluj("a nezůstane v něm syrový plot",
               "```" not in vcitace, vcitace)

    # ── Escapování ─────────────────────────────────────────────────
    # `<IP-stavby>` by jinak zmizelo do neexistující značky a v PDF by
    # chyběl kus příkazu.
    esc = prevod("```\nfoo <IP-stavby> bar\n```")
    zkontroluj("ostré závorky v kódu přežijí", "&lt;IP-stavby&gt;" in esc, esc)
    zkontroluj("ampersand se escapuje", "&amp;&amp;" in prevod("```\na && b\n```"))

    # ── Seznam ─────────────────────────────────────────────────────
    seznam = prevod("- první\n- druhý")
    zkontroluj("odrážky", seznam == "<ul><li>první</li><li>druhý</li></ul>", seznam)
    cislovany = prevod("1. první\n2. druhý")
    zkontroluj("číslovaný seznam", cislovany.startswith("<ol>"), cislovany)

    # ── Celý dokument ──────────────────────────────────────────────
    montaz = Path(__file__).resolve().parents[1] / "MONTAZ.md"
    if montaz.exists():
        vysledek = prevod(montaz.read_text(encoding="utf-8"))
        import re

        bez_kodu = re.sub(r"<pre>.*?</pre>", "", vysledek, flags=re.S)
        zkontroluj("v MONTAZ.md nezůstal nepřevedený plot",
                   "```" not in bez_kodu)
        zkontroluj("ani nepřevedené tučné", "**" not in bez_kodu)
        zkontroluj("ani osamocené hvězdičky kurzívy",
                   not re.search(r"\*[^*\n]+\*", bez_kodu))
        zkontroluj("ani řádek tabulky",
                   not re.search(r"^\|", bez_kodu, flags=re.M))
        # Ne na přesné znění nadpisu — to se mění podle toho, co zrovna
        # platí. Kontroluje se, že sekce v PDF vůbec je: je to nastavení,
        # které se na místě dělá jednou a zpětně se ověřuje mizerně.
        zkontroluj("sekce o kodeku je uvnitř",
                   re.search(r"<h3>Kodek:[^<]*</h3>", vysledek) is not None)

    if chyby:
        print(f"\nSELHALO {len(chyby)} kontrol")
        return 1
    print("\nVŠECHNY TESTY PROŠLY")
    return 0


if __name__ == "__main__":
    sys.exit(main())
