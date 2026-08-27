import { randomUUID } from "node:crypto";
import { after, type NextRequest } from "next/server";

import { runDispatch, type DispatchContext } from "@/lib/dispatch/run.ts";
import { ingestSecrets } from "@/lib/env.ts";
import {
  MAX_IMAGE_BYTES,
  parsePassagePayload,
} from "@/lib/ingest/passage-payload.ts";
import {
  cameraCapabilities,
  findIngestCamera,
} from "@/lib/ingest/camera-lookup.ts";
import { planPlateRead } from "@/lib/ingest/capabilities.ts";
import { markUnexpectedClass } from "@/lib/ingest/unexpected.ts";
import { clientIp, takeIngestToken } from "@/lib/ingest/rate-limit.ts";
import { publicFailureReason } from "@/lib/ingest/signature.ts";
import { verifyForCamera } from "@/lib/ingest/verify-camera.ts";
import { resolvePlate } from "@/lib/plates/escalate.ts";
import { readPlateFromImage, type PlateReading } from "@/lib/plates/reader.ts";
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
 * Střeží lokalita? Ptáme se jen kvůli vyhodnocení ohlášení, protože
 * to samo rozhodnutí o zásahu nedělá — od toho je runDispatch.
 *
 * Když se stav nepodaří zjistit, bere se jako STŘEŽENO. Ohlášení pak
 * kryje jen s night_ok, což je ta přísnější varianta: neznámý stav
 * nemá odbavovat auta.
 */
async function isSiteArmedNow(
  db: ReturnType<typeof supabaseAdmin>,
  siteId: string,
  at: Date,
): Promise<boolean> {
  const { data, error } = await db.rpc("site_is_armed", {
    p_site_id: siteId,
    p_at: at.toISOString(),
  });

  if (error) {
    console.warn("Režim střežení pro vyhodnocení ohlášení se nezjistil", {
      site_id: siteId,
      message: error.message,
    });
    return true;
  }

  return data === true;
}

/**
 * Strop na celé tělo. Snímek smí mít MAX_IMAGE_BYTES; base64 ho
 * nafoukne o třetinu a zbytek JSONu je pár set bajtů.
 */
const MAX_BODY_BYTES = Math.ceil(MAX_IMAGE_BYTES * 1.4) + 8 * 1024;

function jsonError(status: number, error: string, detail?: unknown) {
  return Response.json(
    detail === undefined ? { error } : { error, detail },
    { status },
  );
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

  let secrets: string[];
  try {
    secrets = ingestSecrets();
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

  const lookup = await findIngestCamera(db, payload.cameraSerial);
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
    secrets,
    camera,
  });

  if (!check.valid) {
    console.warn("Vjezd odmítnut: podpis neprošel", {
      ip,
      serial: payload.cameraSerial,
      duvod: check.reason,
      znama_kamera: Boolean(camera),
    });
    // Do odpovědi jde důvod jen tehdy, když se dá prozradit; do logu
    // výš jde vždycky celý.
    return jsonError(401, "unauthorized", publicFailureReason(check.reason) ?? undefined);
  }

  if (!camera || !camera.sites) {
    console.warn("Vjezd odmítnut: neznámá kamera", { ip, serial: payload.cameraSerial });
    return jsonError(404, "unknown_camera");
  }

  // ── Umí tahle kamera vůbec vozidla? ────────────────────────────
  // Vjezd JE detekce vozidla, takže kamera bez detects_vehicle sem
  // posílat nemá co. Vjezd se přesto zapíše — přijít o záznam, že do
  // areálu vjelo auto, je horší než mít v evidenci řádek navíc.
  const capabilities = cameraCapabilities(camera);
  const { raw: rawSPoznamkou, note: neocekavana } = markUnexpectedClass({
    raw: payload.raw,
    capabilities,
    objectClass: "vehicle",
  });

  if (neocekavana) {
    console.warn("Vjezd od kamery, která podle nastavení vozidla neumí", {
      camera_id: camera.id,
      serial: payload.cameraSerial,
      umi: neocekavana.camera_can,
    });
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
      raw: rawSPoznamkou,
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
    storage_path: imagePath,
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
    siteTimezone: camera.sites.timezone,
    siteDockSn: camera.sites.dock_sn,
    zoneWaylineUuid: camera.zones?.wayline_uuid ?? null,
    zoneDefaultLevel: camera.zones?.default_level ?? null,
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
    //
    // Kamera na bráně ji často zná sama — čtení modelem je pak práce
    // navíc, která stojí vteřiny i peníze a může dopadnout hůř než
    // čidlo v závoře. Model se proto volá, jen když značka od kamery
    // chybí nebo je pod prahem jistoty. Značka z těla se přitom bere
    // JEN od kamery s reads_plate: jinak by šlo z libovolné ovládnuté
    // kamery poslat vjezd s vymyšlenou allow značkou.
    const plan = planPlateRead({
      capabilities,
      reported: payload.reported,
      hasImage: Boolean(payload.image),
    });

    if (plan.use === "none") return;

    try {
      let reading: PlateReading | null = null;
      let zdroj: "camera" | "model" = "camera";

      if (plan.use === "camera") {
        reading = { plate: plan.plate, confidence: plan.confidence };
      } else {
        reading = payload.image ? await readPlateFromImage(payload.image) : null;
        zdroj = "model";

        // Model nic nepřečetl, ale kamera něco poslala — nejistá
        // značka je pořád víc než žádná. Uloží se s tou nízkou
        // jistotou, takže se se seznamem nespáruje a do varování
        // spadne jako nepřečtená.
        if (!reading?.plate && plan.fallback?.plate) {
          reading = plan.fallback;
          zdroj = "camera";
        }
      }

      if (!reading) return;

      const outcome = await resolvePlate({
        siteId: camera.site_id,
        siteTimezone: camera.sites?.timezone ?? "Europe/Prague",
        // Ostrý režim ke chvíli PŘIJETÍ, ne k času z těla. Stejně
        // jako u rozhodnutí o zásahu: hlášený čas si určuje odesílatel.
        armed: await isSiteArmedNow(db, camera.site_id, receivedAt),
        plate: reading.plate,
        confidence: reading.confidence,
        at: receivedAt,
        dispatchContext: context,
      });

      // plate_source přidává migrace 20260910120000. Když ještě
      // neproběhla, PostgREST celý update odmítne — a přišlo by se
      // o značku, ne jen o údaj, odkud je. Proto druhý pokus bez něj.
      const zmena = {
        plate: reading.plate,
        confidence: reading.confidence,
        // Vazba na ohlášení se ukládá i tehdy, když nekrylo (denní
        // ohlášení v noci) — do seznamu vjezdů patří obojí.
        announced_arrival_id: outcome.arrival.arrival?.id ?? null,
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
      };

      const { error: updateError } = await db
        .from("vehicle_passages")
        .update({ ...zmena, plate_source: reading.plate ? zdroj : null })
        .eq("id", passageId);

      if (updateError) {
        await db.from("vehicle_passages").update(zmena).eq("id", passageId);
        console.warn("Zdroj značky se neuložil — chybí migrace 20260910120000", {
          passage_id: passageId,
        });
      }

      console.info("Značka přečtena", {
        passage_id: passageId,
        zdroj,
        vysledek: outcome.match.verdict,
        eskalovano: outcome.escalated,
        ohlaseni: outcome.arrival.arrival?.id ?? null,
        ohlaseni_kryje: outcome.arrival.covered,
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
