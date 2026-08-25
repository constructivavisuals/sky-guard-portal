import { flightHubConfig, type FlightHubConfig } from "../env.ts";
import type {
  DispatchLevel,
  FlightConditions,
  Json,
} from "../../types/database.ts";

// Klient pro spuštění workflow v DJI FlightHub 2.
// Token ani projekt se nikam nelogují — do dispatches.response jde
// výhradně odpověď serveru, nikdy odeslané hlavičky.

export const FLIGHTHUB_TIMEOUT_MS = 5_000;

/** Strop pro chybovou hlášku ukládanou do dispatches.response. */
export const MAX_ERROR_MESSAGE_LENGTH = 500;

/**
 * Text výjimky pro uložení do databáze.
 *
 * Hlášky z env.ts nesou jen NÁZEV proměnné (`Chybí povinná proměnná
 * prostředí FH_USER_TOKEN`), nikdy hodnotu — token se tudy tedy nemá jak
 * dostat do dispatches.response. Kdyby někdo required() rozšířil o výpis
 * hodnoty, poteče tajemství do databáze; tahle vlastnost je pojištěná
 * testem ve flighthub.test.ts.
 */
function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, MAX_ERROR_MESSAGE_LENGTH);
}

export interface TriggerWorkflowInput {
  workflowUuid: string;
  name: string;
  latitude: number;
  longitude: number;
  level: DispatchLevel;
  desc: string;
}

export interface TriggerWorkflowResult {
  /** UUID incidentu z data.uuid; null, když ho FlightHub nevrátil. */
  incidentUuid: string | null;
  /** null u síťové chyby nebo timeoutu — spojení se nedostalo k odpovědi. */
  httpStatus: number | null;
  /** Co uložit do dispatches.response. */
  response: Json;
  ok: boolean;
}

/** Vytáhne data.uuid z odpovědi, ať už má jakýkoli tvar. */
function readIncidentUuid(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const data = (body as { data?: unknown }).data;
  if (typeof data !== "object" || data === null) return null;
  const uuid = (data as { uuid?: unknown }).uuid;
  return typeof uuid === "string" && uuid.length > 0 ? uuid : null;
}

export async function triggerWorkflow(
  input: TriggerWorkflowInput,
): Promise<TriggerWorkflowResult> {
  // Konfigurace se čte uvnitř funkce, ne na jejím okraji: chybějící
  // proměnná prostředí musí skončit jako výsledek k zapsání, ne jako
  // výjimka. Jinak by pokus o zásah zmizel do console.error a
  // v dispatches by po něm nezůstala žádná stopa.
  let config: FlightHubConfig;
  try {
    config = flightHubConfig();
  } catch (error) {
    return {
      incidentUuid: null,
      httpStatus: null,
      response: {
        // Odlišeno od 'network_error' a 'timeout' — konfigurační chybu
        // spraví nasazení, nedostupný FlightHub se opraví sám.
        error: "configuration_error",
        message: safeErrorMessage(error),
      },
      ok: false,
    };
  }

  const body = {
    workflow_uuid: input.workflowUuid,
    // 0 = spuštění z vnějšího systému (API), ne ruční start v konzoli.
    trigger_type: 0,
    name: input.name,
    params: {
      creator: config.creator,
      latitude: input.latitude,
      longitude: input.longitude,
      level: input.level,
      desc: input.desc,
    },
  };

  try {
    const response = await fetch(`${config.host}/openapi/v0.1/workflow`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-User-Token": config.userToken,
        "x-project-uuid": config.projectUuid,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(FLIGHTHUB_TIMEOUT_MS),
    });

    const text = await response.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      // Odpověď mimo JSON si uložíme jako text, ať je chyba dohledatelná.
      parsed = { non_json_body: text.slice(0, 2_000) };
    }

    const incidentUuid = readIncidentUuid(parsed);

    return {
      incidentUuid,
      httpStatus: response.status,
      response: (parsed ?? {}) as Json,
      // Zásah považujeme za odeslaný jen s potvrzeným incidentem —
      // HTTP 200 s chybovým kódem v těle je pořád selhání.
      ok: response.ok && incidentUuid !== null,
    };
  } catch (error) {
    const timedOut =
      error instanceof Error &&
      (error.name === "TimeoutError" || error.name === "AbortError");

    return {
      incidentUuid: null,
      httpStatus: null,
      response: {
        error: timedOut ? "timeout" : "network_error",
        message: safeErrorMessage(error),
        timeout_ms: FLIGHTHUB_TIMEOUT_MS,
      },
      ok: false,
    };
  }
}

// ── Trasy a plánované úlohy ──────────────────────────────────────

export interface Wayline {
  uuid: string;
  name: string;
}

/**
 * Seznam tras z FlightHubu pro výběr ve formuláři hlídky.
 *
 * Tvar odpovědi z API neznáme napevno, takže se čte obranně: hledá se
 * pole objektů s uuid a jménem pod několika obvyklými klíči. Když se
 * netrefíme, vrátí se prázdno a formulář to řekne — lepší než spadnout.
 */
export async function listWaylines(): Promise<
  { ok: true; waylines: Wayline[] } | { ok: false; message: string }
> {
  let config: FlightHubConfig;
  try {
    config = flightHubConfig();
  } catch (error) {
    return { ok: false, message: safeErrorMessage(error) };
  }

  try {
    const response = await fetch(`${config.host}/openapi/v0.1/wayline`, {
      headers: {
        "X-User-Token": config.userToken,
        "x-project-uuid": config.projectUuid,
      },
      signal: AbortSignal.timeout(FLIGHTHUB_TIMEOUT_MS),
      cache: "no-store",
    });

    if (!response.ok) {
      return { ok: false, message: `FlightHub odpověděl ${response.status}.` };
    }

    const body: unknown = await response.json();
    return { ok: true, waylines: extractWaylines(body) };
  } catch (error) {
    return { ok: false, message: safeErrorMessage(error) };
  }
}

/**
 * Odpověď má tvar `{ data: { list: [{ id, name }] } }` — uuid trasy je
 * pod klíčem `id`, ne `wayline_uuid`. Ověřeno proti skutečnému API.
 */
function extractWaylines(body: unknown): Wayline[] {
  if (typeof body !== "object" || body === null) return [];
  const data = (body as { data?: unknown }).data;
  if (typeof data !== "object" || data === null) return [];
  const list = (data as { list?: unknown }).list;
  if (!Array.isArray(list)) return [];

  const out: Wayline[] = [];
  for (const item of list) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as Record<string, unknown>;
    const uuid = record.id;
    const name = record.name;
    if (typeof uuid === "string" && uuid !== "") {
      out.push({ uuid, name: typeof name === "string" && name ? name : uuid });
    }
  }
  return out;
}

export interface FlightTaskInput {
  name: string;
  /** Sériové číslo DOCKU, ne dronu. */
  dockSn: string;
  waylineUuid: string;
  timeZone: string;
  /** Kdy má let začít. */
  beginAt: Date;
  /** Dokdy se smí start odložit. */
  latestBeginAt: Date;
}

export interface FlightTaskResult {
  taskUuid: string | null;
  httpStatus: number | null;
  response: Json;
  ok: boolean;
}

/** Vytáhne UUID úlohy z odpovědi, ať má jakýkoli tvar. */
function readTaskUuid(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const record = body as Record<string, unknown>;
  const direct = record.task_uuid;
  if (typeof direct === "string" && direct) return direct;

  const data = record.data;
  if (typeof data === "object" && data !== null) {
    const nested = data as Record<string, unknown>;
    for (const key of ["task_uuid", "uuid", "id"]) {
      const value = nested[key];
      if (typeof value === "string" && value) return value;
    }
  }
  return null;
}

/** Naplánuje let po trase. Protějšek triggerWorkflow pro hlídky. */
export async function createFlightTask(
  input: FlightTaskInput,
): Promise<FlightTaskResult> {
  let config: FlightHubConfig;
  try {
    config = flightHubConfig();
  } catch (error) {
    return {
      taskUuid: null,
      httpStatus: null,
      response: { error: "configuration_error", message: safeErrorMessage(error) },
      ok: false,
    };
  }

  const body = {
    name: input.name,
    // sn je dock, ne dron — dron se odvozuje od doku na straně DJI.
    sn: input.dockSn,
    wayline_uuid: input.waylineUuid,
    time_zone: input.timeZone,
    rth_altitude: 100,
    rth_mode: "optimal",
    wayline_precision_type: "gps",
    out_of_control_action_in_flight: "return_home",
    resumable_status: "auto",
    task_type: "timed",
    begin_at: Math.floor(input.beginAt.getTime() / 1000),
    latest_begin_at: Math.floor(input.latestBeginAt.getTime() / 1000),
  };

  try {
    const response = await fetch(`${config.host}/openapi/v0.1/flight-task`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-User-Token": config.userToken,
        "x-project-uuid": config.projectUuid,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(FLIGHTHUB_TIMEOUT_MS),
    });

    const text = await response.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = { non_json_body: text.slice(0, 2_000) };
    }

    const taskUuid = readTaskUuid(parsed);
    return {
      taskUuid,
      httpStatus: response.status,
      response: (parsed ?? {}) as Json,
      // Za naplánovaný se let počítá jen s potvrzeným UUID — HTTP 200
      // s chybovým kódem v těle je pořád selhání.
      ok: response.ok && taskUuid !== null,
    };
  } catch (error) {
    const timedOut =
      error instanceof Error &&
      (error.name === "TimeoutError" || error.name === "AbortError");
    return {
      taskUuid: null,
      httpStatus: null,
      response: {
        error: timedOut ? "timeout" : "network_error",
        message: safeErrorMessage(error),
        timeout_ms: FLIGHTHUB_TIMEOUT_MS,
      },
      ok: false,
    };
  }
}

// ── Stav doku ────────────────────────────────────────────────────
//
// Všechno je v jediné odpovědi /openapi/v0.1/device/{sn}/state.
// Projektový seznam zařízení se kvůli tomu už nevolá.

export interface DockState {
  /** Sedí dron v doku? Jinak nemá odkud odstartovat. */
  droneInDock: boolean;
  /**
   * Stav dronu podle doku. „power_off“ je běžný stav mezi lety — dron
   * spí a probudí ho naplánovaná úloha, takže to NENÍ důvod hlídku
   * vynechat.
   */
  droneStatus: string | null;
  batteryPercent: number | null;
  chargeState: string | null;
  /** Zaplnění úložiště doku v procentech. */
  storageUsedPercent: number | null;
  /** Kolik souborů čeká na odeslání z doku. */
  remainUpload: number | null;
  /** Odečet počasí z doku; ukládá se k letu. */
  conditions: FlightConditions | null;
}

export type DockStateResult =
  | { ok: true; state: DockState }
  | { ok: false; message: string };

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Stav doku a dronu v něm.
 *
 * Tvary jsou ověřené na skutečné odpovědi:
 *   device_state.drone_in_dock                     "inside"
 *   device_state.sub_device.device_online_status   "power_off" mezi lety
 *   device_state.drone_charge_state.capacity_percent
 *   device_state.storage.total / .used
 *   device_state.media_file_detail.remain_upload
 *   device_state.wind_speed / .rainfall / .environment_temperature
 */
export async function getDockState(dockSn: string): Promise<DockStateResult> {
  let config: FlightHubConfig;
  try {
    config = flightHubConfig();
  } catch (error) {
    return { ok: false, message: safeErrorMessage(error) };
  }

  let body: unknown;
  try {
    const response = await fetch(
      `${config.host}/openapi/v0.1/device/${encodeURIComponent(dockSn)}/state`,
      {
        headers: {
          "X-User-Token": config.userToken,
          "x-project-uuid": config.projectUuid,
        },
        signal: AbortSignal.timeout(FLIGHTHUB_TIMEOUT_MS),
        cache: "no-store",
      },
    );
    if (!response.ok) {
      return { ok: false, message: `FlightHub odpověděl ${response.status}.` };
    }
    body = await response.json();
  } catch (error) {
    return { ok: false, message: safeErrorMessage(error) };
  }

  const data = record(record(body)?.data);
  const deviceState = record(data?.device_state);
  if (!deviceState) {
    return { ok: false, message: `Dok ${dockSn} nevrátil device_state.` };
  }

  const charge = record(deviceState.drone_charge_state);
  const storage = record(deviceState.storage);
  const media = record(deviceState.media_file_detail);
  const subDevice = record(deviceState.sub_device);

  const total = numberOrNull(storage?.total);
  const used = numberOrNull(storage?.used);
  // Nulová kapacita by dala dělení nulou; radši žádný údaj než Infinity.
  const storageUsedPercent =
    total !== null && used !== null && total > 0 ? (used / total) * 100 : null;

  const wind = numberOrNull(deviceState.wind_speed);
  // rainfall je kód, ne číslo: dok vrací "no_rain" a podobné.
  const rain =
    typeof deviceState.rainfall === "string" && deviceState.rainfall
      ? deviceState.rainfall
      : null;
  const temperature = numberOrNull(deviceState.environment_temperature);
  const conditions =
    wind === null && rain === null && temperature === null
      ? null
      : {
          wind_speed: wind,
          rainfall: rain,
          environment_temperature: temperature,
          // Odečet je z okamžiku plánování, ne ze startu letu.
          measured_at: new Date().toISOString(),
        };

  return {
    ok: true,
    state: {
      droneInDock: deviceState.drone_in_dock === "inside",
      droneStatus:
        typeof subDevice?.device_online_status === "string"
          ? subDevice.device_online_status
          : null,
      batteryPercent: numberOrNull(charge?.capacity_percent),
      chargeState: typeof charge?.state === "string" ? charge.state : null,
      storageUsedPercent,
      remainUpload: numberOrNull(media?.remain_upload),
      conditions,
    },
  };
}
