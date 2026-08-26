import { distanceMeters, type LatLon } from "../geo.ts";
import { fromTimestamp } from "./sync-rules.ts";
import type { Json } from "../../types/database.ts";

// Čtení trajektorie z flights.trajectory.
//
// Sloupec je jsonb, tedy z pohledu TypeScriptu `unknown` s hezčím
// jménem: zapsala ho synchronizace, ale mohla ho zapsat starší verze
// kódu nebo ruční oprava. Všechno se proto probírá po jednom poli
// a co nesedí, se zahazuje — polovina bodu je horší než žádný.

export interface TrackPoint {
  /** Razítko od DJI. Sekundy i milisekundy, viz fromTimestamp. */
  timestamp: number;
  latitude: number;
  longitude: number;
  /** Výška nad vzletem v metrech. DJI ji nemusí poslat. */
  height: number | null;
}

/**
 * Číslo, nebo null.
 *
 * Přes Number() se to napsat nedá: Number(null), Number("") i Number([])
 * jsou nula. Chybějící výška by pak z dronu udělala stroj, který letěl
 * přesně v nule — a to je tvrzení, ne chybějící údaj.
 */
function num(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Body trasy seřazené v čase.
 *
 * Řadí se tady, ne až u vykreslení: pořadí v jsonb je pořadí, v jakém
 * je poslalo DJI, a spojnice bodů přeházených v čase by nakreslila
 * cikcak přes celý areál.
 */
export function trajectoryPoints(trajectory: Json | null): TrackPoint[] {
  if (typeof trajectory !== "object" || trajectory === null || Array.isArray(trajectory)) {
    return [];
  }

  const raw = (trajectory as { points?: unknown }).points;
  if (!Array.isArray(raw)) return [];

  const points: TrackPoint[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const p = item as Record<string, unknown>;

    const timestamp = num(p.timestamp);
    const latitude = num(p.latitude);
    const longitude = num(p.longitude);
    if (timestamp === null || latitude === null || longitude === null) continue;
    if (latitude < -90 || latitude > 90) continue;
    if (longitude < -180 || longitude > 180) continue;

    points.push({ timestamp, latitude, longitude, height: num(p.height) });
  }

  return points.sort((a, b) => a.timestamp - b.timestamp);
}

/**
 * Nejvyšší dosažená výška v metrech, nebo null když ji dron nehlásil.
 *
 * Záporná výška se nezahazuje: dron může letět pod úrovní vzletu
 * (svah, výkop) a useknout to na nule by lhalo.
 */
export function maxHeight(points: readonly TrackPoint[]): number | null {
  let max: number | null = null;
  for (const point of points) {
    if (point.height === null) continue;
    if (max === null || point.height > max) max = point.height;
  }
  return max;
}

/** Jak blízko musí dron být, aby se počítalo, že doletěl. */
export const ARRIVAL_RADIUS_M = 50;

/**
 * Kdy dron poprvé doletěl k cíli.
 *
 * Bere PRVNÍ bod v okruhu, ne nejbližší: zajímá nás okamžik, kdy byl
 * dron na místě, ne kdy byl nejblíž. Na zpáteční cestě přes zónu
 * proletí znovu a nejbližší bod může být až z ní.
 *
 * Vrací null, když se dron do okruhu nikdy nedostal — třeba když
 * misi někdo přerušil.
 *
 * Pozor na jeden případ: když dok stojí do padesáti metrů od zóny,
 * je „doletěl“ hned první bod, tedy vzlet. Není to chyba výpočtu,
 * jen malý areál — proto se čas doletu ukazuje vedle času vzletu.
 */
export function arrivalAt(
  points: readonly TrackPoint[],
  target: LatLon,
  radiusM: number = ARRIVAL_RADIUS_M,
): Date | null {
  for (const point of points) {
    const distance = distanceMeters(point, target);
    if (distance === null) continue;
    if (distance <= radiusM) return fromTimestamp(point.timestamp);
  }
  return null;
}
