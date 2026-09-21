import { timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";
import sharp from "sharp";

import {
  PREVIEW_BUCKET,
  PREVIEW_FETCH_TIMEOUT_MS,
  PREVIEW_JPEG_QUALITY,
  PREVIEW_MAX_SOURCE_BYTES,
  PREVIEW_WIDTH,
  previewPath,
} from "@/lib/cameras/preview.ts";
import { recordCronRun } from "@/lib/cron/record.ts";
import { liveStreamConfig } from "@/lib/env.ts";
import { frameUrl, streamName } from "@/lib/live/stream.ts";
import { issueLiveToken } from "@/lib/live/token.ts";
import { supabaseAdmin } from "@/lib/supabase-admin.ts";

// GET /api/cron/nahledy
//
// Vytáhne z každé kamery JEDEN snímek a uloží ho jako náhled do
// seznamu kamer. Volá se zvenčí cronem, jednou týdně — viz README.
//
// ═══ Proč to bere portál, a ne relay ═══════════════════════════════
// Relay by si musel pamatovat, kam snímek poslat, a podepisovat se
// k tomu novým způsobem. Přitom cesta už existuje a je vyšlapaná:
// `/api/frame.jpeg` je v allowlistu v Caddyfile, lístek na něj vydává
// portál a ověřuje ho sky-live — tedy táž brána, kterou chodí živý
// obraz do prohlížeče. Rozdíl je jen v tom, kdo si o snímek řekne.
//
// ═══ Proč po jedné, a ne všechny naráz ═════════════════════════════
// Každý snímek znamená, že go2rtc otevře RTSP spojení na kameru přes
// tunel. Devět naráz je devět spojení na stavbu, která u toho píše na
// karty a posílá detekce. Sekvenčně to trvá pár desítek vteřin a jednou
// týdně na tom nezáleží.
//
// ═══ Selhání jedné kamery nesmaže její starý náhled ════════════════
// Přepisuje se jen to, co se povedlo stáhnout. Kamera, která zrovna
// nejede, si nechá náhled z minule — týden starý obraz řekne pořád
// víc než prázdné místo, a datum u něj nelže.
//
// ═══ Proč to NENÍ v CRON_JOBS ══════════════════════════════════════
// Přehled hlídá běhy cronu a varuje, když nějaký vynechá (lib/cron/
// runs.ts). Tahle úloha tam schválně není: zastaralý náhled je vidět
// sám na sobě — je pod ním datum — a poplach na přehledu je od toho,
// že se nelétá nebo nechodí varování, ne od toho, že je obrázek starý.
// Do `cron_runs` se běh zapisuje normálně, takže se dá dohledat.
// ═══════════════════════════════════════════════════════════════════

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Devět kamer po jedné, každá s trpělivostí do 20 s.
export const maxDuration = 300;

interface CameraRow {
  id: string;
  name: string;
  site_id: string;
  serial_number: string | null;
}

function authorized(request: NextRequest): boolean {
  const expected = process.env.CRON_SECRET;
  // Bez nastaveného tajemství se endpoint nespustí vůbec.
  if (!expected) return false;

  const header = request.headers.get("authorization") ?? "";
  const provided = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
}

/**
 * Snímek z relaye, zmenšený na náhled.
 *
 * Vrací null, když se nepovede cokoli po cestě — volající to počítá
 * jako neúspěch u JEDNÉ kamery a jede dál.
 */
async function stahnoutSnimek(
  camera: CameraRow,
  config: { baseUrl: string; secret: string },
): Promise<Buffer | null> {
  // Hlavní proud, ne vedlejší: náhled se stejně zmenšuje, a co se
  // jednou zahodí kompresí vedlejšího proudu, to zpátky nepřidá.
  // Zároveň sedí poměr stran s tím, co divák uvidí v živém obrazu.
  const stream = streamName(camera.serial_number!, "main");
  const { token } = issueLiveToken({ stream, secret: config.secret });

  try {
    const odpoved = await fetch(frameUrl({ baseUrl: config.baseUrl, stream, token }), {
      signal: AbortSignal.timeout(PREVIEW_FETCH_TIMEOUT_MS),
      cache: "no-store",
    });

    if (!odpoved.ok) {
      console.warn("Náhled: relay snímek nedal", {
        camera_id: camera.id,
        stream,
        status: odpoved.status,
      });
      return null;
    }

    const raw = Buffer.from(await odpoved.arrayBuffer());
    if (raw.byteLength === 0 || raw.byteLength > PREVIEW_MAX_SOURCE_BYTES) {
      console.warn("Náhled: snímek má nečekanou velikost", {
        camera_id: camera.id,
        bytes: raw.byteLength,
      });
      return null;
    }

    return await sharp(raw)
      .resize({ width: PREVIEW_WIDTH, withoutEnlargement: true })
      .jpeg({ quality: PREVIEW_JPEG_QUALITY })
      .toBuffer();
  } catch (error) {
    console.warn("Náhled se nepodařilo pořídit", {
      camera_id: camera.id,
      stream,
      message: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export async function GET(request: NextRequest): Promise<Response> {
  if (!authorized(request)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  let config;
  try {
    config = liveStreamConfig();
  } catch (caught) {
    // Bez adresy relaye není odkud snímky brát. Není to chyba běhu,
    // je to nenastavené prostředí — a 503 to říká líp než 500.
    console.error("Náhledy: živý obraz není nastavený", {
      message: caught instanceof Error ? caught.message : String(caught),
    });
    await recordCronRun("previews", { error: "live_not_configured" }, false);
    return Response.json({ error: "live_not_configured" }, { status: 503 });
  }

  const db = supabaseAdmin();

  const { data, error } = await db
    .from("cameras")
    .select("id, name, site_id, serial_number")
    .eq("ingest_mode", "ftp")
    .neq("status", "decommissioned")
    .order("name")
    .returns<CameraRow[]>();

  if (error) {
    console.error("Náhledy: načtení kamer selhalo", { message: error.message });
    await recordCronRun("previews", { error: "cameras_query_failed" }, false);
    return Response.json({ error: "cameras_query_failed" }, { status: 500 });
  }

  // Bez sériového čísla ji relay nemá jak pojmenovat — stejné pravidlo
  // jako v seznamu kamer a v konfiguraci go2rtc.
  const kamery = (data ?? []).filter((row) => row.serial_number);

  const report = {
    cameras: kamery.length,
    /** Kamer bez sériového čísla, tedy nedodělaných. */
    skipped: (data ?? []).length - kamery.length,
    updated: 0,
    failed: 0,
    bytes: 0,
  };

  for (const camera of kamery) {
    const snimek = await stahnoutSnimek(camera, config);
    if (!snimek) {
      // Starý náhled zůstává. Viz úvodní komentář.
      report.failed += 1;
      continue;
    }

    const cesta = previewPath(camera.site_id, camera.id);

    const { error: uploadError } = await db.storage
      .from(PREVIEW_BUCKET)
      .upload(cesta, snimek, {
        contentType: "image/jpeg",
        // Náhled je jeden a přepisuje se; historie by jen zaplňovala
        // úložiště a nikdo by ji nečetl.
        upsert: true,
      });

    if (uploadError) {
      console.error("Náhled se nepodařilo uložit", {
        camera_id: camera.id,
        cesta,
        message: uploadError.message,
        // Nejčastější příčina po nasazení kódu bez migrace.
        napoveda: "Existuje bucket `nahledy`? Zakládá ho migrace 20260921120000.",
      });
      report.failed += 1;
      continue;
    }

    const { error: updateError } = await db
      .from("cameras")
      .update({
        preview_path: cesta,
        preview_captured_at: new Date().toISOString(),
      })
      .eq("id", camera.id);

    if (updateError) {
      // Soubor v úložišti je, ale kamera o něm neví — pro UI to je
      // totéž jako kdyby nebyl, protože se čte z databáze.
      console.error("Náhled se nepodařilo zapsat ke kameře", {
        camera_id: camera.id,
        message: updateError.message,
        napoveda:
          "Chybí sloupce preview_path/preview_captured_at? Migrace 20260921120000.",
      });
      report.failed += 1;
      continue;
    }

    report.updated += 1;
    report.bytes += snimek.byteLength;
  }

  // ═══ Kdy se to považuje za selhání ══════════════════════════════
  // Jedna kamera, která zrovna nejede, není důvod budit maily každý
  // týden — starý náhled zůstal a datum u něj nelže. Selhání je až
  // stav, kdy neprošla ANI JEDNA: to znamená rozbitou cestu
  // k relayi nebo chybějící bucket, a to se samo nespraví.
  const selhalo = kamery.length > 0 && report.updated === 0;

  console.info("Náhledy kamer hotové", report);
  await recordCronRun("previews", report, !selhalo);

  return Response.json(report, { status: selhalo ? 500 : 200 });
}
