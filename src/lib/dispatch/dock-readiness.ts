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

/** Nad tímhle zaplněním nemá dok kam ukládat pořízené snímky. */
export const MAX_STORAGE_PERCENT = 95;

export type DockBlockReason =
  | "drone_not_in_dock"
  | "low_battery"
  | "storage_full";

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
 * probouzí ho naplánovaná úloha. Rozhoduje jen to, jestli sedí v doku.
 */
export function checkDockReadiness(state: DockState): DockReadiness {
  if (!state.droneInDock) return { ok: false, reason: "drone_not_in_dock" };

  if (
    state.batteryPercent !== null &&
    state.batteryPercent < MIN_BATTERY_PERCENT
  ) {
    return { ok: false, reason: "low_battery" };
  }

  if (
    state.storageUsedPercent !== null &&
    state.storageUsedPercent > MAX_STORAGE_PERCENT
  ) {
    return { ok: false, reason: "storage_full" };
  }

  return { ok: true, reason: null };
}
