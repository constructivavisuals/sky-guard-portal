"use client";

import { useEffect, useState, useSyncExternalStore } from "react";

// Dočasný výpis rozměrů okna — na doladění spodní lišty.
//
// ═══ Proč to měří telefon a ne já ══════════════════════════════════
// Tři pokusy o opravu naslepo minuly, protože jsem příčinu hádal
// z popisu a ze snímku obrazovky. Tohle místo hádání měří.
//
// ═══ Jak se to zapíná ══════════════════════════════════════════════
//   /prehled?ladeni=okno      zapne (drží se do vypnutí)
//   /prehled?ladeni=vypnout   vypne
//   trojí klepnutí kamkoli    přepne
//
// To trojí klepnutí tu je proto, že aplikace na ploše nemá adresní
// řádek — a iOS jí navíc drží úložiště zvlášť od Safari, takže se
// zapnutí v prohlížeči do ní nepropíše. Bez toho se k číslům
// z prvního vykreslení po startu z plochy nedá dostat.
//
// Až lišta sedne, tenhle soubor zmizí.

const KLIC = "sky-guard.ladeni-okna";

// Úložiště je vnější zdroj, takže se čte přes useSyncExternalStore.
// Na serveru vrací false a po hydrataci skutečnou hodnotu — bez
// kaskádového renderu a bez neshody.
const posluchaci = new Set<() => void>();

function odber(zmena: () => void): () => void {
  posluchaci.add(zmena);
  return () => posluchaci.delete(zmena);
}

function stav(): boolean {
  try {
    return localStorage.getItem(KLIC) === "1";
  } catch {
    return false;
  }
}

function nastav(bude: boolean): void {
  try {
    if (bude) localStorage.setItem(KLIC, "1");
    else localStorage.removeItem(KLIC);
  } catch {
    // Zakázané úložiště není důvod, aby ladění shodilo stránku.
  }
  posluchaci.forEach((f) => f());
}

/** Výška, na kterou se prohlížeč zeptá sám — např. `env()` nebo `dvh`. */
function css(vyraz: string): string {
  const prvek = document.createElement("div");
  prvek.style.cssText = `position:fixed;bottom:0;height:${vyraz}`;
  document.body.appendChild(prvek);
  const v = getComputedStyle(prvek).height;
  prvek.remove();
  return v;
}

export function LadeniOkna() {
  const zapnuto = useSyncExternalStore(odber, stav, () => false);
  const [radky, setRadky] = useState<string[]>([]);

  // Zapnutí z adresy a trojím klepnutím. Nesahá na stav Reactu,
  // jen na úložiště — o překreslení se postará odběr výš.
  useEffect(() => {
    const dotaz = new URLSearchParams(window.location.search).get("ladeni");
    if (dotaz === "okno") nastav(true);
    if (dotaz === "vypnout") nastav(false);

    let klepnuti = 0;
    let casovac: ReturnType<typeof setTimeout> | null = null;
    const klep = () => {
      klepnuti += 1;
      if (casovac) clearTimeout(casovac);
      casovac = setTimeout(() => (klepnuti = 0), 800);
      if (klepnuti < 3) return;
      klepnuti = 0;
      nastav(!stav());
    };

    document.addEventListener("pointerdown", klep);
    return () => {
      document.removeEventListener("pointerdown", klep);
      if (casovac) clearTimeout(casovac);
    };
  }, []);

  useEffect(() => {
    if (!zapnuto) return;

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

    // Přes rAF, ne rovnou: přepisovat stav synchronně v efektu si
    // vynutí druhý průchod renderem a React to právem hlídá.
    const prvni = requestAnimationFrame(zmer);
    // Podruhé za vteřinu: kdyby iOS okno přeměřil až po startu, je
    // rozdíl mezi těmi dvěma měřeními ta hledaná odpověď.
    const znovu = setTimeout(zmer, 1000);

    window.visualViewport?.addEventListener("resize", zmer);
    window.addEventListener("resize", zmer);
    return () => {
      cancelAnimationFrame(prvni);
      clearTimeout(znovu);
      window.visualViewport?.removeEventListener("resize", zmer);
      window.removeEventListener("resize", zmer);
    };
  }, [zapnuto]);

  if (!zapnuto || radky.length === 0) return null;

  return (
    <div className="pointer-events-none fixed left-1 top-16 z-[60] bg-black/85 px-2 py-1 font-mono text-[10px] leading-tight text-[var(--accent-bright)] lg:hidden">
      {radky.map((r) => (
        <div key={r}>{r}</div>
      ))}
    </div>
  );
}
