import { flightHubConfig, type FlightHubConfig } from "../env.ts";

// Čtení letových úloh z FlightHubu.
//
// ═══ Cesty a tvary jsou ověřené v dokumentaci ══════════════════════
// (Apifox „NEW FlightHub 2 OpenAPI V1.0“, sdílená dokumentace DJI).
// Dvě věci se liší od toho, co se dá čekat podle názvu:
//
//   * trajektorie je na  /flight-task/{uuid}/track,  ne /trajectory
//   * seznam úloh je na  /flight-task/list  a chce POVINNĚ sn,
//     begin_at a end_at; stránkování nemá. Samotné /flight-task je
//     POST na založení úlohy, ne výpis.
//
// Skutečný čas letu detail NEVRACÍ — begin_at/end_at jsou plánované
// časy. Odletěné časy se berou z krajních bodů trajektorie.
// ══════════════════════════════════════════════════════════════════

/** Delší než u stavu doku: seznam médií může být tisíce položek. */
const TIMEOUT_MS = 20_000;

export type FhResult<T> =
  | { ok: true; data: T }
  | { ok: false; message: string; status: number | null };

/** Stav úlohy tak, jak ho vrací DJI. */
export const FH_TASK_STATUSES = [
  "waiting",
  "starting_failure",
  "executing",
  "paused",
  "terminated",
  "success",
  "suspended",
  "timeout",
] as const;
export type FhTaskStatus = (typeof FH_TASK_STATUSES)[number];

/** Skončila už úloha nadobro? Jen u takové má smysl tahat média. */
export function isTerminalStatus(status: string | null): boolean {
  return (
    status === "success" ||
    status === "terminated" ||
    status === "timeout" ||
    status === "starting_failure"
  );
}

export interface FhTaskDetail {
  uuid: string | null;
  name: string | null;
  status: string | null;
  sn: string | null;
  waylineUuid: string | null;
  /** Plánované časy, ne odletěné. */
  beginAt: string | null;
  endAt: string | null;
  expectedFileCount: number | null;
  uploadedFileCount: number | null;
}

export interface FhTrackPoint {
  timestamp: number;
  latitude: number;
  longitude: number;
  height: number | null;
}

export interface FhTrack {
  trackId: string | null;
  droneSn: string | null;
  flightDistance: number | null;
  flightDuration: number | null;
  points: FhTrackPoint[];
}

export interface FhMediaFile {
  uuid: string;
  name: string | null;
  suffix: string | null;
  size: number | null;
  originalUrl: string | null;
  previewUrl: string | null;
  createAt: string | null;
}

function num(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Jedno GET volání na OpenAPI.
 *
 * Nenulové `code` v těle je chyba, i když HTTP vrátilo 200 — tak to
 * FlightHub dělá a spolehnout se jen na stavový kód by znamenalo brát
 * chybové odpovědi jako data.
 */
async function fhGet(path: string): Promise<FhResult<unknown>> {
  let config: FlightHubConfig;
  try {
    config = flightHubConfig();
  } catch (error) {
    return {
      ok: false,
      status: null,
      message: error instanceof Error ? error.message : String(error),
    };
  }

  try {
    const response = await fetch(`${config.host}${path}`, {
      headers: {
        "X-User-Token": config.userToken,
        "x-project-uuid": config.projectUuid,
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: "no-store",
    });

    if (!response.ok) {
      return { ok: false, status: response.status, message: `HTTP ${response.status}` };
    }

    const body: unknown = await response.json();
    const code = num((body as { code?: unknown })?.code);
    if (code !== null && code !== 0) {
      const message = str((body as { message?: unknown })?.message) ?? `code ${code}`;
      return { ok: false, status: response.status, message };
    }

    return { ok: true, data: (body as { data?: unknown })?.data ?? null };
  } catch (error) {
    return {
      ok: false,
      status: null,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

/** GET /openapi/v0.1/flight-task/{task_uuid} */
export async function getFlightTask(
  taskUuid: string,
): Promise<FhResult<FhTaskDetail>> {
  const result = await fhGet(
    `/openapi/v0.1/flight-task/${encodeURIComponent(taskUuid)}`,
  );
  if (!result.ok) return result;

  const d = (result.data ?? {}) as Record<string, unknown>;
  const folder = (d.folder_info ?? {}) as Record<string, unknown>;

  return {
    ok: true,
    data: {
      uuid: str(d.uuid),
      name: str(d.name),
      status: str(d.status),
      sn: str(d.sn),
      waylineUuid: str(d.wayline_uuid),
      beginAt: str(d.begin_at),
      endAt: str(d.end_at),
      expectedFileCount: num(folder.expected_file_count),
      uploadedFileCount: num(folder.uploaded_file_count),
    },
  };
}

/** GET /openapi/v0.1/flight-task/{task_uuid}/track */
export async function getFlightTrack(
  taskUuid: string,
): Promise<FhResult<FhTrack>> {
  const result = await fhGet(
    `/openapi/v0.1/flight-task/${encodeURIComponent(taskUuid)}/track`,
  );
  if (!result.ok) return result;

  const d = (result.data ?? {}) as Record<string, unknown>;
  const track = (d.track ?? {}) as Record<string, unknown>;
  const rawPoints = Array.isArray(track.points) ? track.points : [];

  const points: FhTrackPoint[] = [];
  for (const raw of rawPoints) {
    const p = (raw ?? {}) as Record<string, unknown>;
    const timestamp = num(p.timestamp);
    const latitude = num(p.latitude);
    const longitude = num(p.longitude);
    // Bod bez času nebo souřadnic je k ničemu — do trajektorie nepatří
    // a mlčky by posunul odvozený začátek letu.
    if (timestamp === null || latitude === null || longitude === null) continue;
    points.push({ timestamp, latitude, longitude, height: num(p.height) });
  }

  return {
    ok: true,
    data: {
      trackId: str(track.track_id),
      droneSn: str(track.drone_sn),
      flightDistance: num(track.flight_distance),
      flightDuration: num(track.flight_duration),
      points,
    },
  };
}

/**
 * GET /openapi/v0.1/flight-task/{task_uuid}/media
 *
 * Dokumentace uvádí strop 10 000 položek a žádné stránkování — víc
 * souborů z jednoho letu se prostě nedozvíme.
 */
export async function listFlightMedia(
  taskUuid: string,
): Promise<FhResult<FhMediaFile[]>> {
  const result = await fhGet(
    `/openapi/v0.1/flight-task/${encodeURIComponent(taskUuid)}/media`,
  );
  if (!result.ok) return result;

  const d = (result.data ?? {}) as Record<string, unknown>;
  const list = Array.isArray(d.list) ? d.list : [];

  const files: FhMediaFile[] = [];
  for (const raw of list) {
    const m = (raw ?? {}) as Record<string, unknown>;
    const uuid = str(m.uuid);
    // Bez uuid nejde zaručit idempotence, takže takový soubor
    // přeskakujeme celý — radši chybějící médium než stažené dvakrát.
    if (!uuid) continue;
    files.push({
      uuid,
      name: str(m.name),
      suffix: str(m.suffix) ?? str(m.file_type),
      size: num(m.size),
      originalUrl: str(m.original_url),
      previewUrl: str(m.preview_url),
      createAt: str(m.create_at),
    });
  }

  return { ok: true, data: files };
}

/**
 * GET /openapi/v0.1/flight-task/list
 *
 * Synchronizace ji zatím nepoužívá — lety zakládá cron hlídek a zná
 * jejich task_uuid. Je tu proto, že jako JEDINÁ vrací skutečné časy
 * (`run_at`, `completed_at`), které detail nemá; až bude potřeba
 * dohledat lety založené mimo portál, půjde se přes ni.
 *
 * `sn`, `begin_at` a `end_at` jsou povinné a časy jsou v sekundách.
 */
export async function listFlightTasks(options: {
  dockSn: string;
  from: Date;
  to: Date;
}): Promise<FhResult<Record<string, unknown>[]>> {
  const params = new URLSearchParams({
    sn: options.dockSn,
    begin_at: String(Math.floor(options.from.getTime() / 1000)),
    end_at: String(Math.floor(options.to.getTime() / 1000)),
  });

  const result = await fhGet(`/openapi/v0.1/flight-task/list?${params}`);
  if (!result.ok) return result;

  const d = (result.data ?? {}) as Record<string, unknown>;
  const list = Array.isArray(d.list) ? d.list : [];
  return { ok: true, data: list as Record<string, unknown>[] };
}
