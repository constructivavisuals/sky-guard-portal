"use client";

import { useEffect, useState } from "react";

// Dočasný výpis rozměrů okna — na doladění spodní lišty.
//
// ═══ Proč to je v aplikaci a ne v mém počítači ═════════════════════
// Lišta sedí po startu z plochy výš a po přechodu na jinou stránku se
// srovná. Tři pokusy o opravu naslepo (strop na bezpečnou zónu, pevná
// výška okna, vynucené přeuspořádání) minuly, protože jsem hádal
// příčinu z popisu a ze snímku obrazovky. Tohle místo hádání měří.
//
// ═══ Jak se to pouští ══════════════════════════════════════════════
//   /prehled?ladeni=okno      zapne (drží se do vypnutí)
//   /prehled?ladeni=vypnout   vypne
//
// Zapíná se do úložiště prohlížeče schválně: aplikace startuje na
// `start_url` bez parametrů, takže jinak by se k prvnímu vykreslení
// nedalo dostat.
//
// Až se lišta srovná, tenhle soubor zmizí.

const KLIC = "sky-guard.ladeni-okna";

function css(vlastnost: string): string {
  const prvek = document.createElement("div");
  prvek.style.cssText = `position:fixed;bottom:0;height:${vlastnost}`;
  document.body.appendChild(prvek);
  const v = getComputedStyle(prvek).height;
  prvek.remove();
  return v;
}

export function LadeniOkna() {
  const [radky, setRadky] = useState<string[] | null>(null);

  useEffect(() => {
    const dotaz = new URLSearchParams(window.location.search).get("ladeni");
    if (dotaz === "okno") localStorage.setItem(KLIC, "1");
    if (dotaz === "vypnout") localStorage.removeItem(KLIC);
    if (localStorage.getItem(KLIC) !== "1") return;

    const zmer = () => {
      const nav = document.querySelector("nav[aria-label='Mobilní navigace']");
      const r = nav?.getBoundingClientRect();
      const vv = window.visualViewport;
      setRadky([
        `innerHeight ${window.innerHeight}`,
        `visual ${vv ? Math.round(vv.height) : "?"} @${vv ? Math.round(vv.offsetTop) : "?"}`,
        `screen ${window.screen.height}`,
        `safe-bottom ${css("env(safe-area-inset-bottom)")}`,
        `dvh ${css("100dvh")}`,
        `lišta ${r ? `${Math.round(r.top)}–${Math.round(r.bottom)}` : "?"}`,
      ]);
    };

    zmer();
    // Podruhé za vteřinu: kdyby iOS okno přeměřil až po startu, bude
    // rozdíl mezi těmi dvěma čísly ta hledaná odpověď.
    const znovu = setTimeout(zmer, 1000);
    window.visualViewport?.addEventListener("resize", zmer);
    window.addEventListener("resize", zmer);
    return () => {
      clearTimeout(znovu);
      window.visualViewport?.removeEventListener("resize", zmer);
      window.removeEventListener("resize", zmer);
    };
  }, []);

  if (!radky) return null;

  return (
    <div className="fixed left-1 top-16 z-[60] bg-black/85 px-2 py-1 font-mono text-[10px] leading-tight text-[var(--accent-bright)] lg:hidden">
      {radky.map((r) => (
        <div key={r}>{r}</div>
      ))}
    </div>
  );
}
