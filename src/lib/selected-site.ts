import { cookies } from "next/headers";

import { ALL_SITES, SITE_COOKIE, isSiteId, type SiteOption } from "./site.ts";
import { createClient } from "./supabase/server.ts";

// Načtení lokalit a vyhodnocení té vybrané. Server-only — sahá na
// cookies() i na databázi. Konstanty a typy jsou v site.ts, aby si je
// mohl vzít i klientský přepínač.

export interface SiteSelection {
  /** Lokality viditelné přihlášenému uživateli (přes RLS). */
  sites: SiteOption[];
  /** null = uživatel si vybral všechny lokality, nebo žádná neexistuje. */
  selected: SiteOption | null;
  /** true, když se seznam nepodařilo načíst. */
  unavailable: boolean;
}

/**
 * Načte lokality a vyhodnotí, která je vybraná.
 *
 * Bez cookie se bere první lokalita — s prázdným filtrem by portál po
 * přihlášení ukazoval detekce ze všech areálů najednou. Explicitní
 * volbu „všechny“ drží cookie s hodnotou ALL_SITES.
 */
export async function getSiteSelection(): Promise<SiteSelection> {
  try {
    const supabase = await createClient();
    const { data, error } = await supabase
      .from("sites")
      .select("id, name")
      .order("name");

    if (error || !data) {
      return { sites: [], selected: null, unavailable: true };
    }

    const sites: SiteOption[] = data;
    if (sites.length === 0) {
      return { sites, selected: null, unavailable: false };
    }

    const preferred = (await cookies()).get(SITE_COOKIE)?.value;
    if (preferred === ALL_SITES) {
      return { sites, selected: null, unavailable: false };
    }

    const selected =
      (isSiteId(preferred) ? sites.find((s) => s.id === preferred) : undefined)
      // Cookie může ukazovat na lokalitu, ke které uživatel přišel
      // o přístup — pak se tiše vrátíme na první viditelnou.
      ?? sites[0];

    return { sites, selected, unavailable: false };
  } catch {
    // Nenasazené schéma nebo chybějící konfigurace nesmí shodit stránku.
    return { sites: [], selected: null, unavailable: true };
  }
}
