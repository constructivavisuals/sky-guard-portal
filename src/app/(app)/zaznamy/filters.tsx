import Link from "next/link";

import {
  monthGrid,
  shiftMonth,
  type CalendarDay,
  type DayString,
  type MonthString,
} from "@/lib/recordings/timeline.ts";

// Filtry a kalendář nad záznamy.
//
// Odkazy, ne tlačítka — filtr je součást adresy, takže jde poslat
// kolegovi nebo otevřít v nové kartě. Díky tomu je celá tahle část
// serverová a nepotřebuje ani řádek JavaScriptu v prohlížeči.

export interface CameraOption {
  id: string;
  name: string;
  serial_number: string | null;
}

/** Adresa seznamu s upravenými parametry. Prázdné se vynechají. */
const AKTIVNI = "bg-[var(--surface-3)] text-[var(--text)]";
const KLIDNY = "text-[var(--text-muted)] hover:bg-[var(--surface-2)] hover:text-[var(--text)]";

export function zaznamyHref(params: {
  kamera?: string | null;
  den?: string | null;
  mesic?: string | null;
  pohled?: Pohled | null;
}): string {
  const usp = new URLSearchParams();
  if (params.kamera) usp.set("kamera", params.kamera);
  if (params.den) usp.set("den", params.den);
  if (params.mesic) usp.set("mesic", params.mesic);
  // Výchozí pohled se do adresy nepíše — odkaz na den má zůstat krátký
  // a sdílený odkaz nemá nikoho zamknout v diagnostice.
  if (params.pohled === "soubory") usp.set("pohled", "soubory");
  const query = usp.toString();
  return query ? `/zaznamy?${query}` : "/zaznamy";
}

/**
 * Jak se den ukazuje.
 *
 * `osa` je pro klienta: souvislý den, soubory neviditelné. `soubory`
 * je pro nás: po montáži se podle seznamu ověřuje, že řetěz kamera →
 * relay → portál → úložiště šlape, a tam je potřeba vidět každý kus
 * zvlášť i s velikostí a stavem.
 */
export type Pohled = "osa" | "soubory";

export function jePohled(value: unknown): value is Pohled {
  return value === "osa" || value === "soubory";
}

export function ViewSwitch({
  pohled,
  kamera,
  den,
  mesic,
}: {
  pohled: Pohled;
  kamera: string | null;
  den: DayString | null;
  mesic: MonthString | null;
}) {
  const volby: { key: Pohled; label: string }[] = [
    { key: "osa", label: "Souvislý den" },
    { key: "soubory", label: "Jednotlivé soubory" },
  ];

  return (
    <div className="flex gap-1" role="group" aria-label="Zobrazení dne">
      {volby.map((volba) => (
        <Link
          key={volba.key}
          href={zaznamyHref({ kamera, den, mesic, pohled: volba.key })}
          aria-current={pohled === volba.key ? "true" : undefined}
          className={`rounded-[var(--radius-pill)] px-3 py-1 text-xs transition ${
            pohled === volba.key ? AKTIVNI : KLIDNY
          }`}
        >
          {volba.label}
        </Link>
      ))}
    </div>
  );
}

export function CameraFilter({
  cameras,
  active,
  den,
  mesic,
  pohled,
}: {
  cameras: readonly CameraOption[];
  active: string | null;
  den: DayString | null;
  mesic: MonthString | null;
  /** Přepnutí kamery nemá vyhodit z diagnostického pohledu. */
  pohled?: Pohled;
}) {
  if (cameras.length < 2) return null;

  return (
    <div className="flex flex-wrap items-center gap-1">
      <Link
        href={zaznamyHref({ den, mesic, pohled })}
        className={`rounded-[var(--radius-pill)] px-3 py-1 text-xs transition ${
          active === null ? AKTIVNI : KLIDNY
        }`}
      >
        Všechny kamery
      </Link>
      {cameras.map((camera) => (
        <Link
          key={camera.id}
          href={zaznamyHref({ kamera: camera.id, den, mesic, pohled })}
          className={`rounded-[var(--radius-pill)] px-3 py-1 text-xs transition ${
            active === camera.id ? AKTIVNI : KLIDNY
          }`}
        >
          {camera.name}
        </Link>
      ))}
    </div>
  );
}

const DNY = ["Po", "Út", "St", "Čt", "Pá", "So", "Ne"];

const MESICE = [
  "leden", "únor", "březen", "duben", "květen", "červen",
  "červenec", "srpen", "září", "říjen", "listopad", "prosinec",
];

function nazevMesice(month: MonthString): string {
  const [y, m] = month.split("-").map(Number);
  return `${MESICE[m - 1]} ${y}`;
}

/**
 * Kalendář měsíce s počty záznamů.
 *
 * Den bez záznamů není odkaz: prázdná osa dne nikomu nic neřekne
 * a proklik do ní je jen krok, který se musí vrátit zpátky.
 */
export function RecordingCalendar({
  month,
  counts,
  selectedDay,
  kamera,
  today,
}: {
  month: MonthString;
  counts: ReadonlyMap<DayString, number>;
  selectedDay: DayString | null;
  kamera: string | null;
  today: DayString;
}) {
  const weeks = monthGrid(month, counts);

  return (
    <div className="border border-[var(--line)] p-4">
      <div className="mb-3 flex items-center justify-between gap-4">
        <Link
          href={zaznamyHref({ kamera, mesic: shiftMonth(month, -1) })}
          aria-label="Předchozí měsíc"
          className="px-2 py-1 text-sm text-[var(--text-muted)] transition hover:text-[var(--text)]"
        >
          ‹
        </Link>
        <span className="text-sm">{nazevMesice(month)}</span>
        <Link
          href={zaznamyHref({ kamera, mesic: shiftMonth(month, 1) })}
          aria-label="Následující měsíc"
          className="px-2 py-1 text-sm text-[var(--text-muted)] transition hover:text-[var(--text)]"
        >
          ›
        </Link>
      </div>

      <div className="grid grid-cols-7 gap-px">
        {DNY.map((den) => (
          <div
            key={den}
            className="pb-1 text-center text-[10px] uppercase tracking-[0.1em] text-[var(--text-muted)]"
          >
            {den}
          </div>
        ))}

        {weeks.flat().map((den) => (
          <CalendarCell
            key={den.day}
            den={den}
            kamera={kamera}
            month={month}
            selected={den.day === selectedDay}
            today={den.day === today}
          />
        ))}
      </div>
    </div>
  );
}

function CalendarCell({
  den,
  kamera,
  month,
  selected,
  today,
}: {
  den: CalendarDay;
  kamera: string | null;
  month: MonthString;
  selected: boolean;
  today: boolean;
}) {
  const zaklad =
    "flex aspect-square flex-col items-center justify-center text-xs tabular-nums transition";

  if (den.recordings === 0) {
    return (
      <div
        className={`${zaklad} ${
          den.inMonth ? "text-[var(--text-muted)]" : "text-[var(--text-muted)]/40"
        } ${today ? "ring-1 ring-inset ring-[var(--line-strong)]" : ""}`}
      >
        {den.number}
      </div>
    );
  }

  return (
    <Link
      href={zaznamyHref({ kamera, den: den.day, mesic: month })}
      className={`${zaklad} ${
        selected
          ? "bg-[var(--accent)] text-white"
          : "bg-[var(--surface-2)] text-[var(--text)] hover:bg-[var(--surface-3)]"
      } ${today && !selected ? "ring-1 ring-inset ring-[var(--accent-bright)]" : ""}`}
    >
      <span>{den.number}</span>
      <span
        className={`text-[10px] ${
          selected ? "text-white/70" : "text-[var(--text-muted)]"
        }`}
      >
        {den.recordings}
      </span>
    </Link>
  );
}
