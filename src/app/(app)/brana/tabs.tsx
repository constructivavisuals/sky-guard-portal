"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// Karty skupiny Brána.
//
// Vjezdy, ohlášené příjezdy, známé značky a dopravci jsou čtyři pohledy
// na jednu věc: co má a nemá projet bránou. Samostatné položky v menu
// je od sebe vzdalovaly natolik, že jejich souvislost nebyla vidět —
// známá značka, ohlášený příjezd a dopravce jsou tři různé způsoby, jak
// říct „tohle auto sem patří“.

export interface BranaTab {
  href: string;
  label: string;
  /** Karta jen pro administrátora. */
  admin?: boolean;
}

export const BRANA_TABS: BranaTab[] = [
  { href: "/brana/vjezdy", label: "Vjezdy" },
  { href: "/brana/prijezdy", label: "Ohlášené příjezdy" },
  { href: "/brana/znacky", label: "Známé značky", admin: true },
  { href: "/brana/dopravci", label: "Dopravci", admin: true },
];

/**
 * Aktivní je i podřízená cesta: z detailu vjezdu má zůstat zvýrazněná
 * karta Vjezdy, ne žádná.
 */
export function BranaTabs({ isAdmin }: { isAdmin: boolean }) {
  // Cestu si bere komponenta sama: layout ji v Nextu nedostane
  // (renderuje se jednou pro všechny podstránky) a funkci, která by
  // ji dodala, přes hranici server/klient předat nejde.
  const active = usePathname();
  const tabs = BRANA_TABS.filter((tab) => !tab.admin || isAdmin);

  return (
    <nav
      aria-label="Části brány"
      className="flex flex-wrap gap-x-1 gap-y-2 border-b border-[var(--line)] px-5 py-2.5 sm:px-8"
    >
      {tabs.map((tab) => {
        const aktivni = active === tab.href || active.startsWith(`${tab.href}/`);
        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={aktivni ? "page" : undefined}
            className={`inline-flex h-8 items-center rounded-[var(--radius-pill)] px-3 text-[11px] font-medium uppercase tracking-[0.08em] transition ${
              aktivni
                ? "bg-[var(--surface-3)] text-[var(--text)]"
                : "text-[var(--text-muted)] hover:text-[var(--text)]"
            }`}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
