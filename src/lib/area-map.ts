// Promítnutí souřadnic na statický podklad areálu.
//
// Podklad je obrázek ohraničený dvěma rohy. Pozice se počítá lineárně
// z rozsahu, takže obrázek musí být do rámečku roztažený
// (object-fit: fill), ne oříznutý — při cover by se body rozešly
// s tím, co je pod nimi vidět.
//
// Lineární projekce ve stupních není kartograficky přesná: stupeň
// délky je v naší šířce kratší než stupeň šířky. Na ploše dvou set
// metrů je ta odchylka zanedbatelná a výhoda je, že podklad může být
// jakýkoli obrázek, ne dlaždice z mapového serveru.

export interface MapBounds {
  nwLat: number;
  nwLon: number;
  seLat: number;
  seLon: number;
}

export interface MapPosition {
  /** Podíl šířky rámečku, 0 vlevo. */
  x: number;
  /** Podíl výšky rámečku, 0 nahoře. */
  y: number;
}

/** Jsou rohy zadané tak, aby se dalo počítat? */
export function boundsAreUsable(bounds: MapBounds | null): bounds is MapBounds {
  if (!bounds) return false;
  const values = [bounds.nwLat, bounds.nwLon, bounds.seLat, bounds.seLon];
  if (!values.every((value) => typeof value === "number" && Number.isFinite(value))) {
    return false;
  }
  // Nulový rozsah by znamenal dělení nulou.
  return bounds.seLon !== bounds.nwLon && bounds.seLat !== bounds.nwLat;
}

/**
 * Poměr stran výřezu ve stupních.
 *
 * Schválně ve stupních, ne v metrech: rámeček se tím zarovná se stejnou
 * soustavou, ve které se počítají pozice bodů.
 */
export function boundsAspectRatio(bounds: MapBounds): number {
  return Math.abs(bounds.seLon - bounds.nwLon) / Math.abs(bounds.nwLat - bounds.seLat);
}

/**
 * Pozice bodu v rámečku, nebo null když leží mimo výřez.
 *
 * Body mimo rozsah se nevykreslují — přilepené k okraji by lhaly
 * o tom, kde doopravdy jsou.
 */
export function projectPoint(
  bounds: MapBounds,
  latitude: number,
  longitude: number,
): MapPosition | null {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;

  // + 0 normalizuje -0 na 0: dělení nuly záporným rozsahem dá zápornou
  // nulu, která by se do stylu propsala jako "-0%".
  const x = (longitude - bounds.nwLon) / (bounds.seLon - bounds.nwLon) + 0;
  const y = (latitude - bounds.nwLat) / (bounds.seLat - bounds.nwLat) + 0;

  if (x < 0 || x > 1 || y < 0 || y > 1) return null;
  return { x, y };
}
