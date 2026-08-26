import {
  DETECTION_OBJECT_CLASS_LABELS,
  type DecisionReason,
  type DetectionObjectClass,
  type DispatchOutcome,
} from "../../types/database.ts";

// Vysvětlení, proč zásah dopadl tak, jak dopadl.
//
// POZOR: nic z tohohle není zápis rozhodnutí. Databáze si důvod
// neukládá — schéma má jen outcome a level_sent. Tyhle funkce ho
// dopočítávají zpětně ze stejných pravidel, podle kterých se
// rozhodovalo (src/lib/dispatch/decision.ts). Když se pravidla změní,
// musí se změnit i tady, jinak bude detail tvrdit něco jiného, než se
// stalo. Proto se v UI popisuje jako „odvozeno“, ne jako záznam.

const BASE_LEVEL: Record<DetectionObjectClass, number> = {
  person: 5,
  vehicle: 2,
  unknown: 1,
};

/** Základní stupeň podle toho, co kamera viděla. */
export function baseLevelFor(objectClass: DetectionObjectClass): number {
  return BASE_LEVEL[objectClass];
}

/**
 * Byl stupeň zvednutý nad základ pro danou třídu objektu?
 *
 * Eskaluje se, když se v posledních 60 s objevila osoba v jiné zóně
 * téhož areálu — pohyb po perimetru, ne jednorázový planý poplach.
 */
export function wasEscalated(
  objectClass: DetectionObjectClass,
  levelSent: number,
): boolean {
  return levelSent > BASE_LEVEL[objectClass];
}

export interface LevelExplanation {
  base: number;
  sent: number;
  escalated: boolean;
  text: string;
}

export function explainLevel(
  objectClass: DetectionObjectClass | null,
  levelSent: number,
): LevelExplanation {
  if (objectClass === null) {
    return {
      base: levelSent,
      sent: levelSent,
      escalated: false,
      text: "Stupeň zadaný ručně — zásah nevznikl z detekce.",
    };
  }

  const base = BASE_LEVEL[objectClass];
  const label = DETECTION_OBJECT_CLASS_LABELS[objectClass].toLowerCase();

  if (levelSent > base) {
    return {
      base,
      sent: levelSent,
      escalated: true,
      text: `Základ pro ${label} je ${base}. Zvýšeno na ${levelSent}, protože se v okolních zónách krátce předtím pohybovala osoba.`,
    };
  }

  return {
    base,
    sent: levelSent,
    escalated: false,
    text: `Stupeň ${levelSent} odpovídá tomu, co kamera viděla (${label}).`,
  };
}

export interface OutcomeExplanation {
  title: string;
  text: string;
  tone: "success" | "warning" | "danger";
}

export function explainOutcome(
  outcome: DispatchOutcome,
  context: { armedWindow?: string; armedDays?: string; cooldownSeconds?: number },
): OutcomeExplanation {
  switch (outcome) {
    case "sent":
      return {
        title: "Odesláno do FlightHubu",
        text: "Lokalita byla v ostrém režimu a od předchozího zásahu uplynul cooldown.",
        tone: "success",
      };
    case "suppressed_disarmed":
      return {
        title: "Potlačeno — mimo režim střežení",
        text:
          context.armedWindow && context.armedDays
            ? `Lokalita v tu chvíli nestřežila. Ostrý režim má nastavený na ${context.armedWindow}, ${context.armedDays}.`
            : "Lokalita v tu chvíli nestřežila.",
        tone: "warning",
      };
    case "suppressed_cooldown":
      return {
        title: "Potlačeno — cooldown",
        text:
          context.cooldownSeconds !== undefined
            ? `Od předchozího odeslaného zásahu neuplynulo ${context.cooldownSeconds} s.`
            : "Od předchozího odeslaného zásahu neuplynul nastavený odstup.",
        tone: "warning",
      };
    case "suppressed_unknown":
      return {
        title: "Nevyhodnoceno — chybějící údaje",
        // Ne „potlačeno“: portál nic nerozhodl, jen se nedostal
        // k údajům, podle kterých rozhoduje. Červená, protože to na
        // rozdíl od potlačení znamená, že je něco rozbité.
        text:
          "Vstupy pro rozhodnutí se nepodařilo zjistit, takže zásah radši neodešel. Detekce zůstala zapsaná.",
        tone: "danger",
      };
    case "suppressed_dock":
      return {
        title: "Potlačeno — dok nebyl připravený",
        // Jantarová, ne červená: nic se nepokazilo, jen dron nemohl
        // vzlétnout. Přesný důvod nese decision_reason.dock.
        text: "Dron nebyl ve stavu, ze kterého se dá vzlétnout. Detekce zůstala zapsaná.",
        tone: "warning",
      };
    case "failed":
      return {
        title: "Odeslání selhalo",
        text: "FlightHub zásah nepřijal. Detekce zůstala zapsaná.",
        tone: "danger",
      };
  }
}

/** Odkaz na mapu pro souřadnice zóny. */
export function mapUrl(latitude: number, longitude: number): string {
  return `https://mapy.cz/zakladni?source=coor&id=${longitude},${latitude}&x=${longitude}&y=${latitude}&z=17`;
}

// ── Vysvětlení z uloženého důvodu ────────────────────────────────

/**
 * Totéž co explainLevel, ale ze zapsaného rozhodnutí — žádné
 * dopočítávání, takže platí i po změně pravidel.
 */
export function levelFromReason(reason: DecisionReason): LevelExplanation {
  const label =
    reason.object_class === null
      ? null
      : DETECTION_OBJECT_CLASS_LABELS[reason.object_class].toLowerCase();

  if (reason.escalated) {
    const window = reason.escalation?.window_seconds;
    return {
      base: reason.base_level,
      sent: reason.level_sent,
      escalated: true,
      text: label
        ? `Základ pro ${label} je ${reason.base_level}. Zvýšeno na ${reason.level_sent}, protože se ${window ? `během ${window} s ` : ""}v jiné zóně pohybovala osoba.`
        : `Zvýšeno na ${reason.level_sent} kvůli pohybu osoby v jiné zóně.`,
    };
  }

  return {
    base: reason.base_level,
    sent: reason.level_sent,
    escalated: false,
    text: label
      ? `Stupeň ${reason.level_sent} odpovídá tomu, co kamera viděla (${label}).`
      : `Stupeň ${reason.level_sent} zadaný ručně.`,
  };
}

/** Stav střežení a cooldown tak, jak byly v okamžiku rozhodnutí. */
export function conditionsFromReason(reason: DecisionReason): string[] {
  const out: string[] = [];

  const neznámé = reason.unknown_inputs ?? [];

  out.push(
    reason.armed === null
      ? "Režim střežení se nepodařilo zjistit — databáze neodpověděla. NENÍ to totéž jako „nestřežila“."
      : reason.armed
        ? "Lokalita byla v ostrém režimu."
        : "Lokalita v tu chvíli nestřežila.",
  );

  if (!reason.zone_enabled) {
    out.push("Zóna byla vypnutá, takže se chovala jako mimo režim.");
  }

  if (neznámé.includes("cooldown")) {
    out.push(
      "Poslední odeslaný zásah se nepodařilo dohledat, takže se nedalo posoudit, jestli uplynul cooldown.",
    );
  } else if (reason.seconds_since_last_sent === null) {
    out.push(
      `Na lokalitě do té doby žádný zásah neodešel, cooldown ${reason.cooldown_seconds} s se neuplatnil.`,
    );
  } else if ((reason.cooldown_remaining_seconds ?? 0) > 0) {
    out.push(
      `Od předchozího zásahu uplynulo ${reason.seconds_since_last_sent} s z ${reason.cooldown_seconds} s, zbývalo ${reason.cooldown_remaining_seconds} s.`,
    );
  } else {
    out.push(
      `Od předchozího zásahu uplynulo ${reason.seconds_since_last_sent} s, cooldown ${reason.cooldown_seconds} s byl vyčerpaný.`,
    );
  }

  if (neznámé.includes("escalation")) {
    // Fail-open: nižší stupeň je pořád zásah. Musí to ale být vidět,
    // jinak by stupeň vypadal jako vědomé rozhodnutí.
    out.push(
      "Pohyb v sousedních zónách se nepodařilo ověřit, takže se letělo na základním stupni — mohl být vyšší.",
    );
  }

  if (reason.zone_has_wayline === false) {
    out.push(
      "Zóna nemá přiřazenou trasu ve FlightHubu, takže se plánovaná úloha nedala založit.",
    );
  }

  const dock = reason.dock;
  if (dock && !dock.ok) {
    out.push(popisDoku(dock));
  }

  return out;
}

/** Proč se z doku nedalo vzlétnout, česky. */
function popisDoku(dock: NonNullable<DecisionReason["dock"]>): string {
  switch (dock.reason) {
    case "drone_not_in_dock":
      return "Dron nebyl v doku, takže neměl odkud odstartovat.";
    case "low_battery":
      return dock.battery_percent === null
        ? "Dron neměl dost nabito."
        : `Dron měl ${Math.round(dock.battery_percent)} % baterie, což je pod hranicí pro vzlet.`;
    case "storage_full":
      return dock.storage_used_percent === null
        ? "Úložiště doku bylo plné, nebylo kam ukládat snímky."
        : `Úložiště doku bylo zaplněné na ${Math.round(dock.storage_used_percent)} %, nebylo kam ukládat snímky.`;
    case "unreachable":
      return "Stav doku se nepodařilo zjistit, takže se neletělo — planý let stojí víc než zmeškaný.";
    default:
      return "Dok nebyl ve stavu, ze kterého se dá vzlétnout.";
  }
}
