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
