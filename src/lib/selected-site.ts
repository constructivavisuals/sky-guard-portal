import { cache } from "react";
import { cookies } from "next/headers";

import { ALL_SITES, SITE_COOKIE, isSiteId, type SiteOption } from "./site.ts";
import { createClient } from "./supabase/server.ts";
import type { IsoWeekday } from "../types/database.ts";

// Načtení lokalit a vyhodnocení té vybrané. Server-only — sahá na
// cookies() i na databázi. Konstanty a typy jsou v site.ts, aby si je
// mohl vzít i klientský přepínač.

/**
 * Řádek lokality tak, jak ho potřebuje shell a přehled.
 *
 * Sloupce pro ostrý režim tu jsou schválně: horní lišta i přehled si
 * z nich stav dopočítají v TypeScriptu místo volání site_is_armed().
 * Shodu obou implementací hlídá paritní test v run-local.sh, takže se
 * tím ušetří dva síťové skoky na každé načtení stránky, aniž by hrozilo,
 * že se odpovědi rozejdou.
 */
export interface SiteRow {
  id: string;
  name: string;
  timezone: string;
  /**
   * Co lokalita má. Migrace 20260914120000; dokud neproběhne, čtou se
   * jako dron ano / kamery ne, tedy tak, jak portál vypadal dosud.
   */
  has_drone: boolean;
  has_cameras: boolean;
  dock_sn: string | null;
  armed_from: string;
  armed_to: string;
  armed_days: IsoWeekday[];
  map_image_url: string | null;
  map_nw_lat: number | null;
  map_nw_lon: number | null;
  map_se_lat: number | null;
  map_se_lon: number | null;
}

export { siteCapabilities, type SiteCapabilities } from "./site.ts";

export interface SiteSelection {
  /** Lokality viditelné přihlášenému uživateli (přes RLS). */
  sites: SiteOption[];
  /** null = uživatel si vybral všechny lokality, nebo žádná neexistuje. */
  selected: SiteOption | null;
  /** Celé řádky. Jen pro server — do přepínače v prohlížeči nepatří. */
  rows: SiteRow[];
  selectedRow: SiteRow | null;
  /** true, když se seznam nepodařilo načíst. */
  unavailable: boolean;
}

const SITE_COLUMNS =
  "id, name, timezone, dock_sn, armed_from, armed_to, armed_days, " +
  "map_image_url, map_nw_lat, map_nw_lon, map_se_lat, map_se_lon";

/** Sloupce schopností. Přidává je migrace 20260914120000. */
const CAPABILITY_COLUMNS = "has_drone, has_cameras";

/**
 * Jak se lokalita chová, dokud schopnosti v databázi nejsou.
 *
 * Dron ano, kamery ne — tedy přesně tak, jak portál vypadal předtím,
 * než modul stavebních kamer vznikl. Nasazení kódu dřív než migrace
 * tak nikomu nic neschová.
 */
const VYCHOZI_SCHOPNOSTI = { has_drone: true, has_cameras: false } as const;

/**
 * Načte lokality a vyhodnotí, která je vybraná.
 *
 * Bez cookie se bere první lokalita — s prázdným filtrem by portál po
 * přihlášení ukazoval detekce ze všech areálů najednou. Explicitní
 * volbu „všechny“ drží cookie s hodnotou ALL_SITES.
 */
// cache(): ptá se na to layout (přepínač a odznak střežení) i skoro
// každá stránka. Bez memoizace by to byl další dotaz navíc, a hlavně
// by si layout a stránka mohly vybrat jinou lokalitu, kdyby se mezi
// jejich dotazy něco změnilo.
export const getSiteSelection = cache(async function getSiteSelection(): Promise<SiteSelection> {
  const prazdno: SiteSelection = {
    sites: [], selected: null, rows: [], selectedRow: null, unavailable: true,
  };

  try {
    const supabase = await createClient();
    const dotaz = (sloupce: string) =>
      supabase.from("sites").select(sloupce).order("name").returns<SiteRow[]>();

    // Dvoustupňový výběr: schopnosti přidává ručně nasazovaná migrace
    // a PostgREST odmítne celý dotaz, když jediný sloupec chybí. Bez
    // záchytné větve by portál po nasazení kódu neuměl načíst ani
    // seznam lokalit — tedy vůbec nic.
    let { data, error } = await dotaz(`${SITE_COLUMNS}, ${CAPABILITY_COLUMNS}`);

    if (error) {
      ({ data, error } = await dotaz(SITE_COLUMNS));
      if (data) data = data.map((row) => ({ ...row, ...VYCHOZI_SCHOPNOSTI }));
    }

    if (error || !data) return prazdno;

    const rows = data;
    const sites: SiteOption[] = rows.map((row) => ({ id: row.id, name: row.name }));
    if (rows.length === 0) {
      return { sites, selected: null, rows, selectedRow: null, unavailable: false };
    }

    const preferred = (await cookies()).get(SITE_COOKIE)?.value;
    if (preferred === ALL_SITES) {
      return { sites, selected: null, rows, selectedRow: null, unavailable: false };
    }

    const selectedRow =
      (isSiteId(preferred) ? rows.find((s) => s.id === preferred) : undefined)
      // Cookie může ukazovat na lokalitu, ke které uživatel přišel
      // o přístup — pak se tiše vrátíme na první viditelnou.
      ?? rows[0];

    return {
      sites,
      selected: { id: selectedRow.id, name: selectedRow.name },
      rows,
      selectedRow,
      unavailable: false,
    };
  } catch {
    // Nenasazené schéma nebo chybějící konfigurace nesmí shodit stránku.
    return prazdno;
  }
});
