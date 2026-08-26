"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// Karty areálu.
//
// Lokalita, zóny a kamery byly tři samostatné položky v menu, a přitom
// je to jedna konfigurace viděná třikrát: zóna i kamera dávají smysl
// jen k areálu a obě stránky se stejně nejdřív filtrovaly podle
// lokality. Zanořením se ten výběr stal součástí cesty.

export function ArealTabs({ id }: { id: string }) {
  // Cestu si bere komponenta sama, viz poznámka u karet brány.
  const active = usePathname();
  const tabs = [
    { href: `/arealy/${id}`, label: "Lokalita" },
    { href: `/arealy/${id}/zony`, label: "Zóny" },
    { href: `/arealy/${id}/kamery`, label: "Kamery" },
  ];

  return (
    <nav
      aria-label="Části areálu"
      className="flex flex-wrap gap-x-1 gap-y-2 border-b border-[var(--line)] px-5 py-2.5 sm:px-8"
    >
      {tabs.map((tab) => (
        <Link
          key={tab.href}
          href={tab.href}
          aria-current={active === tab.href ? "page" : undefined}
          className={`inline-flex h-8 items-center rounded-[var(--radius-pill)] px-3 text-[11px] font-medium uppercase tracking-[0.08em] transition ${
            active === tab.href
              ? "bg-[var(--surface-3)] text-[var(--text)]"
              : "text-[var(--text-muted)] hover:text-[var(--text)]"
          }`}
        >
          {tab.label}
        </Link>
      ))}
    </nav>
  );
}
