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

/** Bod na podkladu areálu. */
export interface AreaMapPoint {
  id: string;
  latitude: number;
  longitude: number;
  label: string;
  kind: "dock" | "zone" | "camera";
  /** Offline kamera se kreslí utlumeně. */
  muted?: boolean;
  href?: string;
  /** Kam kamera kouká. Bez azimutu se kreslí jen bod bez výseče. */
  azimuth?: number | null;
  /** Ohnisko v mm; zorný úhel se z něj dopočítává. */
  focalMm?: number | null;
  rangeM?: number | null;
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

/** Délka stupně zeměpisné šířky. Na naší ploše stačí konstanta. */
const METERS_PER_DEGREE = 111_320;

export interface MapSpan {
  /** Šířka výřezu v metrech. */
  width: number;
  /** Výška výřezu v metrech. */
  height: number;
}

/**
 * Rozměr výřezu v metrech.
 *
 * Rozsah zeměpisné délky se přepočítá kosinem průměrné šířky rohů —
 * poledníky se k pólům sbíhají, takže stupeň délky je kratší než
 * stupeň šířky. Bez toho by výřez vycházel příliš široký.
 */
export function boundsSpanMeters(bounds: MapBounds): MapSpan {
  const meanLatRad = (((bounds.nwLat + bounds.seLat) / 2) * Math.PI) / 180;
  return {
    width:
      Math.abs(bounds.seLon - bounds.nwLon) *
      Math.cos(meanLatRad) *
      METERS_PER_DEGREE,
    height: Math.abs(bounds.nwLat - bounds.seLat) * METERS_PER_DEGREE,
  };
}

/**
 * Poměr stran výřezu, počítaný z metrů.
 *
 * Pro projekci bodů se přepočet na metry nedělá: obě osy by škálovala
 * stejná konstanta, takže se poměry uvnitř výřezu nemění.
 */
export function boundsAspectRatio(bounds: MapBounds): number {
  const { width, height } = boundsSpanMeters(bounds);
  return width / height;
}

/**
 * Vodorovný zorný úhel objektivu ve stupních.
 *
 * Čísla jsou z katalogu Dahua, ne z tenké čočky — širokoúhlé objektivy
 * mají zkreslením záběr širší, než by vzorec dal. Mezi tabulkovými
 * ohnisky se proto interpoluje a teprve nad 6 mm, kde už zkreslení
 * nehraje roli, se přechází na vzorec se snímačem 5,6 mm (v 6 mm na
 * tabulku navazuje spojitě).
 */
const FOCAL_FOV: readonly (readonly [number, number])[] = [
  [2.8, 106],
  [3.6, 87],
  [6, 50],
];
const SENSOR_WIDTH_MM = 5.6;

export function fieldOfViewDegrees(focalMm: number | null): number | null {
  if (focalMm === null || !Number.isFinite(focalMm) || focalMm <= 0) return null;

  const first = FOCAL_FOV[0];
  const last = FOCAL_FOV[FOCAL_FOV.length - 1];

  // Pod nejširším tabulkovým objektivem se nedopočítává — takový
  // objektiv v katalogu není a extrapolace by si vymýšlela.
  if (focalMm <= first[0]) return first[1];

  if (focalMm > last[0]) {
    return (2 * Math.atan(SENSOR_WIDTH_MM / (2 * focalMm)) * 180) / Math.PI;
  }

  for (let i = 1; i < FOCAL_FOV.length; i++) {
    const [fa, va] = FOCAL_FOV[i - 1];
    const [fb, vb] = FOCAL_FOV[i];
    if (focalMm <= fb) {
      return va + ((vb - va) * (focalMm - fa)) / (fb - fa);
    }
  }
  return last[1];
}

/**
 * Výseč záběru kamery jako SVG path.
 *
 * Souřadnice jsou v metrech, ve stejné soustavě jako `boundsSpanMeters`:
 * x roste na východ, y na jih. Protože rámeček má poměr stran počítaný
 * taky z metrů, jsou jednotky na obrazovce čtvercové a výseč vyjde jako
 * kruhová — kdyby se kreslila ve stupních, natáhla by se do šířky.
 *
 * Azimut je 0 na sever, 90 na východ.
 */
export function sectorPath(
  center: { x: number; y: number },
  azimuthDegrees: number,
  fovDegrees: number,
  rangeMeters: number,
): string | null {
  if (![azimuthDegrees, fovDegrees, rangeMeters].every(Number.isFinite)) return null;
  if (fovDegrees <= 0 || rangeMeters <= 0) return null;

  // Nad 360° už je to celý kruh; víc by se path zauzlila.
  const fov = Math.min(fovDegrees, 360);
  const half = fov / 2;

  const at = (bearing: number) => {
    const rad = (bearing * Math.PI) / 180;
    return {
      x: center.x + rangeMeters * Math.sin(rad),
      y: center.y - rangeMeters * Math.cos(rad),
    };
  };

  const round = (value: number) => Math.round(value * 100) / 100;

  // Celý kruh nejde nakreslit jedním obloukem — začátek by splynul
  // s koncem a prohlížeč by nevykreslil nic.
  if (fov >= 360) {
    const top = at(0);
    const bottom = at(180);
    return (
      `M ${round(top.x)} ${round(top.y)} ` +
      `A ${round(rangeMeters)} ${round(rangeMeters)} 0 0 1 ${round(bottom.x)} ${round(bottom.y)} ` +
      `A ${round(rangeMeters)} ${round(rangeMeters)} 0 0 1 ${round(top.x)} ${round(top.y)} Z`
    );
  }

  const start = at(azimuthDegrees - half);
  const end = at(azimuthDegrees + half);
  const largeArc = fov > 180 ? 1 : 0;

  // sweep 1 = po směru hodinových ručiček. Na obrazovce roste y dolů,
  // takže rostoucí azimut je vizuálně po směru.
  return (
    `M ${round(center.x)} ${round(center.y)} ` +
    `L ${round(start.x)} ${round(start.y)} ` +
    `A ${round(rangeMeters)} ${round(rangeMeters)} 0 ${largeArc} 1 ${round(end.x)} ${round(end.y)} Z`
  );
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

/** Trasa letu promítnutá do rámečku. */
export interface ProjectedTrack {
  /**
   * Souvislé úseky. Bod mimo výřez úsek uzavře a další začne až za
   * ním — spojnice přes zahozený kus by nakreslila cestu, kterou dron
   * neletěl.
   */
  segments: MapPosition[][];
  /** První a poslední bod uvnitř výřezu; null, když v něm žádný není. */
  start: MapPosition | null;
  end: MapPosition | null;
  /** Kolik bodů leželo mimo výřez. */
  skipped: number;
}

/**
 * Promítne trasu letu.
 *
 * Body mimo výřez se zahazují stejně jako u značek — přilepené
 * k okraji by lhaly o tom, kudy dron letěl. Zahození ale trasu
 * rozdělí, místo aby ji zkrátilo: kdyby se zbylé body prostě spojily,
 * vznikla by přímka přes území, kde se ve skutečnosti letělo obloukem
 * mimo podklad.
 *
 * Osamocený bod v úseku nezůstává: čára se z jednoho bodu nakreslit
 * nedá a tečka by vypadala jako značka.
 */
export function projectTrack(
  bounds: MapBounds,
  points: readonly { latitude: number; longitude: number }[],
): ProjectedTrack {
  const segments: MapPosition[][] = [];
  let current: MapPosition[] = [];
  let start: MapPosition | null = null;
  let end: MapPosition | null = null;
  let skipped = 0;

  const uzavrit = () => {
    if (current.length >= 2) segments.push(current);
    current = [];
  };

  for (const point of points) {
    const position = projectPoint(bounds, point.latitude, point.longitude);
    if (!position) {
      skipped += 1;
      uzavrit();
      continue;
    }
    if (!start) start = position;
    end = position;
    current.push(position);
  }
  uzavrit();

  return { segments, start, end, skipped };
}

/** Úsek trasy na SVG path v metrové soustavě. */
export function trackPath(segment: readonly MapPosition[], span: MapSpan): string {
  const round = (value: number) => Math.round(value * 100) / 100;
  return segment
    .map(
      (position, index) =>
        `${index === 0 ? "M" : "L"} ${round(position.x * span.width)} ${round(
          position.y * span.height,
        )}`,
    )
    .join(" ");
}
