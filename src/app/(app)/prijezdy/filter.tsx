import Link from "next/link";

// Rozsah seznamu ohlášení.
//
// Odkazy, ne tlačítka: rozsah je součást adresy, takže jde poslat
// a otevřít v nové kartě — stejně jako filtr u vjezdů.

export const ROZSAHY = {
  // Výchozí: co teprve přijede. Historie je archiv, ne provozní pohled.
  budouci: { label: "Dnes a dál", historie: false },
  vse: { label: "Včetně historie", historie: true },
} as const;

export type RozsahKey = keyof typeof ROZSAHY;

export function ArrivalFilter({ active }: { active: RozsahKey }) {
  return (
    <nav aria-label="Rozsah ohlášení" className="flex flex-wrap gap-2">
      {(Object.keys(ROZSAHY) as RozsahKey[]).map((key) => {
        const aktivni = key === active;
        return (
          <Link
            key={key}
            href={key === "budouci" ? "/prijezdy" : `/prijezdy?rozsah=${key}`}
            aria-current={aktivni ? "page" : undefined}
            className={`inline-flex h-8 items-center rounded-[var(--radius-pill)] border px-3 text-[11px] font-medium uppercase tracking-[0.08em] transition ${
              aktivni
                ? "border-[var(--accent-bright)] bg-[var(--accent)] text-white"
                : "border-[var(--line-strong)] text-[var(--text-muted)] hover:border-[var(--text-muted)] hover:text-[var(--text)]"
            }`}
          >
            {ROZSAHY[key].label}
          </Link>
        );
      })}
    </nav>
  );
}
