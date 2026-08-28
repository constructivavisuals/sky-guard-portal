import type { NextRequest } from "next/server";

import { hetznerStorageConfig } from "@/lib/env.ts";
import {
  RECORDING_BUCKET,
  RECORDING_SIGNED_URL_TTL,
  isRecordingBackend,
  recordingPlayback,
} from "@/lib/recordings/storage.ts";
import { presignUrl } from "@/lib/storage/s3.ts";
import { createClient } from "@/lib/supabase/server.ts";

// GET /api/media/<druh>/<cesta v úložišti>
//
// Autorizační brána před soubory, které leží mimo Supabase.
//
// ═══ Proč to vůbec musí být ════════════════════════════════════════
// U Supabase Storage rozhodovala o přístupu politika nad
// `storage.objects`: portál podepsal adresu klientem přihlášeného
// uživatele a když na lokalitu neviděl, podpis nedostal. Hetzner žádnou
// RLS nezná — jeden klíč platí na celý bucket. Kdyby portál podepisoval
// rovnou, stačilo by cestu uhodnout.
//
// Pořadí je proto obrácené a nesmí se prohodit:
//
//   1. prefix v cestě určí TABULKU
//   2. existence řádku se ověří POD RLS, klientem uživatele
//   3. teprve pak se podepíše adresa, klíčem portálu
//
// Vlastnit cestu tedy nestačí. Krok 2 je celá ochrana: řádek, na který
// uživatel nevidí, RLS nevrátí a odpověď je 404 — stejná jako u cesty,
// která neexistuje. Kdo nemá přístup, nepozná ani to, jestli soubor je.
//
// ═══ Proč přesměrování, a ne proxy ═════════════════════════════════
// Minutový úsek z kamery má desítky MB a serverless funkce nemá téct
// videem. Přesměrování si přebere prohlížeč sám včetně Range requestů,
// takže přetáčení funguje a portál platí jen za jedno ověření.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Prefix → co se pod ním ověřuje.
 *
 * Přidat další druh je jeden řádek. Tabulka je součást bezpečnostní
 * úvahy: co v ní není, to se nepodepíše — neznámý prefix končí 404,
 * ne pokusem uhodnout tabulku z cesty.
 */
const DRUHY = {
  zaznamy: {
    table: "camera_recordings",
    columns: "id, storage_path, uploaded_at, video_expired_at, storage_backend",
  },
} as const;

type Druh = keyof typeof DRUHY;

interface RecordingRow {
  id: string;
  storage_path: string | null;
  uploaded_at: string | null;
  video_expired_at: string | null;
  storage_backend: string | null;
}

function jsonError(status: number, error: string) {
  return Response.json({ error }, { status, headers: { "cache-control": "no-store" } });
}

export async function GET(
  _request: NextRequest,
  ctx: RouteContext<"/api/media/[...cesta]">,
): Promise<Response> {
  const { cesta } = await ctx.params;
  const segmenty = cesta ?? [];

  if (segmenty.length < 2) return jsonError(404, "not_found");

  const [prefix, ...zbytek] = segmenty;
  if (!(prefix in DRUHY)) return jsonError(404, "not_found");
  const druh = DRUHY[prefix as Druh];

  // Segmenty chodí z Next.js už dekódované. Skládají se zpátky lomítky,
  // protože v databázi je cesta uložená jako jeden řetězec.
  const storagePath = zbytek.join("/");

  // Pojistka proti tomu, aby se do dotazu dostalo něco, co cesta být
  // nemůže. Shoda se stejně dělá na přesnou rovnost s řádkem v databázi,
  // takže traverzem se nikam dostat nedá — tohle je druhý zámek.
  if (!storagePath || storagePath.includes("..") || storagePath.startsWith("/")) {
    return jsonError(404, "not_found");
  }

  const supabase = await createClient();

  // Klient PŘIHLÁŠENÉHO uživatele, ne service role. Tady se rozhoduje
  // o přístupu — service role by RLS obešla a brána by nic nehlídala.
  const { data: row, error } = await supabase
    .from(druh.table)
    .select(druh.columns)
    .eq("storage_path", storagePath)
    .maybeSingle<RecordingRow>();

  if (error) {
    console.error("Ověření přístupu k souboru selhalo", {
      prefix,
      message: error.message,
    });
    return jsonError(500, "lookup_failed");
  }

  // Neexistuje NEBO na něj uživatel nevidí — jedna odpověď na obojí.
  if (!row) return jsonError(404, "not_found");

  const stav = recordingPlayback(row);
  if (stav === "expired") return jsonError(410, "expired");
  if (stav !== "ready") return jsonError(409, stav);

  const backend = isRecordingBackend(row.storage_backend)
    ? row.storage_backend
    : "supabase";

  let url: string;

  if (backend === "hetzner") {
    let cfg;
    try {
      cfg = hetznerStorageConfig();
    } catch (caught) {
      console.error("Hetzner není nastavený", {
        message: caught instanceof Error ? caught.message : String(caught),
      });
      return jsonError(500, "server_misconfigured");
    }
    url = presignUrl(cfg, {
      method: "GET",
      key: storagePath,
      expiresIn: RECORDING_SIGNED_URL_TTL,
    });
  } else {
    // Záznam z doby před přechodem. Podepisuje se pořád klientem
    // uživatele, takže i tady rozhoduje politika nad storage.objects.
    const { data, error: signError } = await supabase.storage
      .from(RECORDING_BUCKET)
      .createSignedUrl(storagePath, RECORDING_SIGNED_URL_TTL);

    if (signError || !data?.signedUrl) {
      console.error("Podepsání adresy v Supabase selhalo", {
        storage_path: storagePath,
        message: signError?.message,
      });
      return jsonError(500, "sign_failed");
    }
    url = data.signedUrl;
  }

  // Krátké a soukromé: adresa je podepsaná na jednoho uživatele a za
  // pár minut propadne. Kdyby ji zachytila sdílená cache, dostal by ji
  // i ten, kdo na lokalitu nevidí.
  return new Response(null, {
    status: 302,
    headers: {
      location: url,
      "cache-control": "private, no-store",
    },
  });
}
