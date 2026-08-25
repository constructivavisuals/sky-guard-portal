import { flightHubConfig, type FlightHubConfig } from "../env.ts";
import type { DispatchLevel, Json } from "../../types/database.ts";

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
