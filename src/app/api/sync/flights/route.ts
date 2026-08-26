import { timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";

import { syncFlight, type FlightRow } from "@/lib/flights/sync.ts";
import { supabaseAdmin } from "@/lib/supabase-admin.ts";

// GET /api/sync/flights
//
// Dotažení letů z DJI FlightHubu. Volá se zvenčí cronem, stejně jako
// hlídky — viz README. Ověřuje se týmž CRON_SECRET.
//
// Bere lety, které mají úlohu a nemají konec. Dokončené dotáhne včetně
// trasy a médií, běžící jen aktualizuje stav a nechá na příště.
//
// Selhání jednoho letu NESMÍ shodit ostatní: každý má vlastní
// try/catch a chyby se sbírají do souhrnu.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Stahování médií je pomalé a je jich víc na let.
export const maxDuration = 300;

/**
 * Kolik letů se zpracuje v jednom běhu.
 *
 * Strop je tu proto, že běh má konečný čas; co se nevejde, vezme
 * další. Vypisuje se do odpovědi — tiché useknutí by vypadalo jako
 * „nic dalšího nebylo“.
 */
const MAX_FLIGHTS_PER_RUN = 10;

function authorized(request: NextRequest): boolean {
  const expected = process.env.CRON_SECRET;
  // Bez nastaveného tajemství se endpoint nespustí vůbec.
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

  const { data: flights, error } = await db
    .from("flights")
    .select("id, site_id, fh_task_uuid, status")
    .not("fh_task_uuid", "is", null)
    .is("ended_at", null)
    // Nejdřív ty, které se nikdy netahaly, pak nejstarší pokusy —
    // jinak by jeden zaseklý let ukrajoval strop v každém běhu.
    .order("synced_at", { ascending: true, nullsFirst: true })
    .limit(MAX_FLIGHTS_PER_RUN)
    .returns<FlightRow[]>();

  if (error) {
    console.error("Načtení letů k synchronizaci selhalo", { message: error.message });
    return Response.json({ error: "flights_query_failed" }, { status: 500 });
  }

  const report = {
    checked: flights?.length ?? 0,
    finished: 0,
    running: 0,
    failed: 0,
    mediaAdded: 0,
    mediaSkipped: 0,
    truncated: (flights?.length ?? 0) === MAX_FLIGHTS_PER_RUN,
  };

  for (const flight of flights ?? []) {
    try {
      const result = await syncFlight(db, flight);

      report.mediaAdded += result.mediaAdded;
      report.mediaSkipped += result.mediaSkipped;

      if (result.problems.length > 0) {
        report.failed += 1;
        console.warn("Let se nepodařilo dotáhnout celý", {
          flight_id: flight.id,
          fh_status: result.fhStatus,
          problemy: result.problems,
        });
      }

      if (result.finished) report.finished += 1;
      else if (result.problems.length === 0) report.running += 1;
    } catch (caught) {
      // Sem se dostane jen selhání databáze. Ostatní lety musí doběhnout.
      report.failed += 1;
      console.error("Synchronizace letu selhala", {
        flight_id: flight.id,
        message: caught instanceof Error ? caught.message : String(caught),
      });
    }
  }

  // Nenulové failed musí být vidět ve stavu — cron volá někdo zvenčí
  // přes `curl -f` a ten upozorní jen na chybový stav. Stejně jako
  // u hlídek.
  return Response.json(report, { status: report.failed > 0 ? 500 : 200 });
}
