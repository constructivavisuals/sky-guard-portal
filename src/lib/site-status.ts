import { isSiteArmed, type IsoWeekday } from "../types/database.ts";
import { shiftZonedDate, zonedTimeToUtc } from "./patrols/schedule.ts";

// Kdy se ostrý režim lokality příště přepne.
//
// Počítá se z hranic okna, ne krokováním po minutách: kandidáty jsou
// začátky a konce okna na nejbližších dnech, a hledá se první okamžik,
// ve kterém se odpověď isSiteArmed() liší od té současné. Rozhodování
// tím zůstává na jediné otestované funkci.

export interface ArmedSchedule {
  timezone: string;
  armed_from: string;
  armed_to: string;
  armed_days: IsoWeekday[];
}

export interface ArmedTransition {
  at: Date;
  /** Do jakého stavu se přepne. */
  becomes: "armed" | "disarmed";
}

function toMinutes(hhmmss: string): number {
  const [hours, minutes] = hhmmss.split(":");
  return Number(hours) * 60 + Number(minutes);
}

/**
 * Nejbližší přepnutí ostrého režimu po `now`.
 *
 * Vrací null, když se stav v dohledné době nemění — okno na celý týden
 * bez výjimky, nebo naopak prázdné.
 */
export function nextArmedTransition(
  site: ArmedSchedule,
  now: Date = new Date(),
  options: { horizonDays?: number; currentlyArmed?: boolean } = {},
): ArmedTransition | null {
  const horizonDays = options.horizonDays ?? 8;
  const from = toMinutes(site.armed_from);
  const to = toMinutes(site.armed_to);
  if (from === to) return null;

  // Výchozí stav jde předat zvenčí, aby popisek („zapne se“ vs.
  // „vypne se“) odpovídal tomu, co se na stránce ukazuje. Přehled bere
  // aktuální režim ze site_is_armed() v databázi, zatímco okamžik
  // přepnutí umí spočítat jen tahle funkce — bez toho parametru by ty
  // dva údaje mohly na jedné větě říkat každý něco jiného.
  const current = options.currentlyArmed ?? isSiteArmed(site, now);

  // Kandidáti: začátek i konec okna na každém dni v dohledu. Ke každému
  // se přidá minuta po hranici — v samotném okamžiku hranice je stav
  // ještě ten starý (okno je zleva uzavřené, zprava otevřené).
  const candidates: Date[] = [];
  for (let shift = -1; shift <= horizonDays; shift++) {
    const { year, month, day } = shiftZonedDate(now, site.timezone, shift);
    for (const minute of [from, to]) {
      candidates.push(
        zonedTimeToUtc(
          year,
          month,
          day,
          Math.floor(minute / 60),
          minute % 60,
          site.timezone,
        ),
      );
    }
  }

  const sorted = [...new Set(candidates.map((c) => c.getTime()))]
    .filter((time) => time > now.getTime())
    .sort((a, b) => a - b);

  for (const time of sorted) {
    const at = new Date(time);
    if (isSiteArmed(site, at) !== current) {
      return { at, becomes: current ? "disarmed" : "armed" };
    }
  }

  return null;
}
