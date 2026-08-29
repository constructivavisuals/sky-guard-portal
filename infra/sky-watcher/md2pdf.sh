#!/usr/bin/env bash
# MONTAZ.md → MONTAZ.pdf, na stavbu do ruky.
#
#   ./md2pdf.sh                 MONTAZ.md → MONTAZ.pdf
#   ./md2pdf.sh soubor.md       jiný vstup, PDF vedle něj
#
# ═══ Proč vlastní převod ═══════════════════════════════════════════
# pandoc ani wkhtmltopdf na stroji nejsou a instalovat kvůli jednomu
# dokumentu LaTeX je nepřiměřené. Chrome ale umí tisknout do PDF a je
# tu tak jako tak — takže: Markdown → HTML → tisk.
#
# Převádí se PODMNOŽINA Markdownu, kterou MONTAZ.md používá: nadpisy,
# tabulky, bloky kódu, citace, seznamy, oddělovače, tučné a `kód`.
# Není to obecný převodník a nemá se jím stát — kdyby dokument začal
# potřebovat víc, je to signál sáhnout po hotovém nástroji, ne tenhle
# skript nafukovat.
#
# ═══ Sazba je pro STAVBU ═══════════════════════════════════════════
# Čte se to v ruce, ve světle a špinavýma rukama: větší písmo, tmavý
# text na bílé, tabulky s viditelnou mřížkou. Nadpis se neodtrhne od
# svého odstavce a tabulka ani blok kódu se netrhá přes stránku —
# postup přeťatý uprostřed se na místě čte mizerně.

set -euo pipefail

SKRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
VSTUP="${1:-$SKRIPT_DIR/MONTAZ.md}"
[ -f "$VSTUP" ] || { echo "Není soubor: $VSTUP" >&2; exit 1; }
VYSTUP="${VSTUP%.md}.pdf"

# Chrome, nebo chromium od Playwrightu — jeden z nich na stroji je.
najdi_prohlizec() {
  local kandidati=(
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    "/Applications/Chromium.app/Contents/MacOS/Chromium"
    "$(command -v chromium || true)"
    "$(command -v google-chrome || true)"
  )
  local k
  for k in "${kandidati[@]}"; do
    if [ -n "$k" ] && [ -x "$k" ]; then echo "$k"; return 0; fi
  done
  # Playwright si chromium stahuje k sobě.
  local pw
  pw=$(find "$HOME/Library/Caches/ms-playwright" "$HOME/.cache/ms-playwright" \
        -type f -name "Chromium" -perm -u+x 2>/dev/null | head -1 || true)
  if [ -n "$pw" ]; then echo "$pw"; return 0; fi
  return 1
}

if ! PROHLIZEC=$(najdi_prohlizec); then
  echo "Nenašel jsem Chrome ani Chromium — bez nich se do PDF netiskne." >&2
  exit 1
fi

HTML="$(mktemp -t md2pdf).html"
trap 'rm -f "$HTML"' EXIT

python3 "$SKRIPT_DIR/md2html.py" "$VSTUP" > "$HTML"

"$PROHLIZEC" --headless --disable-gpu --no-pdf-header-footer \
  --print-to-pdf="$VYSTUP" "file://$HTML" >/dev/null 2>&1

[ -s "$VYSTUP" ] || { echo "PDF se nevytvořilo." >&2; exit 1; }
echo "Hotovo: $VYSTUP ($(du -h "$VYSTUP" | cut -f1))"
