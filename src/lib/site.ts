// Sdílené věci kolem výběru lokality: konstanty a typy, které potřebuje
// i klientský kód. Schválně bez importu next/headers — ten by přetáhl
// serverové API do bundlu pro prohlížeč a build by spadl.
// Načítání dat je v selected-site.ts, které je jen pro server.

export const SITE_COOKIE = "sg-lokalita";

/** Hodnota cookie pro „nefiltrovat“. */
export const ALL_SITES = "vse";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isSiteId(value: string | undefined): value is string {
  return typeof value === "string" && UUID.test(value);
}

export interface SiteOption {
  id: string;
  name: string;
}

/**
 * Co portál pro daný výběr ukazuje.
 *
 * U jedné lokality jsou to její schopnosti. U „všech lokalit“ je to
 * SJEDNOCENÍ — kdo má stavbu i areál, musí v menu vidět obojí, protože
 * jinak by se k půlce portálu nedostal jinak než přepnutím.
 */
export interface SiteCapabilities {
  drone: boolean;
  cameras: boolean;
}

/** Jen to z lokality, co rozhoduje o schopnostech. */
export interface SiteCapabilityRow {
  has_drone: boolean;
  has_cameras: boolean;
}

export function siteCapabilities(
  rows: readonly SiteCapabilityRow[],
  selected: SiteCapabilityRow | null,
): SiteCapabilities {
  if (selected) {
    return { drone: selected.has_drone, cameras: selected.has_cameras };
  }

  // Bez lokalit se nic neskrývá. Prázdný portál, který navíc schová
  // menu, vypadá jako rozbitý — a uživatel bez jediného grantu si má
  // stěžovat na přístup, ne bloudit v okleštěné navigaci.
  if (rows.length === 0) return { drone: true, cameras: true };

  return {
    drone: rows.some((row) => row.has_drone),
    cameras: rows.some((row) => row.has_cameras),
  };
}
