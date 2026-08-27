import type { NextRequest } from "next/server";

import { relaySecrets } from "@/lib/env.ts";
import { clientIp } from "@/lib/ingest/rate-limit.ts";
import { publicFailureReason } from "@/lib/ingest/signature.ts";
import { verifyRelay } from "@/lib/ingest/verify-relay.ts";
import { supabaseAdmin } from "@/lib/supabase-admin.ts";

// GET /api/relay/cameras
//
// Konfigurace pro relay: které kamery na VPS obsluhuje a na jaké
// adrese je najde. Stahuje si to služba událostí, a až bude, i
// generátor konfigurace go2rtc.
//
// ═══ Proč se to netahá z konfiguráku na VPS ════════════════════════
// Kamera se zakládá v portálu — tam ji člověk vidí, tam se jí mění
// jméno a tam se pozná, že tři dny mlčí. Druhý seznam na VPS by se
// rozešel při první kameře, kterou někdo přejmenuje nebo přepne na
// jinou IP, a rozešel by se tiše: služba by dál poslouchala adresu,
// na které už nikdo není.
//
// ═══ Co tu NENÍ ════════════════════════════════════════════════════
// Hesla ke kamerám. Portál je nezná a znát nemá — relay si je bere
// z vlastního prostředí. Kdyby chodila odsud, znamenala by kompromitace
// portálu i přístup do vnitřní sítě každé stavby.
//
// Podpis: `${timestamp}.` a prázdné tělo, tedy stejný vzor jako
// u ohlášení záznamu. GET schválně — je to čtení a nic to nemění.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface CameraRow {
  serial_number: string | null;
  name: string;
  lan_ip: string | null;
  rtsp_main_path: string | null;
  rtsp_sub_path: string | null;
  sites: { id: string; name: string; timezone: string } | null;
}

function jsonError(status: number, error: string, detail?: unknown) {
  return Response.json(
    detail === undefined ? { error } : { error, detail },
    { status },
  );
}

export async function GET(request: NextRequest): Promise<Response> {
  const receivedAt = new Date();
  const ip = clientIp(request.headers);

  let secrets: string[];
  try {
    secrets = relaySecrets();
  } catch {
    console.error("RELAY_SECRET není nastavený");
    return jsonError(500, "server_misconfigured");
  }

  const check = verifyRelay({
    rawBody: "",
    signature: request.headers.get("x-signature"),
    timestamp: request.headers.get("x-timestamp"),
    now: receivedAt,
    secrets,
  });

  if (!check.valid) {
    console.warn("Konfigurace relaye odmítnuta: podpis neprošel", {
      ip,
      duvod: check.reason,
    });
    return jsonError(401, "unauthorized", publicFailureReason(check.reason) ?? undefined);
  }

  if (check.usedPrevious) {
    console.warn("Relay jede na PŘEDCHOZÍM tajemství — čeká na přepnutí", { ip });
  }

  const db = supabaseAdmin();
  const { data, error } = await db
    .from("cameras")
    .select(
      "serial_number, name, lan_ip, rtsp_main_path, rtsp_sub_path, " +
        "sites(id, name, timezone)",
    )
    .eq("ingest_mode", "ftp")
    .order("name")
    .returns<CameraRow[]>();

  if (error) {
    console.error("Načtení kamer pro relay selhalo", { message: error.message });
    return jsonError(500, "lookup_failed");
  }

  // Kamera bez sériového čísla nebo bez adresy se vynechá: relay by ji
  // neměl jak najít ani pojmenovat. Počet se loguje, aby bylo poznat
  // „žádné kamery“ od „všechny nedodělané“ — na místě je to rozdíl mezi
  // klidem a hledáním v konfiguráku.
  const cameras = (data ?? []).filter(
    (row) => row.serial_number && row.lan_ip && row.sites,
  );
  const vynechano = (data ?? []).length - cameras.length;
  if (vynechano > 0) {
    console.warn("Relay dostane neúplný seznam kamer", {
      vynechano,
      celkem: (data ?? []).length,
    });
  }

  return Response.json({
    cameras: cameras.map((row) => ({
      serial_number: row.serial_number,
      name: row.name,
      site_id: row.sites!.id,
      site_name: row.sites!.name,
      lan_ip: row.lan_ip,
      rtsp_main_path: row.rtsp_main_path,
      rtsp_sub_path: row.rtsp_sub_path,
    })),
    incomplete: vynechano,
  });
}
