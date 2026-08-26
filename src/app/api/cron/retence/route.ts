import { timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";

import { recordCronRun } from "@/lib/cron/record.ts";
import { DETECTION_BUCKET } from "@/lib/detections/storage.ts";
import { FLIGHT_BUCKET } from "@/lib/flights/storage.ts";
import { PASSAGE_BUCKET } from "@/lib/plates/storage.ts";
import {
  batches,
  expiredPaths,
  MAX_DELETES_PER_RUN,
  retentionCutoff,
  type RetentionRow,
} from "@/lib/retention/rules.ts";
import { supabaseAdmin } from "@/lib/supabase-admin.ts";

// GET /api/cron/retence
//
// Maže z úložiště soubory starší než sites.retention_days. Volá se
// zvenčí cronem, jednou denně — viz README.
//
// ═══ Řádky zůstávají, mizí jen soubory ═════════════════════════════
// Detekce, vjezd i let jsou důkazy a nemažou se; po lhůtě jen přestanou
// nést obrázek. Cesta se přitom vynuluje, aby UI nenabízelo odkaz na
// soubor, který už není — „snímek se nepodařilo načíst“ vypadá jako
// porucha, kdežto „snímek už není“ je stav, který se dá vysvětlit.
//
// Bez tohohle běhu rostlo úložiště donekonečna: jeden let z dronu jsou
// desítky megabajtů a hlídka létá každou hodinu.
// ═══════════════════════════════════════════════════════════════════

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Mazání jde po dávkách a lokalit může být víc.
export const maxDuration = 300;

interface SiteRow {
  id: string;
  name: string;
  retention_days: number | null;
}

/** Jeden druh souboru: odkud ho vzít, kde leží a jak se pak uklidí. */
interface Druh {
  /** Do souhrnu. */
  key: "media" | "detections" | "passages";
  bucket: string;
  table: "media" | "detections" | "vehicle_passages";
  /** Sloupec s časem, podle kterého se počítá stáří. */
  timeColumn: string;
  /** Přes co se omezí na lokalitu. media visí na letu, ne na lokalitě. */
  siteColumn: string | null;
}

const DRUHY: Druh[] = [
  // Média z letů jsou zdaleka největší položka.
  { key: "media", bucket: FLIGHT_BUCKET, table: "media", timeColumn: "created_at", siteColumn: null },
  { key: "detections", bucket: DETECTION_BUCKET, table: "detections", timeColumn: "detected_at", siteColumn: "site_id" },
  { key: "passages", bucket: PASSAGE_BUCKET, table: "vehicle_passages", timeColumn: "passed_at", siteColumn: "site_id" },
];

function authorized(request: NextRequest): boolean {
  const expected = process.env.CRON_SECRET;
  if (!expected) return false;

  const header = request.headers.get("authorization") ?? "";
  const provided = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
}

export async function GET(request: NextRequest): Promise<Response> {
  if (!authorized(request)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const db = supabaseAdmin();
  const now = new Date();

  const { data: sites, error } = await db
    .from("sites")
    .select("id, name, retention_days")
    .returns<SiteRow[]>();

  if (error) {
    // Chybějící sloupec (migrace 20260909120000 ještě neběžela) není
    // důvod hlásit chybu cronu — jen se zatím nemaže.
    console.error("Načtení lokalit pro retenci selhalo", { message: error.message });
    await recordCronRun("retention", { error: "sites_query_failed" });
    return Response.json({ error: "sites_query_failed" }, { status: 500 });
  }

  const report = {
    sites: sites?.length ?? 0,
    deleted: { media: 0, detections: 0, passages: 0 },
    failed: 0,
    /** Strop se vyčerpal a zbytek zůstal na příště. */
    truncated: false,
  };

  let zbyva = MAX_DELETES_PER_RUN;

  for (const site of sites ?? []) {
    const cutoff = retentionCutoff(site.retention_days, now);

    for (const druh of DRUHY) {
      if (zbyva <= 0) {
        report.truncated = true;
        break;
      }

      try {
        const smazano = await uklidit(db, site, druh, cutoff, zbyva);
        report.deleted[druh.key] += smazano;
        zbyva -= smazano;
      } catch (caught) {
        // Selhání jednoho druhu ani jedné lokality nesmí shodit zbytek.
        report.failed += 1;
        console.error("Úklid úložiště selhal", {
          site_id: site.id,
          druh: druh.key,
          message: caught instanceof Error ? caught.message : String(caught),
        });
      }
    }
  }

  await recordCronRun("retention", report);

  // Nenulové failed musí být vidět ve stavu — cron volá někdo zvenčí
  // přes `curl -f` a ten upozorní jen na chybový stav.
  return Response.json(report, { status: report.failed > 0 ? 500 : 200 });
}

/**
 * Smaže prošlé soubory jednoho druhu na jedné lokalitě.
 *
 * Cesta se v databázi vynuluje AŽ po úspěšném smazání: kdyby se to
 * zapsalo dřív a mazání selhalo, soubor by v úložišti zůstal navždy
 * a nikdo by o něm nevěděl.
 */
async function uklidit(
  db: ReturnType<typeof supabaseAdmin>,
  site: SiteRow,
  druh: Druh,
  cutoff: Date,
  limit: number,
): Promise<number> {
  let query = db
    .from(druh.table)
    .select(`storage_path, ${druh.timeColumn}`)
    .not("storage_path", "is", null)
    .lt(druh.timeColumn, cutoff.toISOString())
    .limit(limit);

  // Média visí na letu, ne přímo na lokalitě. Filtrují se proto přes
  // cestu: první složka je UUID lokality, což platí ve všech bucketech.
  if (druh.siteColumn) query = query.eq(druh.siteColumn, site.id);
  else query = query.like("storage_path", `${site.id}/%`);

  const { data, error } = await query.returns<Record<string, string | null>[]>();
  if (error) throw new Error(error.message);

  const rows: RetentionRow[] = (data ?? []).map((row) => ({
    storage_path: row.storage_path,
    at: row[druh.timeColumn] ?? null,
  }));

  const cesty = expiredPaths(rows, cutoff);
  if (cesty.length === 0) return 0;

  let smazano = 0;

  for (const davka of batches(cesty)) {
    const { error: removeError } = await db.storage.from(druh.bucket).remove(davka);
    if (removeError) throw new Error(`mazání: ${removeError.message}`);

    const { error: updateError } = await db
      .from(druh.table)
      .update({ storage_path: null })
      .in("storage_path", davka);
    if (updateError) throw new Error(`vynulování cesty: ${updateError.message}`);

    smazano += davka.length;
  }

  console.info("Úklid úložiště", {
    site: site.name,
    druh: druh.key,
    smazano,
    starsi_nez: cutoff.toISOString(),
  });

  return smazano;
}
