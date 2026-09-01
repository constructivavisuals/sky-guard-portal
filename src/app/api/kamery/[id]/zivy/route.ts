import type { NextRequest } from "next/server";

import { liveStreamConfig } from "@/lib/env.ts";
import { issueLiveToken } from "@/lib/live/token.ts";
import { isStreamQuality, liveSocketUrl, streamName } from "@/lib/live/stream.ts";
import { createClient } from "@/lib/supabase/server.ts";

// GET /api/kamery/<id>/zivy?kvalita=sub|main
//
// Lístek na živý obraz jedné kamery.
//
// ═══ Kvalita se vybírá, výchozí je hlavní proud ════════════════════
// Neznámá nebo chybějící hodnota padá na výchozí, ne na chybu:
// uložený odkaz se nemá rozbít kvůli překlepu v parametru.
//
// ═══ Proč to nejde přes portál ═════════════════════════════════════
// Serverless funkce neudrží minutové spojení a video by teklo přes
// Vercel — u devíti kamer v HD je to řádově jiná faktura než přenos
// z relaye, který stojí v témže datacentru. Prohlížeč se proto
// připojuje PŘÍMO na relay.
//
// ═══ Pak ale musí někdo rozhodnout o přístupu ══════════════════════
// Relay o přihlášených uživatelích nic neví. Pořadí je proto stejné
// jako u /api/media a nesmí se prohodit:
//
//   1. kamera se dohledá POD RLS, klientem přihlášeného uživatele
//   2. teprve pak se vydá lístek, a jen na TU kameru
//   3. relay lístek ověří a pustí proud
//
// Kdo na lokalitu nevidí, dostane 404 — stejnou odpověď jako na kameru,
// která neexistuje. Uhodnutým UUID se tedy nedá zjistit ani to, jestli
// kamera je.
//
// ═══ Co se nevrací ═════════════════════════════════════════════════
// Adresa kamery v LAN ani heslo. Prohlížeč dostane jméno proudu
// a lístek; kde ta kamera fyzicky je, zůstává na relayi.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface CameraRow {
  id: string;
  name: string;
  serial_number: string | null;
  ingest_mode: "http" | "ftp";
}

function jsonError(status: number, error: string) {
  return Response.json({ error }, { status, headers: { "cache-control": "no-store" } });
}

export async function GET(
  request: NextRequest,
  ctx: RouteContext<"/api/kamery/[id]/zivy">,
): Promise<Response> {
  const { id } = await ctx.params;

  const kvalitaRaw = request.nextUrl.searchParams.get("kvalita");
  const kvalita = isStreamQuality(kvalitaRaw) ? kvalitaRaw : "main";

  let config;
  try {
    config = liveStreamConfig();
  } catch (caught) {
    console.error("Živý obraz není nastavený", {
      message: caught instanceof Error ? caught.message : String(caught),
    });
    return jsonError(503, "live_not_configured");
  }

  const supabase = await createClient();

  // Klient PŘIHLÁŠENÉHO uživatele, ne service role. Tady se rozhoduje
  // o přístupu — service role by RLS obešla a brána by nic nehlídala.
  const { data: camera, error } = await supabase
    .from("cameras")
    .select("id, name, serial_number, ingest_mode")
    .eq("id", id)
    .maybeSingle<CameraRow>();

  if (error) {
    console.error("Dohledání kamery pro živý obraz selhalo", { message: error.message });
    return jsonError(500, "lookup_failed");
  }

  // Neexistuje NEBO na ni uživatel nevidí — jedna odpověď na obojí.
  if (!camera) return jsonError(404, "not_found");

  if (!camera.serial_number) {
    // Bez sériového čísla ji relay nemá jak pojmenovat. Je to nedodělaná
    // kamera, ne chyba volajícího.
    return jsonError(409, "camera_without_serial");
  }

  const stream = streamName(camera.serial_number, kvalita);
  const { token, expiresIn } = issueLiveToken({ stream, secret: config.secret });

  console.info("Vydán lístek na živý obraz", {
    camera_id: camera.id,
    stream,
  });

  return Response.json(
    {
      stream,
      quality: kvalita,
      url: liveSocketUrl({ baseUrl: config.baseUrl, stream, token }),
      expires_in: expiresIn,
    },
    { headers: { "cache-control": "no-store" } },
  );
}
