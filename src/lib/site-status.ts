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

/**
 * Střeží lokalita nepřetržitě?
 *
 * ═══ Proč to jde poznat jen odhadem ════════════════════════════════
 * Model to neumí říct rovnou. `armed_from = armed_to` znamená PRÁZDNÉ
 * okno, tedy „nikdy“ — ne „pořád“ (viz isSiteArmed a jeho protějšek
 * site_is_armed() v SQL). Nepřetržitý provoz se proto zapisuje jako
 * okno přes celý den, 00:00 až 23:59, na všechny dny v týdnu.
 *
 * Zbývá v něm minuta denně, kdy lokalita formálně nestřeží. Je to
 * artefakt modelu, ne záměr, a v hlášce o stavu by z toho bylo
 * matoucí „střežení se vypne ve 23:59“. Tahle funkce takové okno
 * pozná, aby se dalo napsat rovnou, že se střeží nepřetržitě.
 *
 * Poctivé řešení je sloupec, který nepřetržitý provoz řekne výslovně
 * — pak zmizí i ta minuta. Do té doby je tohle to nejbližší, co jde
 * udělat bez migrace.
 */
export function isSiteAlwaysArmed(site: ArmedSchedule): boolean {
  if (site.armed_days.length < 7) return false;
  const from = toMinutes(site.armed_from);
  const to = toMinutes(site.armed_to);
  // Okno musí pokrývat celý den až na poslední minutu.
  return from === 0 && to >= 23 * 60 + 59;
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
