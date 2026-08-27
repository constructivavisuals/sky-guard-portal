import { cache } from "react";

import { DEFAULT_RTH_ALTITUDE } from "@/lib/dispatch/flighthub.ts";

import { AREA_MAP_SITE_COLUMNS, loadAreaMap, type AreaMapData } from "@/lib/area-map-data.ts";
import { createClient } from "@/lib/supabase/server.ts";
import type { IsoWeekday } from "@/types/database.ts";

// Načtení areálu pro všechny karty.
//
// cache(): ptá se na to layout (hlavička a mapa) i každá karta zvlášť.
// Bez memoizace by to byly tři dotazy na jedno zobrazení, a hlavně tři
// volání do FlightHubu na stav doku.

export interface SiteDetail {
  id: string;
  name: string;
  address: string | null;
  timezone: string;
  armed_from: string;
  armed_to: string;
  armed_days: IsoWeekday[];
  cooldown_seconds: number;
  retention_days: number;
  /** Migrace 20260916120000; bez ní se čte výchozích 60 m. */
  rth_altitude: number;
  dock_sn: string | null;
  drone_sn: string | null;
  fh_project_uuid: string | null;
  fh_workflow_uuid: string | null;
  map_image_url: string | null;
  map_nw_lat: number | null;
  map_nw_lon: number | null;
  map_se_lat: number | null;
  map_se_lon: number | null;
  zones: { count: number }[];
  cameras: { count: number }[];
}

const COLUMNS =
  "id, name, address, timezone, armed_from, armed_to, armed_days, cooldown_seconds, retention_days, " +
  `dock_sn, drone_sn, fh_project_uuid, fh_workflow_uuid, ${AREA_MAP_SITE_COLUMNS}, ` +
  "zones(count), cameras(count)";

/** S výškou návratu. Přidává ji migrace 20260916120000. */
const COLUMNS_S_VYSKOU = `${COLUMNS}, rth_altitude`;

export interface ArealData {
  site: SiteDetail | null;
  map: AreaMapData | null;
  armed: boolean | null;
  /** true = dotaz selhal; odlišuje se od „lokalita neexistuje“. */
  failed: boolean;
}

export const nactiAreal = cache(async (id: string): Promise<ArealData> => {
  try {
    const supabase = await createClient();
    const dotaz = (sloupce: string) =>
      supabase.from("sites").select(sloupce).eq("id", id).maybeSingle<SiteDetail>();

    // Dvoustupňový výběr: bez záchytné větve by chybějící sloupec
    // zavřel celý detail areálu, ne jen jedno pole formuláře.
    let { data, error } = await dotaz(COLUMNS_S_VYSKOU);
    if (error) {
      ({ data, error } = await dotaz(COLUMNS));
      if (data) data = { ...data, rth_altitude: DEFAULT_RTH_ALTITUDE };
    }

    // RLS nerozlišuje „neexistuje“ a „nevidíš na ni“ — obojí je prázdno.
    if (error) return { site: null, map: null, armed: null, failed: true };
    if (!data) return { site: null, map: null, armed: null, failed: false };

    const [map, armed] = await Promise.all([
      loadAreaMap(supabase, data),
      supabase
        .rpc("site_is_armed", { p_site_id: id })
        .then(({ data: value, error: rpcError }) => (rpcError ? null : value === true)),
    ]);

    return { site: data, map, armed, failed: false };
  } catch {
    return { site: null, map: null, armed: null, failed: true };
  }
});
