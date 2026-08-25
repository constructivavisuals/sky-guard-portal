// Sběr bodů pro podklad areálu.
//
// Zóny jdou z databáze přes RLS, dok z FlightHubu (přes 60s cache, aby
// se stav doku nečetl dvakrát na jedné obrazovce). Kamery zatím
// souřadnice nemají — doplní se po montáži spolu s azimutem.

import type { MapBounds } from "@/lib/area-map.ts";
import type { AreaMapPoint } from "@/components/area-map.tsx";
import { getDockStateCached } from "@/lib/dispatch/dock-cache.ts";
import { parsePointEwkbHex } from "@/lib/geo.ts";
import type { SupabaseClient } from "@supabase/supabase-js";

export interface AreaMapData {
  imageUrl: string | null;
  bounds: MapBounds | null;
  points: AreaMapPoint[];
}

export interface AreaMapSite {
  id: string;
  name: string;
  dock_sn: string | null;
  map_image_url: string | null;
  map_nw_lat: number | null;
  map_nw_lon: number | null;
  map_se_lat: number | null;
  map_se_lon: number | null;
}

/** Rohy dávají smysl jen v úplné čtveřici; CHECK v databázi to hlídá. */
export function siteBounds(site: AreaMapSite): MapBounds | null {
  const { map_nw_lat, map_nw_lon, map_se_lat, map_se_lon } = site;
  if (
    map_nw_lat === null ||
    map_nw_lon === null ||
    map_se_lat === null ||
    map_se_lon === null
  ) {
    return null;
  }
  return {
    nwLat: map_nw_lat,
    nwLon: map_nw_lon,
    seLat: map_se_lat,
    seLon: map_se_lon,
  };
}

/** Sloupce, které si stránka musí od `sites` vyžádat. */
export const AREA_MAP_SITE_COLUMNS =
  "map_image_url, map_nw_lat, map_nw_lon, map_se_lat, map_se_lon";

export async function loadAreaMap(
  supabase: SupabaseClient,
  site: AreaMapSite,
  options: { dockLocation?: { latitude: number | null; longitude: number | null } | null } = {},
): Promise<AreaMapData> {
  const bounds = siteBounds(site);
  if (!site.map_image_url || !bounds) {
    return { imageUrl: site.map_image_url, bounds, points: [] };
  }

  const points: AreaMapPoint[] = [];

  const { data: zones } = await supabase
    .from("zones")
    .select("id, name, location, enabled")
    .eq("site_id", site.id)
    .order("name")
    .returns<{ id: string; name: string; location: string | null; enabled: boolean }[]>();

  for (const zone of zones ?? []) {
    const at = parsePointEwkbHex(zone.location);
    if (!at) continue;
    points.push({
      id: `zone-${zone.id}`,
      latitude: at.latitude,
      longitude: at.longitude,
      label: zone.name,
      kind: "zone",
      muted: !zone.enabled,
      href: "/zony",
    });
  }

  // Dok se čte, jen když ho volající sám nedodal — přehled už jeho stav
  // má a druhé volání by bylo zbytečné.
  let dockAt = options.dockLocation ?? null;
  if (dockAt === null && site.dock_sn) {
    const cached = await getDockStateCached(site.dock_sn);
    if (cached.result.ok) {
      dockAt = {
        latitude: cached.result.state.latitude,
        longitude: cached.result.state.longitude,
      };
    }
  }

  if (
    dockAt &&
    typeof dockAt.latitude === "number" &&
    typeof dockAt.longitude === "number"
  ) {
    points.push({
      id: "dock",
      latitude: dockAt.latitude,
      longitude: dockAt.longitude,
      label: "Dok",
      kind: "dock",
      href: "/lety",
    });
  }

  return { imageUrl: site.map_image_url, bounds, points };
}
