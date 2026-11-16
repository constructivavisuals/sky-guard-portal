import { PREVIEW_BUCKET, PREVIEW_CACHE_SEC } from "@/lib/cameras/preview.ts";
import { createClient } from "@/lib/supabase/server.ts";

// GET /api/kamery/<id>/nahled?v=<čas pořízení>
//
// Statický náhled kamery pro seznam /kamery.
//
// ═══ Proč ne podepsaná adresa rovnou do <img> ═════════════════════
// Tak to bylo, a telefon kvůli tomu stahoval všechny náhledy při
// každém otevření seznamu znovu. Podpis se mění s každým vykreslením
// stránky, takže pro prohlížeč je to pokaždé jiný obrázek a do cache
// se nikdy netrefí — i když je soubor týden stejný.
//
// Tahle adresa se mění jen s novým snímkem (`v` je čas pořízení),
// takže ji prohlížeč podá z cache a seznam má obrázky hned.
//
// ═══ Přístup ═══════════════════════════════════════════════════════
// Stejné pořadí jako /zivy a /api/media: kamera se dohledá POD RLS
// klientem přihlášeného uživatele a soubor se stáhne týmž klientem,
// takže rozhoduje i politika nad storage.objects. Kdo na lokalitu
// nevidí, dostane 404 — stejně jako na kameru, která neexistuje.
//
// `private`: obrázek smí uložit jen prohlížeč toho, kdo ho viděl,
// žádná sdílená cache po cestě.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function nenalezeno(): Response {
  return new Response(null, { status: 404, headers: { "cache-control": "no-store" } });
}

export async function GET(
  _request: Request,
  ctx: RouteContext<"/api/kamery/[id]/nahled">,
): Promise<Response> {
  const { id } = await ctx.params;
  const supabase = await createClient();

  const { data: camera, error } = await supabase
    .from("cameras")
    .select("preview_path")
    .eq("id", id)
    .maybeSingle<{ preview_path: string | null }>();

  if (error) {
    console.error("Dohledání náhledu kamery selhalo", { message: error.message });
    return new Response(null, { status: 500, headers: { "cache-control": "no-store" } });
  }
  if (!camera?.preview_path) return nenalezeno();

  const { data: soubor, error: chybaStazeni } = await supabase.storage
    .from(PREVIEW_BUCKET)
    .download(camera.preview_path);

  if (chybaStazeni || !soubor) return nenalezeno();

  return new Response(soubor.stream(), {
    headers: {
      "content-type": soubor.type || "image/jpeg",
      "content-length": String(soubor.size),
      "cache-control": `private, max-age=${PREVIEW_CACHE_SEC}`,
    },
  });
}
