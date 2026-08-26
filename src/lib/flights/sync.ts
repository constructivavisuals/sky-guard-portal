import type { SupabaseClient } from "@supabase/supabase-js";

import {
  getFlightTask,
  getFlightTrack,
  isTerminalStatus,
  listFlightMedia,
  type FhMediaFile,
} from "./flighthub-tasks.ts";
import {
  flightTimesFromTrack,
  mapFlightStatus,
  mediaContentType,
  mediaKindFromSuffix,
  mediaStoragePath,
} from "./sync-rules.ts";
import type { Database, Flight, FlightStatus } from "../../types/database.ts";

// Dotažení letu z FlightHubu.
//
// Volá se z /api/sync/flights. Jeden let = jedna funkce, protože
// selhání jednoho nesmí shodit ostatní — volající každé volání obalí
// vlastním try/catch a jede dál.

/** Bucket s médii z letů. Privátní, viz migrace 20260902120000. */
export const FLIGHT_BUCKET = "lety";

/** Jak dlouho platí podepsaná adresa média. */
export const MEDIA_SIGNED_URL_TTL = 600;

/**
 * Strop na jedno médium. Video z dronu v plné kvalitě může mít
 * stovky megabajtů; nad tímhle se soubor přeskočí a zaloguje, ať
 * synchronizace nespadne na paměti uprostřed dávky.
 */
export const MAX_MEDIA_BYTES = 512 * 1024 * 1024;

type Db = SupabaseClient<Database>;

/** Jen to, co synchronizace opravdu přepisuje. */
type FlightUpdate = Partial<
  Pick<
    Flight,
    | "fh_status"
    | "status"
    | "synced_at"
    | "trajectory"
    | "started_at"
    | "ended_at"
    | "duration_s"
    | "distance_m"
  >
>;

export interface FlightRow {
  id: string;
  site_id: string | null;
  fh_task_uuid: string | null;
  status: FlightStatus;
}

export interface FlightSyncResult {
  flightId: string;
  /** Stav z DJI, nebo null když se nepodařilo zjistit. */
  fhStatus: string | null;
  finished: boolean;
  mediaAdded: number;
  mediaSkipped: number;
  /** Popis toho, co se nepovedlo. Prázdné = v pořádku. */
  problems: string[];
}

/**
 * Dotáhne jeden let.
 *
 * Nikdy nevyhazuje výjimku kvůli FlightHubu — chyby se sbírají do
 * `problems`. Vyhodit ji smí jen selhání databáze, které volající
 * odchytí.
 */
export async function syncFlight(
  db: Db,
  flight: FlightRow,
): Promise<FlightSyncResult> {
  const result: FlightSyncResult = {
    flightId: flight.id,
    fhStatus: null,
    finished: false,
    mediaAdded: 0,
    mediaSkipped: 0,
    problems: [],
  };

  const taskUuid = flight.fh_task_uuid;
  if (!taskUuid) {
    result.problems.push("let nemá fh_task_uuid");
    return result;
  }

  // ── Detail ───────────────────────────────────────────────────
  const detail = await getFlightTask(taskUuid);
  if (!detail.ok) {
    result.problems.push(`detail: ${detail.message}`);
    // Razítko se zapíše i tak — jinak by se nedostupný let zkoušel
    // v každém běhu jako první a zdržoval ostatní.
    await db.from("flights").update({ synced_at: new Date().toISOString() })
      .eq("id", flight.id);
    return result;
  }

  result.fhStatus = detail.data.status;
  const terminal = isTerminalStatus(detail.data.status);

  const update: FlightUpdate = {
    fh_status: detail.data.status,
    status: mapFlightStatus(detail.data.status, flight.status),
    synced_at: new Date().toISOString(),
  };

  // ── Dokud úloha běží, trasa ani média nejsou hotová ───────────
  if (!terminal) {
    const { error } = await db.from("flights").update(update).eq("id", flight.id);
    if (error) throw new Error(`zápis letu: ${error.message}`);
    return result;
  }

  // ── Trajektorie ──────────────────────────────────────────────
  const track = await getFlightTrack(taskUuid);
  if (track.ok) {
    const times = flightTimesFromTrack(track.data);
    update.trajectory = {
      track_id: track.data.trackId,
      drone_sn: track.data.droneSn,
      flight_distance: track.data.flightDistance,
      flight_duration: track.data.flightDuration,
      points: track.data.points,
    };
    if (times.startedAt) update.started_at = times.startedAt.toISOString();
    if (times.endedAt) update.ended_at = times.endedAt.toISOString();
    if (times.durationS !== null) update.duration_s = times.durationS;
    if (times.distanceM !== null) update.distance_m = times.distanceM;
  } else {
    result.problems.push(`trasa: ${track.message}`);
  }

  // ended_at je podmínka, podle které se let příště vybere. Když ho
  // trasa nedala, dosadí se čas z detailu — jinak by se dokončený let
  // tahal pořád dokola.
  if (!update.ended_at) {
    const zaloha = detail.data.endAt ? new Date(detail.data.endAt) : null;
    update.ended_at =
      zaloha && !Number.isNaN(zaloha.getTime())
        ? zaloha.toISOString()
        : new Date().toISOString();
  }

  const { error: flightError } = await db
    .from("flights")
    .update(update)
    .eq("id", flight.id);
  if (flightError) throw new Error(`zápis letu: ${flightError.message}`);

  result.finished = true;

  // ── Média ────────────────────────────────────────────────────
  const media = await listFlightMedia(taskUuid);
  if (!media.ok) {
    result.problems.push(`média: ${media.message}`);
    return result;
  }

  for (const file of media.data) {
    try {
      const stav = await syncMediaFile(db, flight, file);
      if (stav === "added") result.mediaAdded += 1;
      else result.mediaSkipped += 1;
    } catch (error) {
      result.mediaSkipped += 1;
      result.problems.push(
        `médium ${file.uuid}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return result;
}

type MediaOutcome = "added" | "skipped";

/**
 * Přenese jeden soubor.
 *
 * Idempotence stojí na fh_media_id: co už v databázi je, se nestahuje
 * podruhé. Kontrola je před stažením, ne až při zápisu — jinak by
 * opakovaný běh tahal gigabajty jen proto, aby je zahodil na
 * unikátním indexu.
 */
async function syncMediaFile(
  db: Db,
  flight: FlightRow,
  file: FhMediaFile,
): Promise<MediaOutcome> {
  const { data: existing, error: lookupError } = await db
    .from("media")
    .select("id")
    .eq("fh_media_id", file.uuid)
    .maybeSingle();

  if (lookupError) throw new Error(lookupError.message);
  if (existing) return "skipped";

  const kind = mediaKindFromSuffix(file.suffix);
  if (!kind) return "skipped";

  const contentType = mediaContentType(file.suffix);
  if (!contentType) return "skipped";

  if (!file.originalUrl) throw new Error("chybí original_url");
  if (file.size !== null && file.size > MAX_MEDIA_BYTES) {
    throw new Error(`soubor je větší než ${MAX_MEDIA_BYTES} B`);
  }
  if (!flight.site_id) throw new Error("let nemá lokalitu, není kam soubor uložit");

  const response = await fetch(file.originalUrl, { cache: "no-store" });
  if (!response.ok) throw new Error(`stažení: HTTP ${response.status}`);

  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_MEDIA_BYTES) {
    throw new Error(`stažený soubor je větší než ${MAX_MEDIA_BYTES} B`);
  }

  const path = mediaStoragePath(flight.site_id, flight.id, file.uuid, file.suffix);

  const { error: uploadError } = await db.storage
    .from(FLIGHT_BUCKET)
    .upload(path, bytes, { contentType, upsert: true });
  if (uploadError) throw new Error(`nahrání: ${uploadError.message}`);

  const captured = file.createAt ? new Date(file.createAt) : null;

  const { error: insertError } = await db.from("media").insert({
    flight_id: flight.id,
    kind,
    r2_key: path,
    fh_media_id: file.uuid,
    captured_at:
      captured && !Number.isNaN(captured.getTime()) ? captured.toISOString() : null,
    size_bytes: bytes.byteLength,
    meta: {
      name: file.name,
      suffix: file.suffix,
      preview_url: file.previewUrl,
      reported_size: file.size,
    },
  });

  if (insertError) {
    // 23505 = mezitím ho stihl vložit souběžný běh. Soubor v úložišti
    // je stejný (upsert), takže není co uklízet.
    if (insertError.code === "23505") return "skipped";
    throw new Error(`zápis média: ${insertError.message}`);
  }

  return "added";
}
