"use client";

import { Check, ChevronDown, LoaderCircle } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useOptimistic, useRef, useState, useTransition } from "react";

import { ALL_SITES, type SiteOption } from "@/lib/site.ts";

import { selectSite } from "./actions.ts";

/**
 * Přepínač lokality.
 *
 * ═══ Odezva hned, data za ní ═══════════════════════════════════════
 * Přepnutí překresluje celý layout i stránku na serveru, a to chvíli
 * trvá. Dřív se mezitím nedělo nic: nabídka visela otevřená, název
 * v liště zůstal starý — a na telefonu to vypadalo, že klepnutí
 * nezabralo. Lidi pak klepli na záložku dole, ta navigace akci
 * předběhla a teprve s ní se lokalita „přepnula".
 *
 * Teď se nabídka zavře hned, v liště je nový název s kolečkem
 * a obsah pod ní ztlumí (viz `data-prepinani` v globals.css), dokud
 * nedorazí nová data. Tlumení je důležité: bez něj by pod novým
 * názvem chvíli stála čísla staré lokality a dala se přečíst jako
 * nová.
 *
 * Akce se volá přímo z klepnutí, ne přes `<form action>`. Formulář
 * uvnitř nabídky se zavřením nabídky odpojil — a s ním odeslání.
 * Bez JS se nabídka stejně neotevře, takže formulář nic nezachraňoval.
 */
export function SiteSwitcher({
  sites,
  selectedId,
  label,
}: {
  sites: SiteOption[];
  selectedId: string | null;
  label: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  // Co uživatel vybral, dokud server nepotvrdí. Po doběhnutí přechodu
  // se samo vrátí na `selectedId` z layoutu — tedy na pravdu.
  const [zobrazeneId, setZobrazeneId] = useOptimistic(selectedId ?? ALL_SITES);
  /** Poslední požadavek, aby šlo poznat, že server odpověděl jinak. */
  const pozadovane = useRef<string | null>(null);
  const disabled = sites.length === 0;

  // ═══ Pojistka ═══════════════════════════════════════════════════
  // Akce vrací rovnou překreslenou stránku. Kdyby po doběhnutí layout
  // pořád hlásil jinou lokalitu (navigace akci přerušila, odpověď se
  // ztratila na slabém signálu), dotáhne se stránka znovu — jednou,
  // ne dokola: lokalita, ke které uživatel nemá přístup, se na serveru
  // tiše vrátí na první viditelnou a víc s tím udělat nejde.
  useEffect(() => {
    if (pending || pozadovane.current === null) return;
    const cil = pozadovane.current;
    pozadovane.current = null;
    if (cil !== (selectedId ?? ALL_SITES)) router.refresh();
  }, [pending, selectedId, router]);

  // Ztlumení obsahu po dobu přepínání. Atribut na <html>, protože
  // obsah je o několik komponent jinde a kontext kvůli jednomu
  // příznaku by byl víc kódu než užitku.
  useEffect(() => {
    if (!pending) return;
    document.documentElement.dataset.prepinani = "";
    return () => {
      delete document.documentElement.dataset.prepinani;
    };
  }, [pending]);

  function vybrat(siteId: string) {
    // Mimo přechod, ať se nabídka zavře hned, ne až s daty.
    setOpen(false);
    if (siteId === (selectedId ?? ALL_SITES) && !pending) return;

    pozadovane.current = siteId;
    startTransition(async () => {
      setZobrazeneId(siteId);
      try {
        await selectSite(siteId);
      } catch {
        // Síť vypadla uprostřed. Cookie se mohla i nemusela nastavit;
        // pojistka výš stránku dotáhne a ukáže, jak to dopadlo.
      }
    });
  }

  const zobrazenyNazev =
    zobrazeneId === ALL_SITES
      ? "Všechny lokality"
      : (sites.find((site) => site.id === zobrazeneId)?.name ?? label);

  return (
    <div className="relative min-w-0">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-busy={pending || undefined}
        className="inline-flex h-10 min-w-0 items-center gap-2 border border-[var(--line-strong)] px-3 text-sm font-medium tracking-tight transition active:bg-[var(--surface-2)] hover:bg-[var(--surface-2)] disabled:pointer-events-none disabled:opacity-60"
      >
        <span className="truncate">{zobrazenyNazev}</span>
        {pending ? (
          <LoaderCircle
            className="h-4 w-4 shrink-0 animate-spin text-[var(--accent-bright)]"
            aria-label="Přepíná se"
          />
        ) : (
          <ChevronDown
            className="h-4 w-4 shrink-0 text-[var(--text-muted)]"
            aria-hidden="true"
          />
        )}
      </button>

      {open ? (
        <>
          <button
            type="button"
            aria-label="Zavřít výběr lokality"
            onClick={() => setOpen(false)}
            className="fixed inset-0 z-40 cursor-default"
          />
          <div
            role="menu"
            className="absolute left-0 top-full z-50 mt-1 max-h-[min(70dvh,32rem)] w-[min(18rem,calc(100vw-2rem))] overflow-y-auto overscroll-contain border border-[var(--line-strong)] bg-[var(--surface)] shadow-[0_20px_60px_rgba(0,0,0,0.7)]"
          >
            <Option
              label="Všechny lokality"
              active={zobrazeneId === ALL_SITES}
              onSelect={() => vybrat(ALL_SITES)}
            />
            <div className="h-px bg-[var(--line)]" />
            {sites.map((site) => (
              <Option
                key={site.id}
                label={site.name}
                active={site.id === zobrazeneId}
                onSelect={() => vybrat(site.id)}
              />
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}

function Option({
  label,
  active,
  onSelect,
}: {
  label: string;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onSelect}
      aria-current={active ? "true" : undefined}
      // 48 px na řádek: na telefonu se trefuje palcem a menší cíl
      // znamenal klepnout vedle — tedy zavřít nabídku bez výběru.
      className={`flex h-12 w-full items-center justify-between gap-2 border-b border-[var(--line)] px-4 text-left text-sm tracking-tight transition last:border-b-0 ${
        active
          ? "bg-[var(--surface-2)] font-medium"
          : "text-[var(--text-muted)] active:bg-[var(--surface-2)] hover:bg-[var(--surface-2)] hover:text-[var(--text)]"
      }`}
    >
      <span className="truncate">{label}</span>
      {active ? (
        <Check className="h-4 w-4 shrink-0 text-[var(--accent)]" aria-hidden="true" />
      ) : null}
    </button>
  );
}
