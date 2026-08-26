import type { FhTrack } from "./flighthub-tasks.ts";
import type { FlightStatus, MediaKind } from "../../types/database.ts";

// Čistá pravidla synchronizace — bez sítě a bez databáze, aby šla
// otestovat. I/O je v sync.ts.

/**
 * Stav DJI → náš flight_status.
 *
 * Mapování je ZTRÁTOVÉ: „executing“ i „paused“ jsou u nás
 * 'in_progress', „terminated“ i „timeout“ jsou 'aborted'. Původní
 * hodnota se proto ukládá vedle do flights.fh_status — bez ní by po
 * synchronizaci nešlo zjistit, jestli let někdo přerušil, nebo vypršel.
 *
 * Neznámý stav nechává let tam, kde je. Nová hodnota v DJI nesmí
 * znamenat, že se let tiše prohlásí za dokončený.
 */
export function mapFlightStatus(
  fhStatus: string | null,
  current: FlightStatus,
): FlightStatus {
  switch (fhStatus) {
    case "waiting":
      return "pending";
    case "executing":
    case "paused":
    case "suspended":
      return "in_progress";
    case "success":
      return "completed";
    case "terminated":
    case "timeout":
      return "aborted";
    case "starting_failure":
      return "failed";
    default:
      return current;
  }
}

/** Přípona souboru → náš media_kind. */
const VIDEO_SUFFIXES = new Set(["mp4", "mov", "m4v", "mkv", "avi"]);
const PHOTO_SUFFIXES = new Set(["jpg", "jpeg", "png", "webp", "dng", "tif", "tiff"]);

/**
 * Druh média podle přípony.
 *
 * Vrací null u toho, co neumíme zařadit — třeba PPK, které DJI
 * v seznamu vrací taky. Takový soubor se nestahuje: media_kind má jen
 * photo a video a nacpat tam něco třetího by znamenalo lhát v UI.
 */
export function mediaKindFromSuffix(suffix: string | null): MediaKind | null {
  if (!suffix) return null;
  const s = suffix.replace(/^\./, "").toLowerCase();
  if (VIDEO_SUFFIXES.has(s)) return "video";
  if (PHOTO_SUFFIXES.has(s)) return "photo";
  return null;
}

/** MIME typ pro úložiště. Bucket jiné typy nepřijme. */
export function mediaContentType(suffix: string | null): string | null {
  const s = (suffix ?? "").replace(/^\./, "").toLowerCase();
  switch (s) {
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "png":
      return "image/png";
    case "webp":
      return "image/webp";
    case "mp4":
    case "m4v":
      return "video/mp4";
    case "mov":
      return "video/quicktime";
    default:
      return null;
  }
}

export interface FlightTimes {
  startedAt: Date | null;
  endedAt: Date | null;
  durationS: number | null;
  distanceM: number | null;
}

/**
 * Skutečné časy letu z trajektorie.
 *
 * Detail úlohy je NEVRACÍ — jeho begin_at/end_at jsou plánované časy
 * (ověřeno v dokumentaci). Odletěný začátek a konec se proto berou
 * z krajních bodů trasy, které nesou vlastní časová razítka.
 *
 * `flight_duration` z trasy má přednost před rozdílem časů: dokumentace
 * ho uvádí jako dobu letu, kdežto rozdíl krajních bodů je jen tak
 * přesný, jak hustě dron vzorkoval.
 */
export function flightTimesFromTrack(track: FhTrack): FlightTimes {
  const casy = track.points
    .map((p) => p.timestamp)
    .filter((t) => Number.isFinite(t) && t > 0)
    .sort((a, b) => a - b);

  const startedAt = casy.length > 0 ? fromTimestamp(casy[0]) : null;
  const endedAt = casy.length > 0 ? fromTimestamp(casy[casy.length - 1]) : null;

  let durationS = track.flightDuration;
  if (durationS === null && startedAt && endedAt) {
    durationS = Math.round((endedAt.getTime() - startedAt.getTime()) / 1000);
  }

  return {
    startedAt,
    endedAt,
    durationS: durationS !== null && durationS >= 0 ? Math.round(durationS) : null,
    distanceM:
      track.flightDistance !== null && track.flightDistance >= 0
        ? track.flightDistance
        : null,
  };
}

/**
 * Časové razítko z trasy na datum.
 *
 * DJI posílá sekundy i milisekundy podle modelu a nikde to neříká.
 * Rozlišuje se podle řádu: hodnota pod deseti miliardami je sekundová
 * (rok 2286 je 9,9e9), nad ní milisekundová. Bez toho by lety
 * z jednoho doku vycházely v roce 1970 a z druhého správně.
 */
export function fromTimestamp(value: number): Date | null {
  if (!Number.isFinite(value) || value <= 0) return null;
  const ms = value < 10_000_000_000 ? value * 1000 : value;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Cesta média v úložišti.
 *
 * Stejný vzor jako u vjezdů: první složka je UUID lokality, takže
 * čtení pouští táž funkce jako u řádků. Druhá je let, ať jde smazat
 * jedním prefixem.
 */
export function mediaStoragePath(
  siteId: string,
  flightId: string,
  fhMediaId: string,
  suffix: string | null,
): string {
  const pripona = (suffix ?? "bin").replace(/^\./, "").toLowerCase();
  // fhMediaId je UUID od DJI; do cesty se dává očištěné, ať se do ní
  // nedostane lomítko a soubor neskončí v cizí složce.
  const bezpecne = fhMediaId.replace(/[^A-Za-z0-9_-]/g, "");
  return `${siteId}/${flightId}/${bezpecne}.${pripona}`;
}
