import { shiftZonedDate } from "../patrols/schedule.ts";
import { normalizePlate } from "../plates.ts";
import type { AnnouncedArrival } from "../../types/database.ts";

// Kdy ohlášený příjezd zásah zruší.
//
// Čisté, bez databáze. Rozhodnutí o tom, jestli poslat dron na vozidlo
// v areálu, si zaslouží test, ne důvěru.
//
// ═══ Tři pravidla a proč právě takhle ══════════════════════════════
//   mimo ostrý režim         → kryto. Areál nestřeží, ohlášení jen
//                              doplňuje, proč tam to auto je.
//   ostrý režim, night_ok    → kryto. Řidič výslovně řekl, že přijede
//                              i v noci, a někdo mu to schválil tím,
//                              že mu dal odkaz.
//   ostrý režim, bez night_ok → NENÍ kryto. Ohlásit denní rozvoz nesmí
//                              být zadní vrátka na noc: kdo se v noci
//                              objeví bez upozornění, je pořád důvod
//                              poslat dron.
// ═══════════════════════════════════════════════════════════════════

/**
 * Kolik dní dopředu se dá ohlásit.
 *
 * Dál je to plánování, ne avízo — a ohlášení na půl roku dopředu by
 * v den D nikdo nepamatoval, že platí.
 */
export const MAX_DAYS_AHEAD = 30;

/** Ohlášení tak, jak ho vyhodnocení potřebuje. */
export type ArrivalCandidate = Pick<
  AnnouncedArrival,
  "id" | "plate" | "arrival_date" | "night_ok" | "cancelled_at"
>;

export type ArrivalVerdict =
  | { covered: true; arrival: ArrivalCandidate; reason: "disarmed" | "night_ok" }
  | { covered: false; arrival: ArrivalCandidate; reason: "night_not_allowed" }
  | { covered: false; arrival: null; reason: "no_match" };

/**
 * Najde ohlášení, které na tenhle vjezd sedí, a řekne, jestli kryje.
 *
 * Značka se porovnává normalizovaná, stejně jako u known_plates —
 * `1AB 2345` z ruky řidiče a `1ab2345` od modelu musí být totéž.
 *
 * Datum se předává hotové, ne počítané z Date: „dnešek“ je v pásmu
 * lokality, a to tahle funkce nemá jak vědět.
 */
export function matchArrival(options: {
  /** Přečtená značka. null = nepřečtená nebo nejistá. */
  plate: string | null;
  /** `YYYY-MM-DD` v pásmu lokality. */
  today: string;
  armed: boolean;
  candidates: readonly ArrivalCandidate[];
}): ArrivalVerdict {
  const { plate, today, armed, candidates } = options;

  if (!plate) return { covered: false, arrival: null, reason: "no_match" };
  const hledana = normalizePlate(plate);
  if (!hledana) return { covered: false, arrival: null, reason: "no_match" };

  const shody = candidates.filter(
    (arrival) =>
      arrival.cancelled_at === null &&
      arrival.arrival_date === today &&
      // Anonymizované ohlášení (po lhůtě) značku nemá a nemůže se tedy
      // s ničím shodovat. Do rozhodování o dnešním vjezdu se stejně
      // nedostane — lhůta je v řádu měsíců.
      arrival.plate !== null &&
      normalizePlate(arrival.plate) === hledana,
  );

  if (shody.length === 0) {
    return { covered: false, arrival: null, reason: "no_match" };
  }

  if (!armed) {
    return { covered: true, arrival: shody[0], reason: "disarmed" };
  }

  // V ostrém režimu rozhoduje night_ok. Když má dopravce na tentýž den
  // víc ohlášení téže značky (různí řidiči, oprava), stačí jedno
  // s night_ok — přísnější výklad by trestal za to, že se ohlásili
  // dvakrát.
  const nocni = shody.find((arrival) => arrival.night_ok);
  if (nocni) return { covered: true, arrival: nocni, reason: "night_ok" };

  return { covered: false, arrival: shody[0], reason: "night_not_allowed" };
}

/**
 * Kalendářní datum v pásmu lokality jako `YYYY-MM-DD`.
 *
 * Sloupec arrival_date je DATE, tedy kalendářní den bez času —
 * a „dnešek“ je pro řidiče i pro areál ten místní, ne UTC. Bez
 * přepočtu by se ohlášení na dnešní večer po 22:00 letního času
 * hledalo pod zítřejším datem.
 *
 * Přes `shiftZonedDate` s posunem 0, ať je výpočet data na jednom
 * místě a chová se stejně jako u hlídek.
 */
export function localDateISO(timeZone: string, at: Date = new Date()): string {
  const { year, month, day } = shiftZonedDate(at, timeZone, 0);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${year}-${pad(month)}-${pad(day)}`;
}
