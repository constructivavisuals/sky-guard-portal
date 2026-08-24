import { parsePointEwkbHex } from "../geo.ts";
import { supabaseAdmin } from "../supabase-admin.ts";
import {
  DETECTION_OBJECT_CLASS_LABELS,
  type DetectionObjectClass,
  type DispatchInsert,
  type DispatchOutcome,
} from "../../types/database.ts";

import {
  PERSON_ESCALATION_WINDOW_SECONDS,
  decideDispatch,
  resolveDispatchLevel,
} from "./decision.ts";
import {
  triggerWorkflow,
  type TriggerWorkflowInput,
  type TriggerWorkflowResult,
} from "./flighthub.ts";

// Orchestrace výjezdu: obstará vstupy pro rozhodovací funkce, zavolá
// FlightHub a uloží řádek do dispatches. Běží až PO odeslání odpovědi
// (next/server `after`), takže se sem nesmí dostat nic, co by muselo
// stihnout 1s limit endpointu.

export interface DispatchContext {
  detectionId: string;
  siteId: string;
  zoneId: string | null;
  zoneName: string | null;
  zoneEnabled: boolean;
  zoneLocation: string | null;
  siteCooldownSeconds: number;
  siteWorkflowUuid: string | null;
  objectClass: DetectionObjectClass;
  detectedAt: Date;
}

/** Kontext poté, co je jisté, že kamera má zónu. */
export type ResolvedDispatchContext = DispatchContext & { zoneId: string };

export type DispatchRow = DispatchInsert & {
  site_id: string;
  zone_id: string;
  outcome: DispatchOutcome;
};

export type DispatchRunResult =
  | { status: "skipped"; reason: string }
  | { status: "recorded"; outcome: DispatchOutcome; dispatchId: string | null }
  // Zápis samotný selhal — v dispatches nezůstalo nic. Nastane jen když
  // je nedostupná i databáze, tedy když stopu není kam uložit.
  | { status: "unrecorded"; reason: string };

/**
 * Vstupy, které runDispatch potřebuje zvenčí. Výchozí implementace níž
 * sahá do databáze a na FlightHub; testy si podstrčí vlastní, takže jde
 * ověřit i chování při výjimce, aniž by běžela DB.
 */
export interface DispatchDeps {
  isSiteArmed(context: ResolvedDispatchContext): Promise<boolean>;
  lastSentDispatchAt(context: ResolvedDispatchContext): Promise<Date | null>;
  hasRecentPersonInOtherZone(
    context: ResolvedDispatchContext,
  ): Promise<boolean>;
  triggerWorkflow(input: TriggerWorkflowInput): Promise<TriggerWorkflowResult>;
  insertDispatch(row: DispatchRow): Promise<string | null>;
}

/** Byla v posledních 60 s osoba v jiné zóně téhož areálu? */
async function hasRecentPersonInOtherZone(
  context: ResolvedDispatchContext,
): Promise<boolean> {
  const since = new Date(
    context.detectedAt.getTime() - PERSON_ESCALATION_WINDOW_SECONDS * 1_000,
  ).toISOString();

  // Detekce nedrží site_id, tak se filtruje přes kamery daného areálu.
  const { data: cameras, error: camerasError } = await supabaseAdmin()
    .from("cameras")
    .select("id")
    .eq("site_id", context.siteId);

  if (camerasError || !cameras || cameras.length === 0) return false;

  let query = supabaseAdmin()
    .from("detections")
    .select("id")
    .in(
      "camera_id",
      cameras.map((camera) => camera.id),
    )
    .eq("object_class", "person")
    .gte("detected_at", since)
    .lte("detected_at", context.detectedAt.toISOString())
    // Vlastní detekce se nepočítá — eskaluje jen pohyb JINDE.
    .neq("id", context.detectionId)
    .limit(1);

  query = context.zoneId
    ? query.neq("zone_id", context.zoneId)
    : // Detekce bez zóny nemá co vylučovat; bere se každá jiná zóna.
      query.not("zone_id", "is", null);

  const { data, error } = await query;
  if (error) return false;
  return (data?.length ?? 0) > 0;
}

/** Čas posledního skutečně odeslaného výjezdu na lokalitě. */
async function lastSentDispatchAt(
  context: ResolvedDispatchContext,
): Promise<Date | null> {
  const { data, error } = await supabaseAdmin()
    .from("dispatches")
    .select("sent_at")
    .eq("site_id", context.siteId)
    .eq("outcome", "sent")
    .lte("sent_at", context.detectedAt.toISOString())
    .order("sent_at", { ascending: false })
    .limit(1);

  if (error || !data || data.length === 0) return null;
  return new Date(data[0].sent_at);
}

async function isSiteArmedInDb(context: ResolvedDispatchContext): Promise<boolean> {
  const { data, error } = await supabaseAdmin().rpc("site_is_armed", {
    p_site_id: context.siteId,
    p_at: context.detectedAt.toISOString(),
  });

  // Když se stav nedá zjistit, výjezd neposíláme — planý let stojí víc
  // než zmeškaný, a v dispatches zůstane stopa proč.
  if (error) return false;
  return data === true;
}

/** Text výjimky pro uložení — bez hodnot proměnných, viz flighthub.ts. */
function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 500);
}

/**
 * Sestaví řádek do dispatches: obstará vstupy, rozhodne a případně
 * zavolá FlightHub. Nic nezapisuje — zápis dělá runDispatch, aby i
 * výjimka odsud skončila zapsaným pokusem.
 */
async function prepareDispatchRow(
  context: ResolvedDispatchContext,
  deps: DispatchDeps,
): Promise<DispatchRow> {
  const coordinates = parsePointEwkbHex(context.zoneLocation);

  const [armed, lastSentAt, recentPerson] = await Promise.all([
    // Vypnutá zóna se chová jako mimo ostrý režim.
    context.zoneEnabled ? deps.isSiteArmed(context) : Promise.resolve(false),
    deps.lastSentDispatchAt(context),
    deps.hasRecentPersonInOtherZone(context),
  ]);

  const level = resolveDispatchLevel(context.objectClass, recentPerson);
  const decision = decideDispatch({
    armed,
    cooldownSeconds: context.siteCooldownSeconds,
    lastSentAt,
    at: context.detectedAt,
  });

  const base = {
    site_id: context.siteId,
    zone_id: context.zoneId,
    triggered_by_detection: context.detectionId,
    level_sent: level,
  };

  if (!decision.send) {
    return {
      ...base,
      outcome: decision.outcome,
      fh_incident_uuid: null,
      http_status: null,
      response: {},
    };
  }

  if (!coordinates) {
    // Zóna bez waypointu — FlightHub by dostal prázdné souřadnice.
    return {
      ...base,
      outcome: "failed",
      fh_incident_uuid: null,
      http_status: null,
      response: { error: "zone_without_location", zone_id: context.zoneId },
    };
  }

  const zoneLabel = context.zoneName ?? "neznámá zóna";
  const result = await deps.triggerWorkflow({
    workflowUuid: context.siteWorkflowUuid ?? "",
    name: `Perimetr — ${zoneLabel}`,
    latitude: coordinates.latitude,
    longitude: coordinates.longitude,
    level,
    desc: `${DETECTION_OBJECT_CLASS_LABELS[context.objectClass]} v zóně ${zoneLabel}`,
  });

  return {
    ...base,
    outcome: result.ok ? "sent" : "failed",
    fh_incident_uuid: result.incidentUuid,
    http_status: result.httpStatus,
    response: result.response,
  };
}

export async function runDispatch(
  context: DispatchContext,
  deps: DispatchDeps = databaseDeps,
): Promise<DispatchRunResult> {
  // Bez zóny není kam letět a schéma dispatches ani zónu nepovoluje NULL.
  if (!context.zoneId) {
    return { status: "skipped", reason: "camera_without_zone" };
  }

  const resolved: ResolvedDispatchContext = { ...context, zoneId: context.zoneId };

  let row: DispatchRow;
  try {
    row = await prepareDispatchRow(resolved, deps);
  } catch (error) {
    // Cokoli neočekávaného — chybějící proměnná prostředí, rozbité
    // spojení, chyba v dotazu — skončí zapsaným pokusem. Pokus o výjezd
    // nesmí zmizet jen do logu.
    console.error("Příprava výjezdu selhala", {
      detection_id: context.detectionId,
      message: safeErrorMessage(error),
    });
    row = {
      site_id: resolved.siteId,
      zone_id: resolved.zoneId,
      triggered_by_detection: resolved.detectionId,
      // Bez dat o okolních zónách se eskalace nedá posoudit, bere se
      // základní stupeň podle toho, co kamera viděla.
      level_sent: resolveDispatchLevel(resolved.objectClass, false),
      outcome: "failed",
      fh_incident_uuid: null,
      http_status: null,
      response: { error: "dispatch_error", message: safeErrorMessage(error) },
    };
  }

  try {
    const dispatchId = await deps.insertDispatch(row);
    return { status: "recorded", outcome: row.outcome, dispatchId };
  } catch (error) {
    // Poslední instance: nefunguje ani zápis, stopu není kam uložit.
    console.error("Zápis dispatche vyhodil výjimku", {
      detection_id: context.detectionId,
      message: safeErrorMessage(error),
    });
    return { status: "unrecorded", reason: safeErrorMessage(error) };
  }
}

async function insertDispatch(row: DispatchRow): Promise<string | null> {
  const { data, error } = await supabaseAdmin()
    .from("dispatches")
    .insert(row)
    .select("id")
    .single();

  if (error) {
    console.error("Zápis dispatche selhal", {
      site_id: row.site_id,
      outcome: row.outcome,
      message: error.message,
    });
    return null;
  }

  return (data as { id: string }).id;
}

/** Výchozí závislosti — databáze a skutečný FlightHub. */
export const databaseDeps: DispatchDeps = {
  isSiteArmed: isSiteArmedInDb,
  lastSentDispatchAt,
  hasRecentPersonInOtherZone,
  triggerWorkflow,
  insertDispatch,
};
