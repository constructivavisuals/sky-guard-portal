import type { DockState } from "./flighthub.ts";

// Může dron vzlétnout?
//
// Sdílené mezi hlídkami a zásahy schválně. Prahy tu byly původně jen
// v cronu hlídek a zásah je neřešil vůbec — jenže „stejná pravidla“
// se dvěma kopiemi čísel udrží tak dlouho, než někdo změní jednu.

/**
 * Pod tímhle nabitím se nelétá. Dron by nemusel doletět a vracel by se
 * do doku nedokončený, což je horší než let vynechaný — na ten se dá
 * aspoň reagovat.
 */
export const MIN_BATTERY_PERCENT = 40;

export type DockBlockReason = "drone_not_in_dock" | "low_battery";

export type DockReadiness =
  | { ok: true; reason: null }
  | { ok: false; reason: DockBlockReason };

/**
 * Posouzení stavu doku. Čisté, aby šlo otestovat bez sítě.
 *
 * Neznámý údaj NEBLOKUJE: dok, který nehlásí nabití, je pořád lepší
 * důvod letět než neletět — vynechaný let kvůli nečitelnému údaji je
 * horší než let s nejistou baterií. Blokuje se jen na hodnotě, kterou
 * dok opravdu poslal.
 *
 * Vypnutý dron překážka není. „power_off“ je běžný stav mezi lety;
 * probouzí ho úloha. Rozhoduje jen to, jestli sedí v doku.
 *
 * ═══ Plné úložiště TAKY NEBLOKUJE ══════════════════════════════════
 * Dřív se nad 95 % zaplnění let odmítal. Ověřeno u doku: dron vzlétne
 * i s plným úložištěm — zaplněná karta znamená, že se nemusí uložit
 * ZÁZNAM, ne že se nedá letět.
 *
 * A to je jiná ztráta: neodletěný zásah znamená, že se nad zónou
 * nikdo nepodíval. Nahrávka, která se nepořídí, je nepříjemná;
 * nepřítomný dron je ta věc, kvůli které tenhle portál existuje.
 *
 * Zaplnění se proto hlásí jako VAROVÁNÍ (dashboard.ts, práh 90 %)
 * a jako notifikace z cronu varování — ne jako důvod nevzlétnout.
 * ═══════════════════════════════════════════════════════════════════
 */
export function checkDockReadiness(state: DockState): DockReadiness {
  if (!state.droneInDock) return { ok: false, reason: "drone_not_in_dock" };

  if (
    state.batteryPercent !== null &&
    state.batteryPercent < MIN_BATTERY_PERCENT
  ) {
    return { ok: false, reason: "low_battery" };
  }

  return { ok: true, reason: null };
}
