import { zonedTimeToUtc } from "../patrols/schedule.ts";

// Den, osa dne a kalendář nad záznamy z kamer.
//
// Čisté, bez databáze i bez Reactu: kalendář i osa se počítají na
// serveru, ale pravidla kolem půlnoci a letního času si zaslouží test,
// ne důvěru.
//
// ═══ Den je den LOKALITY ═══════════════════════════════════════════
// Ne den prohlížeče a ne den v UTC. Kdo se dívá na stavbu z dovolené,
// musí vidět tentýž „čtvrtek“, jaký viděl mistr na place — a v UTC by
// se každý letní večer po 22:00 přelil do dalšího dne.

/** `YYYY-MM-DD`. */
export type DayString = string;

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isDayString(value: unknown): value is DayString {
  if (typeof value !== "string" || !DAY_RE.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  // Neexistující datum (31. února) projde regulárem, ale ne kalendářem.
  const zkouska = new Date(Date.UTC(y, m - 1, d));
  return zkouska.getUTCMonth() === m - 1 && zkouska.getUTCDate() === d;
}

/** `YYYY-MM`. */
export type MonthString = string;

const MONTH_RE = /^\d{4}-\d{2}$/;

export function isMonthString(value: unknown): value is MonthString {
  if (typeof value !== "string" || !MONTH_RE.test(value)) return false;
  const m = Number(value.slice(5));
  return m >= 1 && m <= 12;
}

export function monthOf(day: DayString): MonthString {
  return day.slice(0, 7);
}

/**
 * Od kdy do kdy trvá ten den v UTC.
 *
 * Hranice se počítají přes zonedTimeToUtc, takže sedí i na dny, kdy se
 * mění čas — 25hodinový říjnový den vyjde jako 25 hodin, ne jako 24
 * posunutých o hodinu.
 */
export function dayRange(day: DayString, timeZone: string): { from: Date; to: Date } {
  const [y, m, d] = day.split("-").map(Number);
  const from = zonedTimeToUtc(y, m, d, 0, 0, timeZone);
  // Půlnoc následujícího dne, ne +24 h.
  const zitra = new Date(Date.UTC(y, m - 1, d + 1));
  const to = zonedTimeToUtc(
    zitra.getUTCFullYear(),
    zitra.getUTCMonth() + 1,
    zitra.getUTCDate(),
    0,
    0,
    timeZone,
  );
  return { from, to };
}

/** Posun měsíce o krok, se zachováním tvaru `YYYY-MM`. */
export function shiftMonth(month: MonthString, kroku: number): MonthString {
  const [y, m] = month.split("-").map(Number);
  const posun = new Date(Date.UTC(y, m - 1 + kroku, 1));
  const mm = String(posun.getUTCMonth() + 1).padStart(2, "0");
  return `${posun.getUTCFullYear()}-${mm}`;
}

export interface CalendarDay {
  day: DayString;
  /** Číslo dne v měsíci. */
  number: number;
  /** Patří den do zobrazovaného měsíce, nebo je z okraje mřížky? */
  inMonth: boolean;
  recordings: number;
}

/**
 * Mřížka měsíce, po týdnech od pondělí.
 *
 * Okrajové dny z vedlejších měsíců se vykreslují potlačeně — bez nich
 * by se řádky rozpadly a kalendář by se hůř četl.
 */
export function monthGrid(
  month: MonthString,
  counts: ReadonlyMap<DayString, number>,
): CalendarDay[][] {
  const [y, m] = month.split("-").map(Number);
  const prvni = new Date(Date.UTC(y, m - 1, 1));

  // getUTCDay(): 0 = neděle. Chceme týden od pondělí.
  const posun = (prvni.getUTCDay() + 6) % 7;
  const zacatek = new Date(Date.UTC(y, m - 1, 1 - posun));

  const tydny: CalendarDay[][] = [];
  const kurzor = new Date(zacatek);

  // Šest týdnů pokryje každý měsíc; poslední se zahodí, když je celý
  // z příštího měsíce.
  for (let t = 0; t < 6; t += 1) {
    const tyden: CalendarDay[] = [];
    for (let d = 0; d < 7; d += 1) {
      const rok = kurzor.getUTCFullYear();
      const mesic = String(kurzor.getUTCMonth() + 1).padStart(2, "0");
      const den = String(kurzor.getUTCDate()).padStart(2, "0");
      const key = `${rok}-${mesic}-${den}`;
      tyden.push({
        day: key,
        number: kurzor.getUTCDate(),
        inMonth: kurzor.getUTCMonth() === m - 1,
        recordings: counts.get(key) ?? 0,
      });
      kurzor.setUTCDate(kurzor.getUTCDate() + 1);
    }
    if (tyden.some((den) => den.inMonth)) tydny.push(tyden);
  }

  return tydny;
}

/**
 * Nejmenší šířka úseku na ose, v procentech.
 *
 * Dvacetivteřinový záznam je na 24hodinové ose 0,02 % — neviditelný
 * a hlavně netrefitelný myší. Radši ho nakreslit širší, než ať je
 * pravdivě nulový a k ničemu.
 */
export const MIN_SEGMENT_PERCENT = 0.6;

export interface TimelineSegment<T> {
  row: T;
  /** Odsazení zleva v procentech šířky dne. */
  left: number;
  width: number;
}

/**
 * Umístí záznamy na osu dne.
 *
 * Záznam přes půlnoc se ořízne na zobrazovaný den — pokračování patří
 * dalšímu dni a nakreslit ho přes okraj by lhalo o tom, kdy skončil.
 * Záznam bez konce dostane nejmenší šířku: víme, kdy začal, ne kdy
 * přestal.
 */
export function timelineSegments<T extends { started_at: string; ended_at: string | null }>(
  rows: readonly T[],
  range: { from: Date; to: Date },
): TimelineSegment<T>[] {
  const zacatek = range.from.getTime();
  const delka = range.to.getTime() - zacatek;
  if (!Number.isFinite(delka) || delka <= 0) return [];

  const out: TimelineSegment<T>[] = [];

  for (const row of rows) {
    const od = new Date(row.started_at).getTime();
    if (!Number.isFinite(od)) continue;

    const doKdy = row.ended_at ? new Date(row.ended_at).getTime() : od;
    const konec = Number.isFinite(doKdy) ? Math.max(doKdy, od) : od;

    // Mimo den — může se stát u záznamu přes půlnoc, který sem přišel
    // kvůli druhé půlce.
    if (konec <= zacatek || od >= range.to.getTime()) continue;

    const levaMs = Math.max(0, od - zacatek);
    const pravaMs = Math.min(delka, konec - zacatek);

    const left = (levaMs / delka) * 100;
    const width = Math.max(MIN_SEGMENT_PERCENT, ((pravaMs - levaMs) / delka) * 100);

    out.push({ row, left, width: Math.min(width, 100 - left) });
  }

  return out;
}

/** Popisky hodin na ose. Ne všech 24 — na mobilu by se slily. */
export const TIMELINE_HOURS = [0, 6, 12, 18] as const;
