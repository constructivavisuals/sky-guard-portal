// Promítnutí souřadnic na statický podklad areálu.
//
// Podklad je obrázek ohraničený dvěma rohy. Pozice se počítá lineárně
// z rozsahu, takže obrázek musí být do rámečku roztažený
// (object-fit: fill), ne oříznutý — při cover by se body rozešly
// s tím, co je pod nimi vidět.
//
// Projekce zůstává lineární ve stupních — na ploše dvou set metrů je
// odchylka od skutečné mapové projekce zanedbatelná a výhoda je, že
// podklad může být jakýkoli obrázek, ne dlaždice z mapového serveru.
//
// Poměr stran rámečku se ale počítá v metrech, ne ve stupních. Stupeň
// délky je na 50° s. š. jen ~0,64 stupně šířky, takže výřez široký
// 1,798 stupňového poměru je ve skutečnosti 1,15 metrového. Fotka
// zachycuje metry, takže rámeček musí být metrový — jinak by se
// obrázek roztažením deformoval.

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
 * Poměr stran výřezu v metrech.
 *
 * Rozsah zeměpisné délky se přepočítá kosinem průměrné šířky rohů —
 * poledníky se k pólům sbíhají, takže stupeň délky je kratší než
 * stupeň šířky. Bez toho by rámeček vycházel příliš široký a fotka
 * by se do něj vodorovně protáhla.
 *
 * Pro projekci bodů se tenhle přepočet nedělá: obě osy se škálují
 * stejnou konstantou, takže se poměry uvnitř výřezu nemění.
 */
export function boundsAspectRatio(bounds: MapBounds): number {
  const latSpan = Math.abs(bounds.nwLat - bounds.seLat);
  const lonSpan = Math.abs(bounds.seLon - bounds.nwLon);
  const meanLatRad = (((bounds.nwLat + bounds.seLat) / 2) * Math.PI) / 180;
  return (lonSpan * Math.cos(meanLatRad)) / latSpan;
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
