// Sběr bodů pro podklad areálu.
//
// Zóny a kamery jdou z databáze přes RLS, dok z FlightHubu (přes 60s
// cache, aby se stav doku nečetl dvakrát na jedné obrazovce).

import type { AreaMapPoint, MapBounds } from "@/lib/area-map.ts";
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
    // Vypnutá zóna se nekreslí vůbec. Detekce z ní zásah nespustí,
    // takže na mapě střežení nemá co dělat — utlumený bod by jen
    // přidával šum k tomu, co se doopravdy hlídá.
    if (!zone.enabled) continue;

    const at = parsePointEwkbHex(zone.location);
    if (!at) continue;
    points.push({
      id: `zone-${zone.id}`,
      latitude: at.latitude,
      longitude: at.longitude,
      label: zone.name,
      kind: "zone",
      href: "/zony",
    });
  }

  const { data: cameras } = await supabase
    .from("cameras")
    .select("id, name, location, azimuth, focal_mm, range_m, status")
    .eq("site_id", site.id)
    .order("name")
    .returns<
      {
        id: string;
        name: string;
        location: string | null;
        azimuth: number | null;
        focal_mm: number | null;
        range_m: number;
        status: string;
      }[]
    >();

  for (const camera of cameras ?? []) {
    const at = parsePointEwkbHex(camera.location);
    // Kamera bez zaměření se nedá umístit, tak se vynechá úplně.
    // Bez azimutu se umístit dá — nakreslí se bod bez výseče.
    if (!at) continue;
    points.push({
      id: `camera-${camera.id}`,
      latitude: at.latitude,
      longitude: at.longitude,
      label: camera.name,
      kind: "camera",
      muted: camera.status !== "online",
      href: "/kamery",
      azimuth: camera.azimuth,
      focalMm: camera.focal_mm,
      rangeM: camera.range_m,
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
