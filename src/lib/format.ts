import type { IsoWeekday } from "../types/database.ts";

// Formátování hodnot pro UI. Čisté funkce bez závislosti na Reactu,
// aby se daly testovat i použít na serveru i na klientovi.

/** Když lokalita nemá zónu známou, počítá se v pražském čase. */
export const DEFAULT_TIME_ZONE = "Europe/Prague";

const WEEKDAY_NAMES: Record<IsoWeekday, string> = {
  1: "Po",
  2: "Út",
  3: "St",
  4: "Čt",
  5: "Pá",
  6: "So",
  7: "Ne",
};

/** Datum a čas v časové zóně lokality, ne serveru. */
export function formatDateTime(
  iso: string | null,
  timeZone: string = DEFAULT_TIME_ZONE,
): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";

  return new Intl.DateTimeFormat("cs-CZ", {
    timeZone,
    day: "numeric",
    month: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(date);
}

/** `18:00:00` → `18:00`; sekundy v okně střežení nikoho nezajímají. */
export function formatTimeOfDay(value: string | null): string {
  if (!value) return "—";
  const [hours, minutes] = value.split(":");
  if (hours === undefined || minutes === undefined) return "—";
  return `${hours}:${minutes}`;
}

/** Okno střežení jedním řetězcem. */
export function formatArmedWindow(from: string, to: string): string {
  return `${formatTimeOfDay(from)}–${formatTimeOfDay(to)}`;
}

/**
 * Dny střežení. Souvislé úseky se stahují do rozsahu (Po–Pá), ostatní
 * se vypíšou čárkou — jinak by karta lokality nesla sedm zkratek.
 */
export function formatArmedDays(days: readonly IsoWeekday[]): string {
  const unique = [...new Set(days)].sort((a, b) => a - b);
  if (unique.length === 0) return "Nikdy";
  if (unique.length === 7) return "Celý týden";

  const parts: string[] = [];
  let start = 0;

  for (let i = 1; i <= unique.length; i++) {
    const endsRun = i === unique.length || unique[i] !== unique[i - 1] + 1;
    if (!endsRun) continue;

    const first = unique[start];
    const last = unique[i - 1];
    // Dvojice se vypisuje čárkou; rozsah dává smysl až od tří dnů.
    if (i - start >= 3) {
      parts.push(`${WEEKDAY_NAMES[first]}–${WEEKDAY_NAMES[last]}`);
    } else {
      for (let j = start; j < i; j++) parts.push(WEEKDAY_NAMES[unique[j]]);
    }
    start = i;
  }

  return parts.join(", ");
}

/** Jistota detektoru jako procenta. */
export function formatConfidence(value: number | null): string {
  if (value === null || Number.isNaN(value)) return "—";
  return `${Math.round(value * 100)} %`;
}

/** Ohnisko objektivu. */
export function formatFocalLength(value: number | null): string {
  if (value === null || Number.isNaN(value)) return "—";
  return `${new Intl.NumberFormat("cs-CZ", {
    maximumFractionDigits: 1,
  }).format(value)} mm`;
}

/** Prázdná hodnota se v tabulce ukazuje pomlčkou, ne mezerou. */
export function orDash(value: string | null | undefined): string {
  return value && value.trim() !== "" ? value : "—";
}

/**
 * České skloňování počtu: 1 zóna, 2–4 zóny, 5+ zón.
 *
 * Bez toho by karta lokality nesla „4 zón“ nebo jen holé číslo u ikony,
 * u kterého není poznat, co počítá.
 */
export function plural(
  count: number,
  one: string,
  few: string,
  many: string,
): string {
  const n = Math.abs(count);
  if (n === 1) return `${count} ${one}`;
  if (n >= 2 && n <= 4) return `${count} ${few}`;
  return `${count} ${many}`;
}
