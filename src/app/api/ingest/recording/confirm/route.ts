import type { NextRequest } from "next/server";

import { hetznerStorageConfig, relaySecrets } from "@/lib/env.ts";
import { clientIp } from "@/lib/ingest/rate-limit.ts";
import { parseRecordingConfirm } from "@/lib/ingest/recording-payload.ts";
import { publicFailureReason } from "@/lib/ingest/signature.ts";
import { verifyRelay } from "@/lib/ingest/verify-relay.ts";
import {
  RECORDING_BUCKET,
  isRecordingBackend,
} from "@/lib/recordings/storage.ts";
import { headObject } from "@/lib/storage/objects.ts";
import { supabaseAdmin } from "@/lib/supabase-admin.ts";

// POST /api/ingest/recording/confirm
//
// Relay hlásí, že soubor nahrál. Do téhle chvíle je v databázi řádek
// bez souboru (`uploaded_at IS NULL`) a UI ho ukazuje jako „přenáší se“.
//
// ═══ Velikost se MĚŘÍ, netvrdí ═════════════════════════════════════
// Relay by ji mohl poslat v těle a bylo by to o jedno volání míň.
// Jenže `uploaded_at` je tvrzení „soubor tam je“ a to se nemá brát
// z požadavku, který jen říká, že je. Portál se proto zeptá úložiště:
// když soubor nenajde, potvrzení odmítne a záznam zůstane nedokončený.
// Relay to zkusí znovu — a když ne, je to vidět jako vjezd, u kterého
// nikdy nedošlo video, ne jako přehrávač, co nic nepřehraje.
//
// U Hetzneru to platí dvojnásob: relay tam nahrává PŘÍMO, mimo portál,
// takže tohle HEAD je jediné místo, kde se portál dozví, že soubor
// doopravdy dorazil a jak je velký. Na té velikosti pak stojí strop.
//
// ═══ Nenalezeno vs. nedalo se zeptat ═══════════════════════════════
// 404 z úložiště znamená „nedorazilo“ a potvrzení se odmítne (409).
// Výpadek úložiště je něco jiného: vrací se 503, aby to relay zkusil
// znovu. Kdyby se obojí slilo do 409, zahodil by relay hotový soubor
// jen proto, že bylo úložiště chvíli nedostupné.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 2 * 1024;

function jsonError(status: number, error: string, detail?: unknown) {
  return Response.json(
    detail === undefined ? { error } : { error, detail },
    { status },
  );
}

interface RecordingRow {
  id: string;
  storage_path: string | null;
  uploaded_at: string | null;
  storage_backend: string | null;
}

export async function POST(request: NextRequest): Promise<Response> {
  const receivedAt = new Date();
  const ip = clientIp(request.headers);

  const rawBody = await request.text();
  if (rawBody.length > MAX_BODY_BYTES) return jsonError(413, "payload_too_large");

  let secrets: string[];
  try {
    secrets = relaySecrets();
  } catch {
    console.error("RELAY_SECRET není nastavený");
    return jsonError(500, "server_misconfigured");
  }

  const signature = request.headers.get("x-signature");
  const timestamp = request.headers.get("x-timestamp");

  const check = verifyRelay({
    rawBody,
    signature,
    timestamp,
    now: receivedAt,
    secrets,
  });

  if (!check.valid) {
    console.warn("Potvrzení záznamu odmítnuto: podpis neprošel", {
      ip,
      duvod: check.reason,
    });
    return jsonError(401, "unauthorized", publicFailureReason(check.reason) ?? undefined);
  }

  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return jsonError(400, "invalid_json");
  }

  const parsed = parseRecordingConfirm(body);
  if (!parsed.ok) return jsonError(400, "invalid_payload", parsed.errors);

  const db = supabaseAdmin();

  const { data: recording, error } = await db
    .from("camera_recordings")
    .select("id, storage_path, uploaded_at, storage_backend")
    .eq("id", parsed.payload.recordingId)
    .maybeSingle<RecordingRow>();

  if (error) {
    console.error("Dohledání záznamu selhalo", { message: error.message });
    return jsonError(500, "lookup_failed");
  }

  if (!recording || !recording.storage_path) {
    return jsonError(404, "unknown_recording");
  }

  if (recording.uploaded_at) {
    // Opakované potvrzení není chyba — relay mohl přijít o odpověď.
    return Response.json({ recording_id: recording.id, status: "ready" }, { status: 200 });
  }

  // Tady se tvrzení mění v ověřený fakt.
  let velikost: number | null | undefined;
  try {
    velikost = await zmeritSoubor(db, recording);
  } catch (caught) {
    // Úložiště se neozvalo. Není to vada souboru — relay to má zkusit
    // znovu, ne záznam odepsat.
    console.error("Ověření souboru v úložišti selhalo", {
      recording_id: recording.id,
      message: caught instanceof Error ? caught.message : String(caught),
    });
    return jsonError(503, "storage_unavailable");
  }

  if (velikost === undefined) {
    console.warn("Potvrzení bez souboru v úložišti", {
      recording_id: recording.id,
      storage_path: recording.storage_path,
    });
    return jsonError(409, "file_not_found");
  }

  const { error: updateError } = await db
    .from("camera_recordings")
    .update({ uploaded_at: receivedAt.toISOString(), size_bytes: velikost })
    .eq("id", recording.id)
    // Potvrdí se jen dosud nepotvrzený záznam. Dva souběžné pokusy
    // takhle nepřepíšou čas tomu, který vyhrál.
    .is("uploaded_at", null);

  if (updateError) {
    console.error("Potvrzení záznamu selhalo", {
      recording_id: recording.id,
      message: updateError.message,
    });
    return jsonError(500, "update_failed");
  }

  console.info("Záznam potvrzen", {
    recording_id: recording.id,
    size_bytes: velikost,
  });

  return Response.json(
    { recording_id: recording.id, status: "ready", size_bytes: velikost },
    { status: 200 },
  );
}

/**
 * Velikost nahraného souboru, nebo `undefined` když tam není.
 *
 * Trojí výsledek schválně: číslo (i null, když úložiště velikost
 * neřeklo) = soubor je; `undefined` = není; výjimka = nešlo se zeptat.
 * První dva se potvrzují a odmítají, třetí se opakuje.
 */
async function zmeritSoubor(
  db: ReturnType<typeof supabaseAdmin>,
  recording: RecordingRow,
): Promise<number | null | undefined> {
  const storagePath = recording.storage_path as string;
  const backend = isRecordingBackend(recording.storage_backend)
    ? recording.storage_backend
    : "supabase";

  if (backend === "hetzner") {
    const info = await headObject(hetznerStorageConfig(), storagePath);
    return info === null ? undefined : info.size;
  }

  const { data, error } = await db.storage.from(RECORDING_BUCKET).info(storagePath);
  if (error || !data) {
    // Supabase nerozlišuje „není“ od „nešlo“ jedním typem chyby.
    // Nenalezeno je tu ale mnohem pravděpodobnější a chová se to jako
    // dřív — u starých záznamů se stejně nic nového nenahrává.
    return undefined;
  }
  return typeof data.size === "number" ? data.size : null;
}
