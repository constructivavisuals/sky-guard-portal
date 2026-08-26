import Link from "next/link";

import type { PostgrestFilterBuilder } from "@supabase/postgrest-js";

// Filtr nad seznamem vjezdů.
//
// Odkazy, ne tlačítka: filtr je součást adresy, takže jde poslat
// a otevřít v nové kartě. Podmínky jsou tady, ne rozeseté po stránce —
// „nepřečtené“ musí znamenat totéž v seznamu i v odkazu z přehledu.

/* eslint-disable @typescript-eslint/no-explicit-any */
type Query = PostgrestFilterBuilder<any, any, any, any, any>;

export const FILTERS = {
  vse: {
    label: "Vše",
    apply: (q: Query) => q,
  },
  neznama: {
    label: "Neznámé",
    // Přečtená značka, která nepadla na seznam. Nejisté sem nepatří —
    // ty se se seznamem vůbec neporovnávaly.
    apply: (q: Query) =>
      q.not("plate", "is", null).is("list_match", null).gte("confidence", 0.7),
  },
  nezadouci: {
    label: "Nežádoucí",
    apply: (q: Query) => q.eq("list_match", "deny"),
  },
  zname: {
    label: "Známé",
    apply: (q: Query) => q.eq("list_match", "allow"),
  },
  neprectene: {
    label: "Nepřečtené",
    // Značka chybí úplně, nebo je pod prahem jistoty. Obojí znamená
    // „nevíme, kdo to byl“.
    apply: (q: Query) => q.or("plate.is.null,confidence.lt.0.7"),
  },
} as const;

export type FilterKey = keyof typeof FILTERS;

export function PassageFilter({ active }: { active: FilterKey }) {
  return (
    <nav aria-label="Filtr vjezdů" className="flex flex-wrap gap-2">
      {(Object.keys(FILTERS) as FilterKey[]).map((key) => {
        const aktivni = key === active;
        return (
          <Link
            key={key}
            href={key === "vse" ? "/vjezdy" : `/vjezdy?filtr=${key}`}
            aria-current={aktivni ? "page" : undefined}
            className={`inline-flex h-8 items-center rounded-[var(--radius-pill)] border px-3 text-[11px] font-medium uppercase tracking-[0.08em] transition ${
              aktivni
                ? "border-[var(--accent-bright)] bg-[var(--accent)] text-white"
                : "border-[var(--line-strong)] text-[var(--text-muted)] hover:border-[var(--text-muted)] hover:text-[var(--text)]"
            }`}
          >
            {FILTERS[key].label}
          </Link>
        );
      })}
    </nav>
  );
}
