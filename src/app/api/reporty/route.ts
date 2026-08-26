import sharp from "sharp";
import type { NextRequest } from "next/server";

import { FLIGHT_BUCKET } from "@/lib/flights/storage.ts";
import { LOGO_BUCKET } from "@/lib/logo.ts";
import { currentMonth, loadMonthlyReport, parseMonth } from "@/lib/reports/data.ts";
import { buildMonthlyReportPdf, THUMB_W } from "@/lib/reports/pdf.ts";
import { getCurrentProfile } from "@/lib/current-profile.ts";
import { isAdmin } from "@/lib/profile.ts";
import { createClient } from "@/lib/supabase/server.ts";

// GET /api/reporty?lokalita=<uuid>&mesic=YYYY-MM
//
// Měsíční report jako PDF. Čte se klientem přihlášeného uživatele,
// takže rozsah určuje RLS: klient dostane svou lokalitu, admin
// kteroukoli. Neexistující i nedostupná lokalita končí stejně — 404.
//
// Provozní část se přidává jen adminovi. Není to bezpečnostní hranice
// v tom smyslu jako RLS (data v ní nejsou citlivá), ale klienta
// nezajímá, kolikrát neběžel cron.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Snímky se stahují z úložiště a zmenšují; s deseti nálezy to trvá.
export const maxDuration = 60;

/** Nad tímhle se snímek do reportu nedává vůbec — ani zmenšovat. */
const MAX_SOURCE_BYTES = 12 * 1024 * 1024;

export async function GET(request: NextRequest): Promise<Response> {
  const supabase = await createClient();
  const profile = await getCurrentProfile();

  if (!profile) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const siteId = request.nextUrl.searchParams.get("lokalita");
  if (!siteId) {
    return Response.json({ error: "missing_site" }, { status: 400 });
  }

  // Lokalita se čte pod session uživatele — RLS je tu ta kontrola
  // přístupu. Kdo na ni nevidí, dostane prázdno a z něj 404.
  const { data: site } = await supabase
    .from("sites")
    .select("id, name, timezone")
    .eq("id", siteId)
    .maybeSingle<{ id: string; name: string; timezone: string }>();

  if (!site) {
    return Response.json({ error: "not_found" }, { status: 404 });
  }

  const month =
    parseMonth(request.nextUrl.searchParams.get("mesic")) ??
    currentMonth(site.timezone);

  const admin = isAdmin(profile);

  try {
    const report = await loadMonthlyReport(supabase, {
      site,
      month,
      includeOperations: admin,
    });

    const [logo, threats] = await Promise.all([
      report.client.logoPath
        ? nacistObrazek(supabase, LOGO_BUCKET, report.client.logoPath, { jpeg: false })
        : Promise.resolve(null),
      Promise.all(
        report.threats.map((threat) =>
          threat.storagePath
            ? nacistObrazek(supabase, FLIGHT_BUCKET, threat.storagePath, { jpeg: true })
            : Promise.resolve(null),
        ),
      ),
    ]);

    const pdf = await buildMonthlyReportPdf(report, { logo, threats });

    const nazev = `sky-guard-${site.name}-${month}.pdf`
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-zA-Z0-9.-]+/g, "-")
      .toLowerCase();

    return new Response(new Uint8Array(pdf), {
      headers: {
        "content-type": "application/pdf",
        // inline: prohlížeč ho ukáže a stáhnout jde pořád.
        "content-disposition": `inline; filename="${nazev}"`,
        // Report je pohled na živá data, ne artefakt. Cachovat ho
        // znamená posílat klientovi včerejší čísla.
        "cache-control": "private, no-store",
      },
    });
  } catch (error) {
    console.error("Sestavení reportu selhalo", {
      site_id: site.id,
      month,
      message: error instanceof Error ? error.message : String(error),
    });
    return Response.json({ error: "report_failed" }, { status: 500 });
  }
}

/**
 * Snímek z úložiště zmenšený na náhled.
 *
 * Vrací null, když se to nepovede — report kvůli jednomu chybějícímu
 * snímku nepadá. Zmenšení je podstatné: fotka z dronu má klidně šest
 * megabajtů a report by se nedal poslat mailem.
 */
async function nacistObrazek(
  supabase: Awaited<ReturnType<typeof createClient>>,
  bucket: string,
  cesta: string,
  options: { jpeg: boolean },
): Promise<Uint8Array | null> {
  try {
    const { data, error } = await supabase.storage.from(bucket).download(cesta);
    if (error || !data) return null;

    const raw = Buffer.from(await data.arrayBuffer());
    if (raw.byteLength > MAX_SOURCE_BYTES) {
      console.info("Snímek do reportu je moc velký, vynechávám", {
        cesta,
        bytes: raw.byteLength,
      });
      return null;
    }

    // Logo se nechává v PNG kvůli průhlednosti; fotky jdou do JPEG,
    // který pdf-lib vloží beze změny.
    const zmenseny = sharp(raw).resize({ width: THUMB_W, withoutEnlargement: true });
    const out = options.jpeg
      ? await zmenseny.jpeg({ quality: 72 }).toBuffer()
      : await zmenseny.png({ compressionLevel: 9 }).toBuffer();

    return new Uint8Array(out);
  } catch (error) {
    console.warn("Snímek do reportu se nepodařilo připravit", {
      cesta,
      message: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
