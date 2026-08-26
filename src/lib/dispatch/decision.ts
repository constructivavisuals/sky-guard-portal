import type {
  DetectionObjectClass,
  DispatchLevel,
  DispatchOutcome,
} from "../../types/database.ts";

// Čistá rozhodovací logika zásahu — bez I/O, aby šla testovat bez
// databáze i bez FlightHubu. Vstupy (armed, poslední zásah, nedávné
// detekce) si obstarává volající v src/lib/dispatch/run.ts.

/** Okno, ve kterém detekce osoby v jiné zóně eskaluje stupeň na maximum. */
export const PERSON_ESCALATION_WINDOW_SECONDS = 60;

/**
 * Základní stupeň podle toho, co kamera viděla. Vystavené, aby si
 * stejné číslo mohl uložit i decision_reason — jinak by se údaj
 * o rozhodnutí počítal jinde než rozhodnutí samotné.
 */
export const BASE_LEVEL_BY_CLASS: Record<DetectionObjectClass, DispatchLevel> = {
  person: 5,
  vehicle: 2,
  unknown: 1,
};

/**
 * Stupeň zásahu předaný do FlightHubu.
 *
 * Osoba viděná v posledních 60 s v JINÉ zóně téhož areálu znamená pohyb
 * po perimetru, ne jednorázový planý poplach — takový zásah jede na
 * maximum bez ohledu na to, co spustilo tenhle konkrétní.
 *
 * NULL znamená, že se to nepodařilo zjistit. Tady je to fail-OPEN,
 * na rozdíl od ostrého režimu a cooldownu: neznámá eskalace zásah
 * nezastaví, jen se poletí na základním stupni. Nižší stupeň je pořád
 * zásah; zastavit ho kvůli nedostupnému dotazu na sousední zóny by
 * znamenalo neletět tam, kde se prokazatelně někdo pohybuje.
 */
export function resolveDispatchLevel(
  objectClass: DetectionObjectClass,
  recentPersonInOtherZone: boolean | null,
): DispatchLevel {
  if (recentPersonInOtherZone === true) return 5;
  return BASE_LEVEL_BY_CLASS[objectClass];
}

/**
 * Zvedne stupeň na spodní hranici zóny (`zones.default_level`).
 *
 * ═══ Co stupeň dělá a co ne ══════════════════════════════════════
 * Stupeň neřídí let — ten je daný trasou zóny. Jde do názvu úlohy ve
 * FlightHubu a do odznaku v portálu, tedy do toho, jak vážně se událost
 * bere. Právě proto má smysl ho u exponovaného místa podržet nahoře:
 * neznámý objekt u hlavní brány není totéž co neznámý objekt na kraji
 * pozemku, i když detektor vidí v obou případech totéž.
 *
 * Jen spodní hranice, ne pevná hodnota: eskalace na 5 musí projít i ze
 * zóny s hranicí 2. Hranice zvedá, nikdy nesnižuje.
 *
 * Hodnota mimo rozsah 1–5 (poškozený řádek, chybějící sloupec) se
 * ignoruje — v takovém případě se nic netvrdí a platí spočtený stupeň.
 */
export function applyZoneFloor(
  level: DispatchLevel,
  zoneDefaultLevel: number | null,
): DispatchLevel {
  if (zoneDefaultLevel === null || !Number.isInteger(zoneDefaultLevel)) return level;
  if (zoneDefaultLevel < 1 || zoneDefaultLevel > 5) return level;
  return Math.max(level, zoneDefaultLevel) as DispatchLevel;
}

/** Poslední odeslaný zásah, nebo přiznání, že se to nezjistilo. */
export interface LastDispatch {
  /** false = dotaz selhal. `at` je pak bezcenné. */
  known: boolean;
  at: Date | null;
}

export interface DispatchDecisionInput {
  /**
   * Výsledek SQL funkce site_is_armed() pro čas detekce.
   * NULL = nepodařilo se zjistit.
   */
  armed: boolean | null;
  /** Nastavení lokality. */
  cooldownSeconds: number;
  /**
   * Čas posledního SKUTEČNĚ odeslaného zásahu (outcome 'sent') na téže
   * lokalitě. Potlačené a chybné pokusy se nepočítají — jinak by každý
   * zamítnutý pokus cooldown prodlužoval donekonečna a zásah by už
   * nikdy neodešel.
   */
  lastSent: LastDispatch;
  /** Čas, ke kterému se rozhoduje (čas detekce). */
  at: Date;
}

/** Proč se neposlalo. Ukládá se do decision_reason, ne jen do logu. */
export type DispatchBlockCause =
  | "armed_unknown"
  | "disarmed"
  | "cooldown_unknown"
  | "cooldown";

export type DispatchDecision =
  | { send: true }
  | {
      send: false;
      outcome: Extract<DispatchOutcome, `suppressed_${string}`>;
      cause: DispatchBlockCause;
    };

/**
 * Pořadí kontrol je dané zadáním: nejdřív ostrý režim, pak cooldown.
 * Mimo ostrý režim se cooldown vůbec neřeší — důvod potlačení má být
 * ten hlavní, ne ten, na který se dřív narazilo.
 *
 * ═══ Nezjištěný vstup zásah ZASTAVÍ ══════════════════════════════
 * U obou vstupů je to fail-closed, ale z jiných důvodů:
 *
 *   armed    — bez něj nevíme, jestli se vůbec má reagovat. Poslat
 *              dron nad areál, kde zrovna pracuje směna, je horší než
 *              zmeškaná detekce.
 *   cooldown — bez něj nevíme, jestli dron nevzlétl před minutou.
 *              Duplicitní zásah znamená dvakrát vyslaný dron na totéž
 *              a vyčerpanou baterii pro to, co přijde potom.
 *
 * Obojí končí jako 'suppressed_unknown', ne 'suppressed_disarmed' ani
 * 'suppressed_cooldown': ty dva znamenají „portál rozhodl“, tohle
 * znamená „portál nevěděl“. Konkrétní příčina jde do `cause`.
 * ═════════════════════════════════════════════════════════════════
 */
export function decideDispatch(input: DispatchDecisionInput): DispatchDecision {
  if (input.armed === null) {
    return { send: false, outcome: "suppressed_unknown", cause: "armed_unknown" };
  }

  if (!input.armed) {
    return { send: false, outcome: "suppressed_disarmed", cause: "disarmed" };
  }

  if (!input.lastSent.known) {
    return { send: false, outcome: "suppressed_unknown", cause: "cooldown_unknown" };
  }

  if (input.lastSent.at) {
    const elapsedSeconds =
      (input.at.getTime() - input.lastSent.at.getTime()) / 1000;
    if (elapsedSeconds < input.cooldownSeconds) {
      return { send: false, outcome: "suppressed_cooldown", cause: "cooldown" };
    }
  }

  return { send: true };
}
