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
import {
  combineThreatReadings,
  MAX_THREAT_IMAGE_BYTES,
  MAX_THREAT_PHOTOS,
  readThreatFromImage,
  type ThreatReading,
} from "./threat.ts";
import { FLIGHT_BUCKET, MAX_MEDIA_BYTES } from "./storage.ts";
import type { Database, Flight, FlightStatus } from "../../types/database.ts";

// Dotažení letu z FlightHubu.
//
// Volá se z /api/sync/flights. Jeden let = jedna funkce, protože
// selhání jednoho nesmí shodit ostatní — volající každé volání obalí
// vlastním try/catch a jede dál.

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
  /** Výsledek kontroly snímků, nebo null když neproběhla. */
  threatConfirmed: boolean | null;
  threatChecked: boolean;
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
    threatConfirmed: null,
    threatChecked: false,
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

  // ── Potvrzení nebezpečí ──────────────────────────────────────
  // Až po médiích: kontroluje se to, co se právě stáhlo.
  const threat = await checkFlightThreat(db, flight);
  result.threatChecked = threat.checked;
  result.threatConfirmed = threat.confirmed;
  result.problems.push(...threat.problems);

  return result;
}

export interface ThreatCheckResult {
  /** Proběhla kontrola natolik, že se zapsala? */
  checked: boolean;
  confirmed: boolean | null;
  /** Kolik snímků se opravdu přečetlo a kolik se přeskočilo. */
  read: number;
  skipped: number;
  problems: string[];
}

interface PhotoRow {
  id: string;
  storage_path: string;
}

/**
 * Projde fotky z letu modelem a zapíše závěr.
 *
 * Volá se z synchronizace hned po stažení médií a taky samostatně na
 * dokončené lety, u kterých kontrola dřív selhala — proto je vystavená.
 *
 * Když se nepodaří přečíst ANI JEDEN snímek, razítko se nezapisuje.
 * Chybějící klíč k API nebo výpadek nesmí skončit jako „zkontrolováno,
 * výsledek nejistý“ — to by znamenalo, že se na let už nikdo nepodívá.
 */
export async function checkFlightThreat(
  db: Db,
  flight: Pick<FlightRow, "id">,
): Promise<ThreatCheckResult> {
  const result: ThreatCheckResult = {
    checked: false,
    confirmed: null,
    read: 0,
    skipped: 0,
    problems: [],
  };

  const { data: photos, count, error } = await db
    .from("media")
    .select("id, storage_path", { count: "exact" })
    .eq("flight_id", flight.id)
    .eq("kind", "photo")
    .order("captured_at", { ascending: true, nullsFirst: false })
    .limit(MAX_THREAT_PHOTOS)
    .returns<PhotoRow[]>();

  if (error) throw new Error(`načtení fotek: ${error.message}`);

  const celkem = count ?? photos?.length ?? 0;
  if (celkem > MAX_THREAT_PHOTOS) {
    // Tiché useknutí by vypadalo jako „prošli jsme všechno“.
    console.info("Kontrola snímků bere jen část fotek z letu", {
      flight_id: flight.id,
      celkem,
      kontrolovano: MAX_THREAT_PHOTOS,
    });
  }

  const readings: ThreatReading[] = [];
  let selhani = 0;

  for (const photo of photos ?? []) {
    const image = await stahnoutSnimek(db, photo);
    if (!image) {
      result.skipped += 1;
      continue;
    }

    const reading = await readThreatFromImage(image);
    if (!reading) {
      // Selhání volání, ne odpověď „nevím“. Obojí končí jako nejistý
      // snímek, ale tohle rozhoduje, jestli se kontrola zapíše.
      selhani += 1;
      result.skipped += 1;
      continue;
    }

    readings.push(reading);
    result.read += 1;
  }

  if (readings.length === 0 && selhani > 0) {
    result.problems.push(`kontrola snímků: nepřečetl se ani jeden z ${selhani}`);
    return result;
  }

  const verdict = combineThreatReadings(readings, {
    skipped: result.skipped + Math.max(0, celkem - MAX_THREAT_PHOTOS),
  });

  const { error: writeError } = await db
    .from("flights")
    .update({
      threat_confirmed: verdict.confirmed,
      threat_note: verdict.note,
      threat_checked_at: new Date().toISOString(),
    })
    .eq("id", flight.id);

  if (writeError) {
    // Sloupce přidává migrace 20260903120000 a ta se nasazuje ručně.
    // Dokud neproběhla, kontrola se tiše nezapíše — shodit kvůli tomu
    // celou synchronizaci letů by bylo horší.
    if (chybiSloupce(writeError)) {
      console.warn("Sloupce kontroly snímků chybí — výsledek se nezapisuje", {
        flight_id: flight.id,
      });
      return result;
    }
    throw new Error(`zápis kontroly snímků: ${writeError.message}`);
  }

  result.checked = true;
  result.confirmed = verdict.confirmed;
  return result;
}

/**
 * Chybí sloupec, který přidává nenasazená migrace?
 *
 * 42703 je „undefined column“ z Postgresu, PGRST204 totéž z mezipaměti
 * schématu PostgRESTu.
 */
export function chybiSloupce(error: { code?: string | null }): boolean {
  return error.code === "42703" || error.code === "PGRST204";
}

/** Snímek z úložiště v podobě, kterou bere API modelu. */
async function stahnoutSnimek(
  db: Db,
  photo: PhotoRow,
): Promise<{ base64: string; mediaType: string } | null> {
  const suffix = photo.storage_path.split(".").pop() ?? null;
  const mediaType = mediaContentType(suffix);
  if (!mediaType || !mediaType.startsWith("image/")) return null;

  const { data, error } = await db.storage.from(FLIGHT_BUCKET).download(photo.storage_path);
  if (error || !data) {
    console.warn("Snímek z letu se nepodařilo stáhnout", {
      media_id: photo.id,
      message: error?.message,
    });
    return null;
  }

  const bytes = Buffer.from(await data.arrayBuffer());
  if (bytes.byteLength > MAX_THREAT_IMAGE_BYTES) {
    // Zmenšit ho tady nemáme čím a nacpat do API větší nejde.
    console.info("Snímek je nad limitem API, přeskakuji", {
      media_id: photo.id,
      bytes: bytes.byteLength,
    });
    return null;
  }

  return { base64: bytes.toString("base64"), mediaType };
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
    storage_path: path,
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
