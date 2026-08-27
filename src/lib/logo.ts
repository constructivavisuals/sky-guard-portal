// Adresa loga klienta.
//
// V databázi je jen cesta v bucketu; URL se skládá až tady. Bucket
// `loga` je veřejný (viz migrace 20260830180000), takže se nemusí
// podepisovat — jinak by postranní panel při každém načtení stránky
// volal Supabase kvůli podpisu.

/** Bucket, ve kterém loga leží. */
export const LOGO_BUCKET = "loga";

/**
 * Veřejná adresa loga, nebo null když klient logo nemá.
 *
 * Vrací null i tehdy, když chybí konfigurace — rozbitý `<img>` je
 * horší než žádné logo.
 */
export function logoUrl(logoPath: string | null | undefined): string | null {
  if (!logoPath) return null;

  const base = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!base) return null;

  const cesta = logoPath.replace(/^\/+/, "");
  return `${base.replace(/\/+$/, "")}/storage/v1/object/public/${LOGO_BUCKET}/${cesta}`;
}

/**
 * Přípona podle typu souboru. Bucket jiné typy nepřijme.
 *
 * SVG tu schválně NENÍ (migrace 20260911180000). Bucket `loga` je
 * veřejný, takže se soubor dá otevřít přímo, mimo portál — a SVG je
 * spustitelný dokument, ne obrázek: nese <script> a umí sáhnout na
 * cizí zdroje. Logo v PNG nebo WebP vypadá stejně.
 */
const PRIPONY: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

export function isSupportedLogoType(mimeType: string): boolean {
  return mimeType in PRIPONY;
}

/**
 * Cesta, pod kterou se logo uloží.
 *
 * Ve jméně je pořadové razítko, aby nová verze loga dostala novou
 * adresu — prohlížeč i CDN si ji jinak drží v cache a klient by po
 * výměně viděl staré logo.
 */
export function logoPathFor(
  profileId: string,
  mimeType: string,
  stamp: number,
): string | null {
  const pripona = PRIPONY[mimeType];
  if (!pripona) return null;
  return `${profileId}/${stamp}.${pripona}`;
}
