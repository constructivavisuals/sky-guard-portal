import {
  RAINFALL_LABELS,
  type FlightConditions,
  type IsoWeekday,
  type RainfallLevel,
} from "../types/database.ts";

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
/**
 * Velikost souboru pro člověka.
 *
 * Zaokrouhluje na desetinu MB: u záznamu z kamery je podstatné, jestli
 * má jednotky MB nebo pár kilobajtů (rozbitý remux), ne přesné číslo.
 */
export function formatBytes(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return "—";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} kB`;
  return `${(value / 1_048_576).toFixed(1)} MB`;
}

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

/**
 * Srážky česky. Neznámý kód se vypíše tak, jak přišel — je to lepší
 * než pomlčka, protože z logu pak jde doplnit překlad.
 */
export function formatRainfall(value: string | null | undefined): string {
  if (!value) return "—";
  return RAINFALL_LABELS[value as RainfallLevel] ?? value;
}

/** Rychlost větru z doku. */
export function formatWindSpeed(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  return `${new Intl.NumberFormat("cs-CZ", { maximumFractionDigits: 1 }).format(value)} m/s`;
}

/** Teplota z doku. */
export function formatTemperature(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  return `${new Intl.NumberFormat("cs-CZ", { maximumFractionDigits: 1 }).format(value)} °C`;
}

/** Podmínky letu jedním řádkem, prázdné údaje se vynechají. */
export function formatConditions(
  conditions: FlightConditions | null | undefined,
): string {
  if (!conditions) return "—";
  const parts = [
    formatWindSpeed(conditions.wind_speed),
    formatRainfall(conditions.rainfall),
    formatTemperature(conditions.environment_temperature),
  ].filter((part) => part !== "—");
  return parts.length > 0 ? parts.join(" · ") : "—";
}

/**
 * Trvání letu. Vteřiny se ukazují jen u krátkých letů — u dvacetiminutové
 * hlídky je „18 min“ čitelnější než „18 min 7 s“.
 */
export function formatDuration(seconds: number | null | undefined): string {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) {
    return "—";
  }
  const total = Math.round(seconds);
  if (total < 60) return `${total} s`;

  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  if (minutes < 60) {
    return rest > 0 && minutes < 10 ? `${minutes} min ${rest} s` : `${minutes} min`;
  }

  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return restMinutes > 0 ? `${hours} h ${restMinutes} min` : `${hours} h`;
}

/** Trvání dopočítané z časů, když ho databáze nemá spočítané. */
export function durationBetween(
  startedAt: string | null,
  endedAt: string | null,
): number | null {
  if (!startedAt || !endedAt) return null;
  const from = new Date(startedAt).getTime();
  const to = new Date(endedAt).getTime();
  if (Number.isNaN(from) || Number.isNaN(to) || to < from) return null;
  return (to - from) / 1000;
}
