import type { NextRequest } from "next/server";

import { liveStreamConfig } from "@/lib/env.ts";
import { issueLiveToken } from "@/lib/live/token.ts";
import {
  PLAYBACK_REACH_DAYS,
  playbackSocketUrl,
  playbackStreamName,
} from "@/lib/live/stream.ts";
import { createClient } from "@/lib/supabase/server.ts";

// GET /api/kamery/<id>/zaznam?od=<ISO čas>
//
// Lístek na přehrávání ze SD karty kamery, od daného okamžiku.
//
// ═══ Proč vůbec ════════════════════════════════════════════════════
// Průběžný archiv nikam neodchází — leží na kartě v kameře a přepisuje
// se dokola. Klient se tedy dívá týden zpátky PŘÍMO z ní, přes RTSP
// playback. Do Hetzneru jde jen klip kolem detekce jako důkaz.
//
// ═══ Lístek platí na JEDEN okamžik ═════════════════════════════════
// Čas je součástí jména proudu (`<sériové>-pb-<epocha>`) a jméno se
// podepisuje. Lístek na 14:00 tedy neotevře 3:00 — je to jiné jméno
// a podpis nesedí. Kdyby čas šel vedle jako parametr, otevřel by
// jeden lístek celý týden.
//
// Každý posun na časové ose je proto nový požadavek sem. To není
// režie navíc: posun stejně znamená nové spojení na kameru, protože
// go2rtc pojem času nemá a proud se otevírá od konkrétního okamžiku.
//
// ═══ Pořadí se nesmí prohodit ══════════════════════════════════════
// Stejně jako u živého obrazu: kamera se dohledá POD RLS klientem
// přihlášeného uživatele a teprve pak se vydá lístek. Kdo na lokalitu
// nevidí, dostane 404 — stejnou odpověď jako na kameru, která
// neexistuje.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface CameraRow {
  id: string;
  name: string;
  serial_number: string | null;
}

function jsonError(status: number, error: string, detail?: unknown) {
  return Response.json(
    detail === undefined ? { error } : { error, detail },
    { status, headers: { "cache-control": "no-store" } },
  );
}

export async function GET(
  request: NextRequest,
  ctx: RouteContext<"/api/kamery/[id]/zaznam">,
): Promise<Response> {
  const { id } = await ctx.params;

  const odRaw = request.nextUrl.searchParams.get("od");
  if (!odRaw) return jsonError(400, "missing_od");

  const od = new Date(odRaw);
  if (Number.isNaN(od.getTime())) return jsonError(400, "bad_od");

  const ted = Date.now();

  // Budoucnost karta nemá. Malá rezerva na rozjeté hodiny prohlížeče:
  // odmítnout požadavek kvůli deseti vteřinám by vypadalo jako závada.
  if (od.getTime() > ted + 60_000) return jsonError(400, "od_in_future");

  // Dál, než sahá karta, nemá smysl otevírat: kamera by na to
  // neodpověděla a divák by koukal na věčné „připojuje se“.
  const dosahMs = PLAYBACK_REACH_DAYS * 24 * 60 * 60 * 1000;
  if (od.getTime() < ted - dosahMs) {
    return jsonError(410, "beyond_card_reach", { reach_days: PLAYBACK_REACH_DAYS });
  }

  let config;
  try {
    config = liveStreamConfig();
  } catch (caught) {
    console.error("Přehrávání ze záznamu není nastavené", {
      message: caught instanceof Error ? caught.message : String(caught),
    });
    return jsonError(503, "live_not_configured");
  }

  const supabase = await createClient();

  // Klient PŘIHLÁŠENÉHO uživatele, ne service role — tady se rozhoduje
  // o přístupu a service role by RLS obešla.
  const { data: camera, error } = await supabase
    .from("cameras")
    .select("id, name, serial_number")
    .eq("id", id)
    .maybeSingle<CameraRow>();

  if (error) {
    console.error("Dohledání kamery pro přehrávání selhalo", {
      message: error.message,
    });
    return jsonError(500, "lookup_failed");
  }

  if (!camera) return jsonError(404, "not_found");
  if (!camera.serial_number) return jsonError(409, "camera_without_serial");

  // Epocha v SEKUNDÁCH a v UTC. Na místní čas kamery ji převádí relay;
  // portál o zóně kamery nic neví a vědět nemá.
  const odSekundy = Math.floor(od.getTime() / 1000);
  const stream = playbackStreamName(camera.serial_number, odSekundy);
  const { token, expiresIn } = issueLiveToken({ stream, secret: config.secret });

  console.info("Vydán lístek na přehrávání ze záznamu", {
    camera_id: camera.id,
    stream,
  });

  return Response.json(
    {
      stream,
      from: new Date(odSekundy * 1000).toISOString(),
      url: playbackSocketUrl({ baseUrl: config.baseUrl, stream, token }),
      expires_in: expiresIn,
      reach_days: PLAYBACK_REACH_DAYS,
    },
    { headers: { "cache-control": "no-store" } },
  );
}
