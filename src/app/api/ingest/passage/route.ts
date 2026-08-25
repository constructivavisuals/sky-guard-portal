import { randomUUID } from "node:crypto";
import { after, type NextRequest } from "next/server";

import { runDispatch, type DispatchContext } from "@/lib/dispatch/run.ts";
import { ingestSecret } from "@/lib/env.ts";
import {
  cameraKeyFingerprint,
  deriveCameraKey,
} from "@/lib/ingest/camera-key.ts";
import {
  MAX_IMAGE_BYTES,
  parsePassagePayload,
} from "@/lib/ingest/passage-payload.ts";
import { clientIp, takeIngestToken } from "@/lib/ingest/rate-limit.ts";
import { verifySignature, type SignatureResult } from "@/lib/ingest/signature.ts";
import { resolvePlate } from "@/lib/plates/escalate.ts";
import { readPlateFromImage } from "@/lib/plates/reader.ts";
import { PASSAGE_BUCKET, passageImagePath } from "@/lib/plates/storage.ts";
import { supabaseAdmin } from "@/lib/supabase-admin.ts";

// POST /api/ingest/passage
//
// Průjezd vozidla bránou. Ověřuje se stejným HMAC podpisem jako
// detekce — jedna kamera, jeden klíč, žádná druhá cesta dovnitř.
//
// ═══ Pořadí kroků a proč právě takhle ══════════════════════════════
// Vjezd JE detekce vozidla, takže se zakládá řádek v detections
// a rozhodnutí o zásahu jede beze změny stávající cestou. To se stane
// HNED: v ostrém režimu vzlétne dron na stupni 2, aniž by kdokoli
// věděl, jaká je to značka.
//
// Čtení značky trvá vteřiny a běží až po odeslání odpovědi, přes
// after(). Kdyby na něj rozhodnutí čekalo, auto by mezitím stálo
// v areálu. Značka rozhodnutí neruší, jen ho upřesňuje — nežádoucí
// eskaluje na stupeň osoby, známá se jen zaznamená.
// ═══════════════════════════════════════════════════════════════════

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Čtení značky přes Claude běží až za odpovědí, ale pořád v téhle
// funkci — výchozí limit by ji uťal.
export const maxDuration = 60;

/**
 * Strop na celé tělo. Snímek smí mít MAX_IMAGE_BYTES; base64 ho
 * nafoukne o třetinu a zbytek JSONu je pár set bajtů.
 */
const MAX_BODY_BYTES = Math.ceil(MAX_IMAGE_BYTES * 1.4) + 8 * 1024;

interface CameraRow {
  id: string;
  site_id: string;
  zone_id: string | null;
  serial_number: string | null;
  ingest_secret_hash: string | null;
  ingest_key_version: number;
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

const CAMERA_COLUMNS =
  "id, site_id, zone_id, serial_number, ingest_secret_hash, ingest_key_version, " +
  "sites(id, cooldown_seconds, fh_workflow_uuid), zones(id, name, enabled, location)";

const CAMERA_COLUMNS_BEZ_KLICE =
  "id, site_id, zone_id, serial_number, " +
  "sites(id, cooldown_seconds, fh_workflow_uuid), zones(id, name, enabled, location)";

function jsonError(status: number, error: string, detail?: unknown) {
  return Response.json(
    detail === undefined ? { error } : { error, detail },
    { status },
  );
}

/** Táž záchytná větev jako u detekce — sloupce klíče nemusí být nasazené. */
async function najitKameru(
  db: ReturnType<typeof supabaseAdmin>,
  serial: string,
): Promise<{ camera: CameraRow | null; error: string | null }> {
  const sKlicem = await db
    .from("cameras")
    .select(CAMERA_COLUMNS)
    .eq("serial_number", serial)
    .maybeSingle<CameraRow>();

  if (!sKlicem.error) return { camera: sKlicem.data, error: null };

  const bez = await db
    .from("cameras")
    .select(CAMERA_COLUMNS_BEZ_KLICE)
    .eq("serial_number", serial)
    .maybeSingle<CameraRow>();

  if (bez.error) return { camera: null, error: bez.error.message };

  console.warn("Sloupce ingest klíče chybí — ověřuji společným tajemstvím");
  return {
    camera: bez.data
      ? { ...bez.data, ingest_secret_hash: null, ingest_key_version: 1 }
      : null,
    error: null,
  };
}

/** Shodné s /api/ingest/detection: klíč kamery, jinak společné tajemství. */
function verifyForCamera(options: {
  rawBody: string;
  signature: string | null;
  timestamp: string | null;
  now: Date;
  masterSecret: string;
  camera: CameraRow | null;
}): SignatureResult {
  const { rawBody, signature, timestamp, now, masterSecret, camera } = options;
  const base = { rawBody, signature, timestamp, now };

  const serial = camera?.serial_number;
  if (!camera || !camera.ingest_secret_hash || !serial) {
    if (camera) {
      console.warn("Kamera se podepisuje společným INGEST_SECRET", {
        camera_id: camera.id,
        site_id: camera.site_id,
      });
    }
    return verifySignature({ ...base, secret: masterSecret });
  }

  let derived: string;
  try {
    derived = deriveCameraKey(masterSecret, serial, camera.ingest_key_version);
  } catch {
    return { valid: false, reason: "signature_mismatch" };
  }

  if (cameraKeyFingerprint(derived) !== camera.ingest_secret_hash) {
    console.error("Otisk klíče kamery nesedí na odvozený klíč", {
      camera_id: camera.id,
    });
    return { valid: false, reason: "signature_mismatch" };
  }

  return verifySignature({ ...base, secret: derived });
}

export async function POST(request: NextRequest): Promise<Response> {
  const receivedAt = new Date();
  const ip = clientIp(request.headers);

  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    console.warn("Vjezd odmítnut: tělo je moc velké", {
      ip,
      content_length: declaredLength,
    });
    return jsonError(413, "payload_too_large");
  }

  const rawBody = await request.text();
  if (rawBody.length > MAX_BODY_BYTES) {
    console.warn("Vjezd odmítnut: tělo je moc velké", { ip, bytes: rawBody.length });
    return jsonError(413, "payload_too_large");
  }

  let secret: string;
  try {
    secret = ingestSecret();
  } catch {
    console.error("INGEST_SECRET není nastavený");
    return jsonError(500, "server_misconfigured");
  }

  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    console.warn("Vjezd odmítnut: tělo není JSON", { ip });
    return jsonError(400, "invalid_json");
  }

  const parsed = parsePassagePayload(body, receivedAt);
  if (!parsed.ok) {
    console.warn("Vjezd odmítnut: vadný obsah", { ip, duvody: parsed.errors });
    return jsonError(400, "invalid_payload", parsed.errors);
  }

  const { payload } = parsed;
  const db = supabaseAdmin();

  const limit = await takeIngestToken(db, {
    cameraSerial: payload.cameraSerial,
    ip,
  });
  if (!limit.allowed) {
    console.warn("Vjezd odmítnut: překročen limit", {
      ip,
      serial: payload.cameraSerial,
      vycerpano: limit.reason,
    });
    return jsonError(429, "rate_limited");
  }

  const lookup = await najitKameru(db, payload.cameraSerial);
  if (lookup.error) {
    console.error("Vyhledání kamery selhalo", { message: lookup.error });
    return jsonError(500, "lookup_failed");
  }
  const camera = lookup.camera;

  const check = verifyForCamera({
    rawBody,
    signature: request.headers.get("x-signature"),
    timestamp: request.headers.get("x-timestamp"),
    now: receivedAt,
    masterSecret: secret,
    camera,
  });

  if (!check.valid) {
    console.warn("Vjezd odmítnut: podpis neprošel", {
      ip,
      serial: payload.cameraSerial,
      duvod: check.reason,
      znama_kamera: Boolean(camera),
    });
    return jsonError(401, "unauthorized", check.reason);
  }

  if (!camera || !camera.sites) {
    console.warn("Vjezd odmítnut: neznámá kamera", { ip, serial: payload.cameraSerial });
    return jsonError(404, "unknown_camera");
  }

  // ── Detekce vozidla ────────────────────────────────────────────
  // Tímhle řádkem se rozjede zásah stávající cestou. Značka o něm
  // nerozhoduje a nečeká se na ni.
  const { data: detection, error: detectionError } = await db
    .from("detections")
    .insert({
      source: "camera",
      site_id: camera.site_id,
      camera_id: camera.id,
      zone_id: camera.zone_id,
      detected_at: payload.passedAt.toISOString(),
      object_class: "vehicle",
      confidence: null,
      raw: payload.raw,
      source_ip: ip,
      ingest_key_id: camera.ingest_secret_hash
        ? (camera.serial_number ?? "camera")
        : "shared",
    })
    .select("id")
    .single();

  if (detectionError || !detection) {
    if (detectionError?.code === "23505") {
      console.warn("Vjezd odmítnut: přehraný požadavek", {
        ip,
        serial: payload.cameraSerial,
      });
      return jsonError(409, "duplicate_passage");
    }
    console.error("Zápis detekce vjezdu selhal", {
      camera_id: camera.id,
      message: detectionError?.message,
    });
    return jsonError(500, "detection_insert_failed");
  }

  // ── Snímek ─────────────────────────────────────────────────────
  // Nahrává se ještě před odpovědí: bez něj by nebylo z čeho značku
  // číst a nahrání je jedno volání, ne dlouhá práce.
  const passageId = randomUUID();
  let imagePath: string | null = null;

  if (payload.image) {
    const cesta = passageImagePath(
      camera.site_id,
      passageId,
      payload.image.mediaType,
    );
    if (cesta) {
      const { error } = await db.storage
        .from(PASSAGE_BUCKET)
        .upload(cesta, Buffer.from(payload.image.base64, "base64"), {
          contentType: payload.image.mediaType,
          upsert: false,
        });
      if (error) {
        // Vjezd se zapíše i bez snímku; ztratí se čtení značky, ne
        // celá událost.
        console.error("Nahrání snímku vjezdu selhalo", {
          camera_id: camera.id,
          message: error.message,
        });
      } else {
        imagePath = cesta;
      }
    }
  }

  const { error: passageError } = await db.from("vehicle_passages").insert({
    id: passageId,
    site_id: camera.site_id,
    camera_id: camera.id,
    detection_id: detection.id,
    image_path: imagePath,
    passed_at: payload.passedAt.toISOString(),
  });

  if (passageError) {
    console.error("Zápis vjezdu selhal", {
      detection_id: detection.id,
      message: passageError.message,
    });
    return jsonError(500, "passage_insert_failed");
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
    objectClass: "vehicle",
    detectedAt: payload.passedAt,
    receivedAt,
  };

  after(async () => {
    // 1) Zásah za vozidlo. Nečeká na značku.
    try {
      await runDispatch(context);
    } catch (error) {
      console.error("Zpracování zásahu za vjezd selhalo", {
        detection_id: detection.id,
        message: error instanceof Error ? error.message : String(error),
      });
    }

    // 2) Kamera se ozvala.
    await db
      .from("cameras")
      .update({ last_seen_at: receivedAt.toISOString() })
      .eq("id", camera.id);

    // 3) Teprve teď značka.
    if (!payload.image) return;

    try {
      const reading = await readPlateFromImage(payload.image);
      if (!reading) return;

      const outcome = await resolvePlate({
        siteId: camera.site_id,
        plate: reading.plate,
        confidence: reading.confidence,
        dispatchContext: context,
      });

      await db
        .from("vehicle_passages")
        .update({
          plate: reading.plate,
          confidence: reading.confidence,
          // Shoda se ukládá jen tehdy, když značka opravdu padla na
          // seznam. `unknown` i `unread` nechávají sloupec prázdný —
          // CHECK v databázi navíc brání shodě bez značky.
          list_match:
            outcome.match.verdict === "allow" || outcome.match.verdict === "deny"
              ? outcome.match.verdict
              : null,
          known_plate_id: outcome.match.knownPlateId,
          known_label: outcome.match.knownLabel,
          plate_read_at: new Date().toISOString(),
        })
        .eq("id", passageId);

      console.info("Značka přečtena", {
        passage_id: passageId,
        vysledek: outcome.match.verdict,
        eskalovano: outcome.escalated,
      });
    } catch (error) {
      console.error("Čtení značky po vjezdu selhalo", {
        passage_id: passageId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  return Response.json(
    { passage_id: passageId, detection_id: detection.id, plate: "pending" },
    { status: 200 },
  );
}
