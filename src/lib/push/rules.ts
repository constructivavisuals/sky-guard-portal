import {
  DEFAULT_NOTIFICATION_PREFS,
  NOTIFICATION_KINDS_IGNORING_QUIET,
  NOTIFICATION_KIND_COLUMNS,
  isQuietHour,
  type NotificationKind,
  type NotificationPrefs,
} from "../../types/database.ts";

// Komu se notifikace pošle a komu ne.
//
// Čisté, bez databáze — rozhodování o tom, jestli někoho ve tři ráno
// probudit, si zaslouží test, ne jen důvěru.

/** Předvolby, jak je vidí rozhodování. Chybějící řádek = výchozí. */
export type EffectivePrefs = Pick<
  NotificationPrefs,
  | "on_dispatch_sent"
  | "on_dispatch_suppressed"
  | "on_threat_confirmed"
  | "on_camera_silent"
  | "on_dock_problem"
  | "quiet_from"
  | "quiet_to"
>;

export function effectivePrefs(
  row: Partial<EffectivePrefs> | null | undefined,
): EffectivePrefs {
  return { ...DEFAULT_NOTIFICATION_PREFS, ...(row ?? {}) };
}

export type DeliveryDecision =
  | { send: true }
  | { send: false; reason: "kind_disabled" | "quiet_hours" };

/**
 * Má tomuhle uživateli tahle událost dorazit?
 *
 * Pořadí je dané: nejdřív jestli o ten druh vůbec stojí, teprve pak
 * tiché hodiny. Vypnutý druh se nemá hlásit ani ve dne, a důvod
 * v logu má být ten hlavní, ne ten, na který se dřív narazilo.
 *
 * Potvrzený nález tiché hodiny ignoruje — vypnout se dá, umlčet ne.
 * Když někdo řekl „tenhle druh nechci“, je to jeho rozhodnutí; když
 * řekl „v noci mě neruš“, nemyslel tím „a nevadí, že mi na pozemku
 * někdo je“.
 */
export function shouldDeliver(options: {
  kind: NotificationKind;
  prefs: EffectivePrefs;
  timezone: string;
  at?: Date;
}): DeliveryDecision {
  const { kind, prefs, timezone } = options;

  if (!prefs[NOTIFICATION_KIND_COLUMNS[kind] as keyof EffectivePrefs]) {
    return { send: false, reason: "kind_disabled" };
  }

  if (NOTIFICATION_KINDS_IGNORING_QUIET.includes(kind)) return { send: true };

  if (isQuietHour(prefs, timezone, options.at ?? new Date())) {
    return { send: false, reason: "quiet_hours" };
  }

  return { send: true };
}

/**
 * Uplynul od posledního stejného varování dost dlouhý odstup?
 *
 * Mlčící kamera mlčí dál i za čtvrt hodiny. Bez odstupu by cron poslal
 * totéž při každém běhu a uživatel by si notifikace vypnul — čímž by
 * přišel i o zásahy.
 */
export const WARNING_COOLDOWN_HOURS = 6;

export function warningCooldownElapsed(
  lastSentAt: string | null | undefined,
  at: Date = new Date(),
  cooldownHours: number = WARNING_COOLDOWN_HOURS,
): boolean {
  if (!lastSentAt) return true;
  const last = new Date(lastSentAt).getTime();
  // Nečitelné razítko nesmí varování umlčet natrvalo.
  if (Number.isNaN(last)) return true;
  return at.getTime() - last >= cooldownHours * 3_600_000;
}
