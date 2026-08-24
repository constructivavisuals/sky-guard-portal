import type {
  DetectionObjectClass,
  DispatchLevel,
  DispatchOutcome,
} from "../../types/database.ts";

// Čistá rozhodovací logika výjezdu — bez I/O, aby šla testovat bez
// databáze i bez FlightHubu. Vstupy (armed, poslední výjezd, nedávné
// detekce) si obstarává volající v src/lib/dispatch/run.ts.

/** Okno, ve kterém detekce osoby v jiné zóně eskaluje stupeň na maximum. */
export const PERSON_ESCALATION_WINDOW_SECONDS = 60;

/** Základní stupeň podle toho, co kamera viděla. */
const BASE_LEVEL_BY_CLASS: Record<DetectionObjectClass, DispatchLevel> = {
  person: 5,
  vehicle: 2,
  unknown: 1,
};

/**
 * Stupeň zásahu předaný do FlightHubu.
 *
 * Osoba viděná v posledních 60 s v JINÉ zóně téhož areálu znamená pohyb
 * po perimetru, ne jednorázový planý poplach — takový výjezd jede na
 * maximum bez ohledu na to, co spustilo tenhle konkrétní.
 */
export function resolveDispatchLevel(
  objectClass: DetectionObjectClass,
  recentPersonInOtherZone: boolean,
): DispatchLevel {
  if (recentPersonInOtherZone) return 5;
  return BASE_LEVEL_BY_CLASS[objectClass];
}

export interface DispatchDecisionInput {
  /** Výsledek SQL funkce site_is_armed() pro čas detekce. */
  armed: boolean;
  /** Nastavení lokality. */
  cooldownSeconds: number;
  /**
   * Čas posledního SKUTEČNĚ odeslaného výjezdu (outcome 'sent') na téže
   * lokalitě, nebo null. Potlačené a chybné pokusy se nepočítají —
   * jinak by každý zamítnutý pokus cooldown prodlužoval donekonečna
   * a výjezd by už nikdy neodešel.
   */
  lastSentAt: Date | null;
  /** Čas, ke kterému se rozhoduje (čas detekce). */
  at: Date;
}

export type DispatchDecision =
  | { send: true }
  | { send: false; outcome: Extract<DispatchOutcome, `suppressed_${string}`> };

/**
 * Pořadí kontrol je dané zadáním: nejdřív ostrý režim, pak cooldown.
 * Mimo ostrý režim se cooldown vůbec neřeší — důvod potlačení má být
 * ten hlavní, ne ten, na který se dřív narazilo.
 */
export function decideDispatch(input: DispatchDecisionInput): DispatchDecision {
  if (!input.armed) {
    return { send: false, outcome: "suppressed_disarmed" };
  }

  if (input.lastSentAt) {
    const elapsedSeconds =
      (input.at.getTime() - input.lastSentAt.getTime()) / 1000;
    if (elapsedSeconds < input.cooldownSeconds) {
      return { send: false, outcome: "suppressed_cooldown" };
    }
  }

  return { send: true };
}
