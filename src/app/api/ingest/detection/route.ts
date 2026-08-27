import { after, type NextRequest } from "next/server";

import { runDispatch, type DispatchContext } from "@/lib/dispatch/run.ts";
import { ingestSecret } from "@/lib/env.ts";
import {
  cameraKeyFingerprint,
  deriveCameraKey,
} from "@/lib/ingest/camera-key.ts";
import { parseDetectionPayload } from "@/lib/ingest/payload.ts";
import {
  findIngestCamera,
  type IngestCameraRow,
} from "@/lib/ingest/camera-lookup.ts";
import { cameraCapabilities } from "@/lib/ingest/camera-lookup.ts";
import { clientIp, takeIngestToken } from "@/lib/ingest/rate-limit.ts";
import { markUnexpectedClass } from "@/lib/ingest/unexpected.ts";
import { DETECTION_BUCKET } from "@/lib/detections/storage.ts";
import { ingestImagePath, MAX_IMAGE_BYTES } from "@/lib/ingest/image.ts";
import {
  publicFailureReason,
  verifySignature,
  type SignatureResult,
} from "@/lib/ingest/signature.ts";
import { supabaseAdmin } from "@/lib/supabase-admin.ts";

// POST /api/ingest/detection
//
// Příjem detekcí z kamer. Endpoint musí odpovědět do 1 s, proto dělá
// synchronně jen dvě věci: ověří podpis a zapíše detekci. Rozhodnutí
// o zásahu i volání FlightHubu (timeout 5 s) běží až po odeslání
// odpovědi přes `after()` — detekce se tak zapíše i tehdy, když je
// FlightHub nedostupný.
//
// Pořadí kroků: tělo → kamera → podpis. Kamera se musí dohledat dřív,
// než se ověří podpis, protože každá má vlastní klíč (migrace
// 20260829120000). Dohledání proto stojí dotaz i u nepodepsaného
// požadavku — bez omezení počtu požadavků je to cesta, jak endpoint
// zatížit, a je to vědomý kompromis.
//
// Neznámé sériové číslo NESMÍ vracet jiný stav než neplatný podpis,
// dokud podpis neprošel — jinak by šlo přes endpoint zjišťovat, které
// kamery existují.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function jsonError(status: number, error: string, detail?: unknown) {
  return Response.json(
    detail === undefined ? { error } : { error, detail },
    { status },
  );
}

/**
 * Ověření podpisu klíčem té kamery, za kterou se požadavek vydává.
 *
 * Neznámá kamera se ověřuje společným tajemstvím: nová kamera se tak
 * dá zapojit ještě před tím, než ji někdo založí v portálu, a hlavně
 * to nedá jinou odpověď než u kamery existující. Rozdíl mezi „neznámá“
 * a „špatný podpis“ se volajícímu přizná až po platném podpisu.
 */
function verifyForCamera(options: {
  rawBody: string;
  signature: string | null;
  timestamp: string | null;
  now: Date;
  masterSecret: string;
  camera: IngestCameraRow | null;
}): SignatureResult {
  const { rawBody, signature, timestamp, now, masterSecret, camera } = options;
  const base = { rawBody, signature, timestamp, now };

  const serial = camera?.serial_number;
  if (!camera || !camera.ingest_secret_hash || !serial) {
    if (camera) {
      // Fallback na společné tajemství. Loguje se, aby bylo vidět, které
      // kamery ještě čekají na vlastní klíč — bez toho by se na ně při
      // rotaci INGEST_SECRET zapomnělo.
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
  } catch (error) {
    console.error("Klíč kamery nejde odvodit", {
      camera_id: camera.id,
      message: error instanceof Error ? error.message : String(error),
    });
    return { valid: false, reason: "signature_mismatch" };
  }

  if (cameraKeyFingerprint(derived) !== camera.ingest_secret_hash) {
    // Uložený otisk nepatří ke klíči, který z INGEST_SECRET vyjde —
    // typicky po rotaci hlavního tajemství bez přegenerování kamer.
    // Bez tohohle hlášení by kamera jen tiše přestala hlásit.
    console.error("Otisk klíče kamery nesedí na odvozený klíč", {
      camera_id: camera.id,
      key_version: camera.ingest_key_version,
    });
    return { valid: false, reason: "signature_mismatch" };
  }

  return verifySignature({ ...base, secret: derived });
}

/**
 * Nad tímhle se tělo ani nečte.
 *
 * Samotná detekce je pár set bajtů, ale smí s sebou nést snímek —
 * base64 ho nafoukne o třetinu. Stejný výpočet jako u vjezdů.
 */
const MAX_BODY_BYTES = Math.ceil(MAX_IMAGE_BYTES * 1.4) + 8 * 1024;

export async function POST(request: NextRequest): Promise<Response> {
  // Jeden čas pro celý požadavek: podle něj se ověřuje stáří podpisu,
  // omezuje hlášený detected_at i vyhodnocuje ostrý režim. Kdyby si ho
  // každý krok bral zvlášť, mohly by se na hranici okna rozejít.
  const receivedAt = new Date();
  const ip = clientIp(request.headers);

  // Velikost se kontroluje z hlavičky, tedy DŘÍV, než se tělo přečte.
  // Číst megabajty od někoho, kdo se ještě neprokázal, je zbytečná
  // práce — a od chvíle, kdy se kvůli klíči kamery sahá do databáze
  // před ověřením podpisu, i levná cesta, jak endpoint zatížit.
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    console.warn("Ingest odmítnut: tělo je moc velké", {
      ip,
      content_length: declaredLength,
    });
    return jsonError(413, "payload_too_large");
  }

  // Raw tělo je potřeba přesně tak, jak dorazilo — přeparsovaný JSON
  // by dal jiné bajty a podpis by nesedl.
  const rawBody = await request.text();

  // Hlavičce se nedá věřit; po přečtení se ověří skutečná délka.
  if (rawBody.length > MAX_BODY_BYTES) {
    console.warn("Ingest odmítnut: tělo je moc velké", {
      ip,
      bytes: rawBody.length,
    });
    return jsonError(413, "payload_too_large");
  }

  let secret: string;
  try {
    secret = ingestSecret();
  } catch {
    // Chybějící konfigurace nesmí vypadat jako neplatný podpis.
    console.error("INGEST_SECRET není nastavený");
    return jsonError(500, "server_misconfigured");
  }

  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    console.warn("Ingest odmítnut: tělo není JSON", { ip });
    return jsonError(400, "invalid_json");
  }

  const parsed = parseDetectionPayload(body, receivedAt);
  if (!parsed.ok) {
    console.warn("Ingest odmítnut: vadný obsah", { ip, duvody: parsed.errors });
    return jsonError(400, "invalid_payload", parsed.errors);
  }

  const { payload } = parsed;
  const db = supabaseAdmin();

  // Limit až tady: dřív není podle čeho počítat vědro kamery. Pořád
  // ale před dohledáním kamery a před ověřením podpisu, což jsou
  // dražší kroky.
  const limit = await takeIngestToken(db, {
    cameraSerial: payload.cameraSerial,
    ip,
  });
  if (!limit.allowed) {
    console.warn("Ingest odmítnut: překročen limit", {
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
    masterSecret: secret,
    camera,
  });

  if (!check.valid) {
    // Zamítnutí se logují: dřív po nich nezůstávalo nic a kamera
    // s rozjetými hodinami nebo starým klíčem tiše umlkla.
    console.warn("Ingest odmítnut: podpis neprošel", {
      ip,
      serial: payload.cameraSerial,
      duvod: check.reason,
      znama_kamera: Boolean(camera),
    });
    // Do odpovědi jde důvod jen tehdy, když se dá prozradit; do logu
    // výš jde vždycky celý.
    return jsonError(401, "unauthorized", publicFailureReason(check.reason) ?? undefined);
  }

  // Až za platným podpisem se smí přiznat, že kamera není v evidenci.
  if (!camera || !camera.sites) {
    console.warn("Ingest odmítnut: neznámá kamera", {
      ip,
      serial: payload.cameraSerial,
    });
    return jsonError(404, "unknown_camera");
  }

  // Detekce se zapisuje vždy, ještě před jakýmkoli rozhodováním
  // ── Hlásí kamera to, co umí? ───────────────────────────────────
  // Detekce se zapíše tak jako tak a rozhodnutí o zásahu se nemění;
  // jen po ní zůstane stopa, že přišla od kamery, která tuhle třídu
  // podle nastavení nezvládá. Bývá to výměna modelu, na kterou nikdo
  // neupravil portál — a to se má poznat dřív než z toho, že se něco
  // chová divně.
  const { raw: rawSPoznamkou, note: neocekavana } = markUnexpectedClass({
    raw: payload.raw,
    capabilities: cameraCapabilities(camera),
    objectClass: payload.objectClass,
  });

  if (neocekavana) {
    console.warn("Kamera hlásí třídu, kterou podle nastavení neumí", {
      camera_id: camera.id,
      serial: payload.cameraSerial,
      object_class: payload.objectClass,
      umi: neocekavana.camera_can,
    });
  }

  // o zásahu — je to důkaz, ne vedlejší produkt zásahu.
  const { data: detection, error: detectionError } = await db
    .from("detections")
    .insert({
      source_ip: ip,
      // Čím byl požadavek podepsaný: vlastním klíčem kamery, nebo
      // společným tajemstvím. Bez toho by po rotaci klíčů nešlo zjistit,
      // které kamery ještě jedou na starém.
      ingest_key_id: camera.ingest_secret_hash
        ? (camera.serial_number ?? "camera")
        : "shared",
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
      raw: rawSPoznamkou,
    })
    .select("id")
    .single();

  if (detectionError || !detection) {
    // 23505 na idx_detections_replay_guard = tatáž detekce už tu je.
    // Uvnitř tolerance podpisu jde požadavek přehrát a podpis na něm
    // sedí; unikát je to jediné, co přehrání od skutečnosti odliší.
    if (detectionError?.code === "23505") {
      console.warn("Ingest odmítnut: přehraný požadavek", {
        ip,
        serial: payload.cameraSerial,
        detected_at: payload.detectedAt.toISOString(),
      });
      return jsonError(409, "duplicate_detection");
    }

    console.error("Zápis detekce selhal", {
      camera_id: camera.id,
      message: detectionError?.message,
    });
    return jsonError(500, "detection_insert_failed");
  }

  // ── Snímek ─────────────────────────────────────────────────────
  // Až po zápisu detekce a schválně mimo after(): cesta se ukládá na
  // řádek, takže by ji zápis na pozadí musel dopisovat druhým dotazem.
  // Nahrání je jedno volání, ne dlouhá práce.
  //
  // Selhání snímku NESMÍ shodit detekci. Přijít o obrázek je nepříjemné,
  // přijít o záznam, že někdo byl v areálu, je něco jiného.
  if (payload.image) {
    const cesta = ingestImagePath(
      camera.site_id,
      detection.id,
      payload.image.mediaType,
    );
    if (cesta) {
      const { error: uploadError } = await db.storage
        .from(DETECTION_BUCKET)
        .upload(cesta, Buffer.from(payload.image.base64, "base64"), {
          contentType: payload.image.mediaType,
          upsert: false,
        });

      if (uploadError) {
        console.error("Nahrání snímku detekce selhalo", {
          detection_id: detection.id,
          message: uploadError.message,
        });
      } else {
        const { error: pathError } = await db
          .from("detections")
          .update({ storage_path: cesta })
          .eq("id", detection.id);
        if (pathError) {
          console.error("Zápis cesty snímku selhal", {
            detection_id: detection.id,
            message: pathError.message,
          });
        }
      }
    }
  }

  // Kamera se ozvala. Bez tohohle razítka nešlo odlišit klidnou noc od
  // kamery, která tři dny mlčí — přehled na to teď upozorňuje.
  //
  // after(): zápis se nesmí připlést do jedné sekundy, kterou má
  // endpoint na odpověď, a když selže, přijde o něj jen ten sloupec.
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
    objectClass: payload.objectClass,
    detectedAt: payload.detectedAt,
    receivedAt,
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
