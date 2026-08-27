import { after, type NextRequest } from "next/server";

import { relaySecrets } from "@/lib/env.ts";
import { clientIp, takeIngestToken } from "@/lib/ingest/rate-limit.ts";
import {
  mayIssueUploadUrl,
  parseRecordingAnnounce,
} from "@/lib/ingest/recording-payload.ts";
import { publicFailureReason } from "@/lib/ingest/signature.ts";
import { verifyRelay } from "@/lib/ingest/verify-relay.ts";
import {
  RECORDING_BUCKET,
  UPLOAD_URL_TTL_SECONDS,
  recordingPath,
  recordingPlayback,
} from "@/lib/recordings/storage.ts";
import { supabaseAdmin } from "@/lib/supabase-admin.ts";

// POST /api/ingest/recording
//
// Relay ohlásí, že má hotový záznam ze stavební kamery. Portál ho
// zapíše a vrátí JEDNORÁZOVOU nahrávací adresu; soubor jde pak přímo
// do úložiště, mimo tuhle funkci.
//
// ═══ Proč to nejde jedním požadavkem se souborem ═══════════════════
// Serverless funkce má strop na velikost těla v jednotkách MB a minutový
// úsek z kamery jich má desítky. Ale i kdyby prošel, byl by to zbytečný
// průtok dat přes Vercel — soubor si úložiště umí převzít samo.
//
// ═══ Proč relay nemá klíč k úložišti ═══════════════════════════════
// Supabase S3 klíč se nedá omezit na jeden bucket a obchází RLS, takže
// by kompromitace VPS znamenala přístup k záznamům z dronu, ke snímkům
// vjezdů i k logům všech klientů. Relay proto drží jediné tajemství:
// RELAY_SECRET, kterým se podepisuje tady.
//
// ═══ Relay není kamera ═════════════════════════════════════════════
// Podepisuje se vlastním tajemstvím, ne klíčem kamery — mluví za víc
// kamer naráz a kameru pojmenuje sériovým číslem v těle. Kamera musí
// být v portálu vedená jako `ingest_mode = 'ftp'`; kamera, která se
// umí podepsat sama, si relay mluvit za sebe nenechá.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Tělo je jen metadata; soubor jde jinudy. */
const MAX_BODY_BYTES = 8 * 1024;

function jsonError(status: number, error: string, detail?: unknown) {
  return Response.json(
    detail === undefined ? { error } : { error, detail },
    { status },
  );
}

interface CameraRow {
  id: string;
  site_id: string;
  ingest_mode: "http" | "ftp";
}

interface ExistingRow {
  id: string;
  storage_path: string | null;
  uploaded_at: string | null;
  video_expired_at: string | null;
}

export async function POST(request: NextRequest): Promise<Response> {
  const receivedAt = new Date();
  const ip = clientIp(request.headers);

  const rawBody = await request.text();
  if (rawBody.length > MAX_BODY_BYTES) {
    console.warn("Ohlášení záznamu odmítnuto: tělo je moc velké", { ip });
    return jsonError(413, "payload_too_large");
  }

  let secrets: string[];
  try {
    secrets = relaySecrets();
  } catch {
    console.error("RELAY_SECRET není nastavený");
    return jsonError(500, "server_misconfigured");
  }

  // Podpis se ověřuje PŘED čtením těla jako JSON: nepodepsanému
  // volajícímu se nemá co odpovídat o tvaru našeho API.
  const signature = request.headers.get("x-signature");
  const timestamp = request.headers.get("x-timestamp");

  const check = verifyRelay({
    rawBody,
    signature,
    timestamp,
    now: receivedAt,
    secrets,
  });
  const usedPrevious = check.valid && check.usedPrevious;

  if (!check.valid) {
    console.warn("Ohlášení záznamu odmítnuto: podpis neprošel", {
      ip,
      duvod: check.reason,
    });
    return jsonError(401, "unauthorized", publicFailureReason(check.reason) ?? undefined);
  }

  if (usedPrevious) {
    // Rotace RELAY_SECRET ještě neskončila. Bez tohohle hlášení by se
    // nedalo poznat, kdy se dá stará hodnota smazat.
    console.warn("Relay jede na PŘEDCHOZÍM tajemství — čeká na přepnutí", { ip });
  }

  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return jsonError(400, "invalid_json");
  }

  const parsed = parseRecordingAnnounce(body, receivedAt);
  if (!parsed.ok) {
    console.warn("Ohlášení záznamu odmítnuto: vadný obsah", {
      ip,
      duvody: parsed.errors,
    });
    return jsonError(400, "invalid_payload", parsed.errors);
  }

  const { payload } = parsed;
  const db = supabaseAdmin();

  const limit = await takeIngestToken(db, {
    cameraSerial: payload.cameraSerial,
    ip,
  });
  if (!limit.allowed) {
    return jsonError(429, "rate_limited");
  }

  // ── Kamera ─────────────────────────────────────────────────────
  const { data: camera, error: cameraError } = await db
    .from("cameras")
    .select("id, site_id, ingest_mode")
    .eq("serial_number", payload.cameraSerial)
    .maybeSingle<CameraRow>();

  if (cameraError) {
    console.error("Dohledání kamery selhalo", { message: cameraError.message });
    return jsonError(500, "lookup_failed");
  }

  if (!camera) {
    console.warn("Ohlášení záznamu: neznámá kamera", {
      ip,
      serial: payload.cameraSerial,
    });
    return jsonError(404, "unknown_camera");
  }

  if (camera.ingest_mode !== "ftp") {
    // Kamera, která se umí podepsat sama, nemá důvod mluvit přes relay.
    // Kdyby to prošlo, dal by se relayovým tajemstvím podvrhnout záznam
    // libovolné kamery v portálu.
    console.warn("Ohlášení záznamu: kamera není vedená jako FTP", {
      camera_id: camera.id,
      ingest_mode: camera.ingest_mode,
    });
    return jsonError(409, "camera_not_ftp");
  }

  // ── Idempotence ────────────────────────────────────────────────
  const { data: existing } = await db
    .from("camera_recordings")
    .select("id, storage_path, uploaded_at, video_expired_at")
    .eq("sd_file_path", payload.sdFilePath)
    .maybeSingle<ExistingRow>();

  if (existing) {
    const stav = recordingPlayback(existing);

    if (!mayIssueUploadUrl(stav)) {
      // Soubor už dorazil. Vystavit adresu znovu by znamenalo dát
      // možnost přepsat hotový záznam.
      return Response.json(
        { recording_id: existing.id, status: stav, upload_url: null },
        { status: 200 },
      );
    }

    // Nedokončený pokus: relay to zkouší znovu, dostane novou adresu
    // na tutéž cestu.
    if (existing.storage_path) {
      const url = await podepsatNahrani(db, existing.storage_path);
      if (!url) return jsonError(500, "upload_url_failed");
      return Response.json(
        { recording_id: existing.id, storage_path: existing.storage_path, ...url },
        { status: 200 },
      );
    }
  }

  // ── Nový záznam ────────────────────────────────────────────────
  const storagePath = recordingPath({
    siteId: camera.site_id,
    cameraId: camera.id,
    startedAt: payload.startedAt,
    eventType: payload.eventType,
    mediaType: payload.mediaType,
  });

  if (!storagePath) {
    return jsonError(400, "invalid_payload", ["z těchhle údajů nejde složit cesta"]);
  }

  const { data: created, error: insertError } = await db
    .from("camera_recordings")
    .insert({
      camera_id: camera.id,
      started_at: payload.startedAt.toISOString(),
      ended_at: payload.endedAt?.toISOString() ?? null,
      event_type: payload.eventType,
      sd_file_path: payload.sdFilePath,
      storage_path: storagePath,
      // uploaded_at se vyplní až potvrzením. Do té doby je to záznam,
      // ke kterému soubor teprve poletí.
    })
    .select("id")
    .single();

  if (insertError || !created) {
    // 23505 = jiný běh relaye stihl týž soubor mezitím. Není to chyba,
    // ale závod — a vyhrál ten druhý.
    if (insertError?.code === "23505") {
      return jsonError(409, "duplicate_recording");
    }
    console.error("Zápis záznamu selhal", {
      camera_id: camera.id,
      message: insertError?.message,
    });
    return jsonError(500, "insert_failed");
  }

  const url = await podepsatNahrani(db, storagePath);
  if (!url) return jsonError(500, "upload_url_failed");

  // Kamera se ozvala. Tohle razítko nahrazuje celý hlídač výpadků
  // z constructiva-portal — Sky Guard z něj umí varovat sám.
  after(async () => {
    const { error } = await db
      .from("cameras")
      .update({ last_seen_at: receivedAt.toISOString() })
      .eq("id", camera.id);
    if (error) {
      console.error("Zápis last_seen_at selhal", {
        camera_id: camera.id,
        message: error.message,
      });
    }
  });

  console.info("Záznam ohlášen", {
    recording_id: created.id,
    camera_id: camera.id,
    sd_file_path: payload.sdFilePath,
  });

  return Response.json(
    { recording_id: created.id, storage_path: storagePath, ...url },
    { status: 201 },
  );
}

/** Jednorázová adresa pro nahrání. Platí dvě hodiny, viz storage.ts. */
async function podepsatNahrani(
  db: ReturnType<typeof supabaseAdmin>,
  storagePath: string,
): Promise<{ upload_url: string; upload_token: string; expires_in: number } | null> {
  const { data, error } = await db.storage
    .from(RECORDING_BUCKET)
    // upsert: relay smí opakovat nedokončený pokus na tutéž cestu.
    // Hotový záznam se sem nedostane — zastaví ho mayIssueUploadUrl().
    .createSignedUploadUrl(storagePath, { upsert: true });

  if (error || !data) {
    console.error("Podepsání nahrávací adresy selhalo", {
      storage_path: storagePath,
      message: error?.message,
    });
    return null;
  }

  return {
    upload_url: data.signedUrl,
    upload_token: data.token,
    expires_in: UPLOAD_URL_TTL_SECONDS,
  };
}
