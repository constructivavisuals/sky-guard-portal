import type { IsoWeekday } from "../../types/database.ts";

// Výpočet, kdy má hlídka letět.
//
// Časy se počítají v nástěnných hodinách lokality, ne v UTC ani v zóně
// serveru — na Vercelu běží cron v UTC, takže bez převodu by se ranní
// obchůzka v létě posunula o dvě hodiny.
//
// Čisté funkce, žádná databáze ani síť: cron je jen obalí.

export interface PatrolSchedule {
  window_from: string;
  window_to: string;
  days: IsoWeekday[];
  interval_minutes: number;
  /** IANA zóna lokality. */
  timezone: string;
}

/** Posun zóny vůči UTC v minutách pro daný okamžik. */
function offsetMinutes(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(at);

  const value = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value);

  const asUtc = Date.UTC(
    value("year"),
    value("month") - 1,
    value("day"),
    value("hour"),
    value("minute"),
    value("second"),
  );
  return (asUtc - at.getTime()) / 60_000;
}

/**
 * Nástěnný čas v zóně → skutečný okamžik.
 *
 * Dva průchody: první odhad použije posun platný pro odhadovaný
 * okamžik, druhý ho opraví, pokud odhad spadl na jinou stranu přechodu
 * času. Neexistující hodinu (jarní posun) to zarovná mimo mezeru,
 * u zdvojené (podzimní) vybere první průchod — pro plánování hlídek
 * obojí stačí.
 */
export function zonedTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  const naive = Date.UTC(year, month - 1, day, hour, minute);
  const first = offsetMinutes(new Date(naive), timeZone);
  const corrected = naive - first * 60_000;
  const second = offsetMinutes(new Date(corrected), timeZone);
  return new Date(naive - second * 60_000);
}

/**
 * Kalendářní datum posunuté o dny.
 *
 * Schválně přes UTC aritmetiku, ne přičítáním 24 hodin k okamžiku: den
 * s posunem času má 23 nebo 25 hodin, takže by se jeden kalendářní den
 * přeskočil úplně.
 */
export function shiftZonedDate(
  at: Date,
  timeZone: string,
  days: number,
): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(at);
  const value = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value);

  const shifted = new Date(
    Date.UTC(value("year"), value("month") - 1, value("day") + days),
  );
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

/** ISO den v týdnu pro kalendářní datum. */
export function isoWeekdayOf(year: number, month: number, day: number): IsoWeekday {
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return (weekday === 0 ? 7 : weekday) as IsoWeekday;
}

function toMinutes(hhmmss: string): number {
  const [hours, minutes] = hhmmss.split(":");
  return Number(hours) * 60 + Number(minutes);
}

/**
 * Starty hlídky, které padnou do intervalu (after, until].
 *
 * Sloty jsou window_from, +interval, +2×interval … dokud jsou uvnitř
 * okna. U okna přes půlnoc patří celá série dni, ve kterém začala —
 * hlídka 22:00–04:00 v pondělí tedy létá i v úterý nad ránem, když je
 * v days pondělí.
 */
export function patrolRunsBetween(
  patrol: PatrolSchedule,
  after: Date,
  until: Date,
): Date[] {
  const from = toMinutes(patrol.window_from);
  const to = toMinutes(patrol.window_to);
  if (from === to) return [];
  if (!Number.isFinite(patrol.interval_minutes) || patrol.interval_minutes <= 0) {
    return [];
  }

  // Okno přes půlnoc se počítá jako delší než 24 h ve složeném čase.
  const windowLength = from < to ? to - from : 24 * 60 - from + to;
  const days = new Set(patrol.days);
  const runs: Date[] = [];

  // Kandidátní dny: den před začátkem intervalu (kvůli oknu přes
  // půlnoc), den samotný a den následující.
  for (let shift = -1; shift <= 1; shift++) {
    const { year, month, day } = shiftZonedDate(after, patrol.timezone, shift);
    const iso = isoWeekdayOf(year, month, day);
    if (!days.has(iso)) continue;

    for (let offset = 0; offset < windowLength; offset += patrol.interval_minutes) {
      const minute = from + offset;
      const at = zonedTimeToUtc(
        year,
        month,
        day,
        Math.floor(minute / 60),
        minute % 60,
        patrol.timezone,
      );
      if (at.getTime() > after.getTime() && at.getTime() <= until.getTime()) {
        runs.push(at);
      }
    }
  }

  // Kandidátní dny se překrývají, takže tentýž slot může vyjít dvakrát.
  const unique = [...new Map(runs.map((run) => [run.getTime(), run])).values()];
  return unique.sort((a, b) => a.getTime() - b.getTime());
}
