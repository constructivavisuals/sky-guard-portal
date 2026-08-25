import { after, type NextRequest } from "next/server";

import { runDispatch, type DispatchContext } from "@/lib/dispatch/run.ts";
import { ingestSecret } from "@/lib/env.ts";
import { parseDetectionPayload } from "@/lib/ingest/payload.ts";
import { verifySignature } from "@/lib/ingest/signature.ts";
import { supabaseAdmin } from "@/lib/supabase-admin.ts";

// POST /api/ingest/detection
//
// Příjem detekcí z kamer. Endpoint musí odpovědět do 1 s, proto dělá
// synchronně jen dvě věci: ověří podpis a zapíše detekci. Rozhodnutí
// o zásahu i volání FlightHubu (timeout 5 s) běží až po odeslání
// odpovědi přes `after()` — detekce se tak zapíše i tehdy, když je
// FlightHub nedostupný.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface CameraLookupRow {
  id: string;
  site_id: string;
  zone_id: string | null;
  sites: {
    id: string;
    cooldown_seconds: number;
    fh_workflow_uuid: string | null;
  } | null;
  zones: {
    id: string;
    name: string;
    enabled: boolean;
    location: string | null;
  } | null;
}

function jsonError(status: number, error: string, detail?: unknown) {
  return Response.json(
    detail === undefined ? { error } : { error, detail },
    { status },
  );
}

export async function POST(request: NextRequest): Promise<Response> {
  // Raw tělo je potřeba přesně tak, jak dorazilo — přeparsovaný JSON
  // by dal jiné bajty a podpis by nesedl.
  const rawBody = await request.text();

  let secret: string;
  try {
    secret = ingestSecret();
  } catch {
    // Chybějící konfigurace nesmí vypadat jako neplatný podpis.
    console.error("INGEST_SECRET není nastavený");
    return jsonError(500, "server_misconfigured");
  }

  const signature = verifySignature({
    rawBody,
    signature: request.headers.get("x-signature"),
    timestamp: request.headers.get("x-timestamp"),
    secret,
  });

  if (!signature.valid) {
    // Důvod se vrací jen jako hrubá kategorie; podrobnosti by útočníkovi
    // pomohly ladit podvržený podpis.
    return jsonError(401, "unauthorized", signature.reason);
  }

  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return jsonError(400, "invalid_json");
  }

  const parsed = parseDetectionPayload(body);
  if (!parsed.ok) {
    return jsonError(400, "invalid_payload", parsed.errors);
  }

  const { payload } = parsed;
  const db = supabaseAdmin();

  const { data: camera, error: cameraError } = await db
    .from("cameras")
    .select(
      "id, site_id, zone_id, sites(id, cooldown_seconds, fh_workflow_uuid), zones(id, name, enabled, location)",
    )
    .eq("serial_number", payload.cameraSerial)
    .maybeSingle<CameraLookupRow>();

  if (cameraError) {
    console.error("Vyhledání kamery selhalo", { message: cameraError.message });
    return jsonError(500, "lookup_failed");
  }

  if (!camera || !camera.sites) {
    return jsonError(404, "unknown_camera");
  }

  // Detekce se zapisuje vždy, ještě před jakýmkoli rozhodováním
  // o zásahu — je to důkaz, ne vedlejší produkt zásahu.
  const { data: detection, error: detectionError } = await db
    .from("detections")
    .insert({
      // Ingest z kamer; dronové detekce půjdou jinou cestou, až se
      // budou tahat data z FlightHubu.
      source: "camera",
      // Lokalita se ukládá přímo, ne aby se pak odvozovala přes kameru —
      // migrace 20260825180000.
      site_id: camera.site_id,
      camera_id: camera.id,
      zone_id: camera.zone_id,
      detected_at: payload.detectedAt.toISOString(),
      object_class: payload.objectClass,
      confidence: payload.confidence,
      raw: payload.raw,
    })
    .select("id")
    .single();

  if (detectionError || !detection) {
    console.error("Zápis detekce selhal", {
      camera_id: camera.id,
      message: detectionError?.message,
    });
    return jsonError(500, "detection_insert_failed");
  }

  const context: DispatchContext = {
    detectionId: detection.id,
    siteId: camera.site_id,
    zoneId: camera.zone_id,
    zoneName: camera.zones?.name ?? null,
    zoneEnabled: camera.zones?.enabled ?? false,
    zoneLocation: camera.zones?.location ?? null,
    siteCooldownSeconds: camera.sites.cooldown_seconds,
    siteWorkflowUuid: camera.sites.fh_workflow_uuid,
    objectClass: payload.objectClass,
    detectedAt: payload.detectedAt,
  };

  after(async () => {
    try {
      await runDispatch(context);
    } catch (error) {
      // Výjimka po odeslání odpovědi nesmí shodit runtime.
      console.error("Zpracování zásahu selhalo", {
        detection_id: context.detectionId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  return Response.json(
    { detection_id: detection.id, dispatch: "pending" },
    { status: 200 },
  );
}
