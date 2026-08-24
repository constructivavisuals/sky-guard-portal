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
import { triggerWorkflow } from "./flighthub.ts";

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

export type DispatchRunResult =
  | { status: "skipped"; reason: string }
  | { status: "recorded"; outcome: DispatchOutcome; dispatchId: string | null };

/** Byla v posledních 60 s osoba v jiné zóně téhož areálu? */
async function hasRecentPersonInOtherZone(
  context: DispatchContext,
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
  context: DispatchContext,
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

async function isSiteArmedInDb(context: DispatchContext): Promise<boolean> {
  const { data, error } = await supabaseAdmin().rpc("site_is_armed", {
    p_site_id: context.siteId,
    p_at: context.detectedAt.toISOString(),
  });

  // Když se stav nedá zjistit, výjezd neposíláme — planý let stojí víc
  // než zmeškaný, a v dispatches zůstane stopa proč.
  if (error) return false;
  return data === true;
}

export async function runDispatch(
  context: DispatchContext,
): Promise<DispatchRunResult> {
  // Bez zóny není kam letět a schéma dispatches ani zónu nepovoluje NULL.
  if (!context.zoneId) {
    return { status: "skipped", reason: "camera_without_zone" };
  }

  const coordinates = parsePointEwkbHex(context.zoneLocation);

  const [armed, lastSentAt, recentPerson] = await Promise.all([
    // Vypnutá zóna se chová jako mimo ostrý režim.
    context.zoneEnabled ? isSiteArmedInDb(context) : Promise.resolve(false),
    lastSentDispatchAt(context),
    hasRecentPersonInOtherZone(context),
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
    return insertDispatch({
      ...base,
      outcome: decision.outcome,
      fh_incident_uuid: null,
      http_status: null,
      response: {},
    });
  }

  if (!coordinates) {
    // Zóna bez waypointu — FlightHub by dostal prázdné souřadnice.
    return insertDispatch({
      ...base,
      outcome: "failed",
      fh_incident_uuid: null,
      http_status: null,
      response: { error: "zone_without_location", zone_id: context.zoneId },
    });
  }

  const zoneLabel = context.zoneName ?? "neznámá zóna";
  const result = await triggerWorkflow({
    workflowUuid: context.siteWorkflowUuid ?? "",
    name: `Perimetr — ${zoneLabel}`,
    latitude: coordinates.latitude,
    longitude: coordinates.longitude,
    level,
    desc: `${DETECTION_OBJECT_CLASS_LABELS[context.objectClass]} v zóně ${zoneLabel}`,
  });

  return insertDispatch({
    ...base,
    outcome: result.ok ? "sent" : "failed",
    fh_incident_uuid: result.incidentUuid,
    http_status: result.httpStatus,
    response: result.response,
  });
}

async function insertDispatch(
  row: DispatchInsert & { site_id: string; zone_id: string },
): Promise<DispatchRunResult> {
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
    return { status: "recorded", outcome: row.outcome, dispatchId: null };
  }

  return {
    status: "recorded",
    outcome: row.outcome,
    dispatchId: (data as { id: string }).id,
  };
}
