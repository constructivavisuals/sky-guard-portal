import { timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";

import { recordCronRun } from "@/lib/cron/record.ts";
import { DETECTION_BUCKET } from "@/lib/detections/storage.ts";
import { FLIGHT_BUCKET } from "@/lib/flights/storage.ts";
import { PASSAGE_BUCKET } from "@/lib/plates/storage.ts";
import {
  arrivalAnonymization,
  batches,
  cutoffDateISO,
  expiredPaths,
  MAX_ANONYMIZE_PER_RUN,
  MAX_DELETES_PER_RUN,
  passageAnonymization,
  RATE_LIMIT_RETENTION_MINUTES,
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
    await recordCronRun("retention", { error: "sites_query_failed" }, false);
    return Response.json({ error: "sites_query_failed" }, { status: 500 });
  }

  const report = {
    sites: sites?.length ?? 0,
    deleted: { media: 0, detections: 0, passages: 0 },
    /** Řádky, ze kterých po lhůtě zmizel osobní údaj. */
    anonymized: { passages: 0, arrivals: 0, ips: 0 },
    /** Smazaná vědra rate limitu — klíč nese IP adresu. */
    rateLimitBuckets: 0,
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

  // ── Osobní údaje po lhůtě ──────────────────────────────────────
  // Soubory výš, data tady. Řádky zůstávají — počty vjezdů v měsíčním
  // reportu musí platit i zpětně — jen z nich zmizí to, čím se dá
  // identifikovat osoba nebo vozidlo.
  for (const site of sites ?? []) {
    const cutoff = retentionCutoff(site.retention_days, now);
    try {
      const vysledek = await anonymizovat(db, site, cutoff, now);
      report.anonymized.passages += vysledek.passages;
      report.anonymized.arrivals += vysledek.arrivals;
      report.anonymized.ips += vysledek.ips;
    } catch (caught) {
      report.failed += 1;
      console.error("Anonymizace po lhůtě selhala", {
        site_id: site.id,
        message: caught instanceof Error ? caught.message : String(caught),
      });
    }
  }

  // Vědra rate limitu nevisí na lokalitě — jedno mazání za běh.
  try {
    report.rateLimitBuckets = await uklizetVedra(db, now);
  } catch (caught) {
    report.failed += 1;
    console.error("Úklid věder rate limitu selhal", {
      message: caught instanceof Error ? caught.message : String(caught),
    });
  }

  await recordCronRun("retention", report, report.failed === 0);

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

/**
 * Smaže osobní údaje ze záznamů starších než lhůta.
 *
 * Vjezdy a ohlášení se anonymizují (řádek zůstává), u detekcí se
 * nuluje adresa odesílatele. Sloupce, které přidávají ručně nasazované
 * migrace, chybět můžou: každý krok má vlastní try/catch, aby jeden
 * chybějící sloupec nezastavil zbytek.
 */
async function anonymizovat(
  db: ReturnType<typeof supabaseAdmin>,
  site: SiteRow,
  cutoff: Date,
  now: Date,
): Promise<{ passages: number; arrivals: number; ips: number }> {
  const out = { passages: 0, arrivals: 0, ips: 0 };

  // ── Vjezdy ─────────────────────────────────────────────────────
  // Nejdřív id, pak update podle nich: PostgREST neumí u zápisu limit
  // a jeden neomezený UPDATE by na dlouhé historii mohl uříznout běh.
  const { data: vjezdy, error: vjezdyError } = await db
    .from("vehicle_passages")
    .select("id")
    .eq("site_id", site.id)
    .lt("passed_at", cutoff.toISOString())
    .is("anonymized_at", null)
    .not("plate", "is", null)
    .limit(MAX_ANONYMIZE_PER_RUN)
    .returns<{ id: string }[]>();

  if (vjezdyError) {
    // Chybějící sloupec anonymized_at (migrace 20260913120000) není
    // důvod shodit celý úklid.
    console.warn("Vjezdy k anonymizaci se nenačetly", {
      site_id: site.id,
      message: vjezdyError.message,
    });
  } else if (vjezdy && vjezdy.length > 0) {
    const { error } = await db
      .from("vehicle_passages")
      .update(passageAnonymization(now))
      .in("id", vjezdy.map((row) => row.id));
    if (error) throw new Error(`anonymizace vjezdů: ${error.message}`);
    out.passages = vjezdy.length;
  }

  // ── Ohlášené příjezdy ──────────────────────────────────────────
  const { data: ohlaseni, error: ohlaseniError } = await db
    .from("announced_arrivals")
    .select("id")
    .eq("site_id", site.id)
    .lt("arrival_date", cutoffDateISO(cutoff))
    .is("anonymized_at", null)
    .not("plate", "is", null)
    .limit(MAX_ANONYMIZE_PER_RUN)
    .returns<{ id: string }[]>();

  if (ohlaseniError) {
    console.warn("Ohlášení k anonymizaci se nenačetla", {
      site_id: site.id,
      message: ohlaseniError.message,
    });
  } else if (ohlaseni && ohlaseni.length > 0) {
    const { error } = await db
      .from("announced_arrivals")
      .update(arrivalAnonymization(now))
      .in("id", ohlaseni.map((row) => row.id));
    if (error) throw new Error(`anonymizace ohlášení: ${error.message}`);
    out.arrivals = ohlaseni.length;
  }

  // ── Adresy odesílatelů u detekcí ───────────────────────────────
  // IP adresa je osobní údaj a u detekce starší než lhůta už nemá co
  // dokládat. Řádek i snímek zůstávají.
  const { data: detekce, error: detekceError } = await db
    .from("detections")
    .select("id")
    .eq("site_id", site.id)
    .lt("detected_at", cutoff.toISOString())
    .not("source_ip", "is", null)
    .limit(MAX_ANONYMIZE_PER_RUN)
    .returns<{ id: string }[]>();

  if (detekceError) {
    console.warn("Detekce k vyčištění adres se nenačetly", {
      site_id: site.id,
      message: detekceError.message,
    });
  } else if (detekce && detekce.length > 0) {
    const { error } = await db
      .from("detections")
      .update({ source_ip: null })
      .in("id", detekce.map((row) => row.id));
    if (error) throw new Error(`vyčištění adres: ${error.message}`);
    out.ips = detekce.length;
  }

  if (out.passages > 0 || out.arrivals > 0 || out.ips > 0) {
    console.info("Anonymizace po lhůtě", {
      site: site.name,
      ...out,
      starsi_nez: cutoff.toISOString(),
    });
  }

  return out;
}

/**
 * Smaže vědra rate limitu, do kterých se dlouho nesáhlo.
 *
 * Klíč vědra nese IP adresu nebo sériové číslo kamery, takže je to
 * tabulka osobních údajů, která rostla donekonečna. Hodina nečinnosti
 * je s rezervou víc, než kolik trvá doplnění i toho nejpomalejšího
 * vědra — mazáním se o žádnou ochranu nepřijde.
 */
async function uklizetVedra(
  db: ReturnType<typeof supabaseAdmin>,
  now: Date,
): Promise<number> {
  const hranice = new Date(
    now.getTime() - RATE_LIMIT_RETENTION_MINUTES * 60_000,
  ).toISOString();

  const { data, error } = await db
    .from("ingest_rate_limits")
    .delete()
    .lt("updated_at", hranice)
    .select("key")
    .returns<{ key: string }[]>();

  if (error) throw new Error(error.message);
  return data?.length ?? 0;
}
