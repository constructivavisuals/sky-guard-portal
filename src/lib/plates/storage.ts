// Úložiště snímků od brány.
//
// Bucket je privátní: na snímku je cizí vozidlo, poznávací značka
// a kolikrát i řidič. Adresa se podepisuje a podpis platí krátce.
//
// První složka v cestě je UUID lokality, takže politika nad
// storage.objects může pustit čtení toutéž funkcí jako u řádků
// (site_is_visible) — viz migrace 20260901120000.

export const PASSAGE_BUCKET = "vjezdy";

const PRIPONY: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

/** Jak dlouho platí podepsaná adresa snímku. */
export const SIGNED_URL_TTL_SECONDS = 300;

/**
 * Cesta, pod kterou se snímek uloží: `<lokalita>/<vjezd>.<přípona>`.
 *
 * Vrací null u typu, který bucket stejně nepřijme — ať se chyba
 * projeví tady, ne až odmítnutím z úložiště.
 */
export function passageImagePath(
  siteId: string,
  passageId: string,
  mediaType: string,
): string | null {
  const pripona = PRIPONY[mediaType];
  if (!pripona) return null;
  return `${siteId}/${passageId}.${pripona}`;
}
