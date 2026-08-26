// Snímek v těle ingest požadavku.
//
// Jedna sada pravidel pro vjezdy i detekce. Dřív byla jen u vjezdů
// a detekce snímek nepřijímaly vůbec; opsat ji podruhé by znamenalo, že
// se ty dvě cesty jednou rozejdou v tom, co je ještě platný obrázek.

/** Snímek od kamery. Větší se odmítá dřív, než se vůbec čte tělo. */
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

export const POVOLENE_TYPY = new Set(["image/jpeg", "image/png", "image/webp"]);

export interface IngestImage {
  /** base64 bez prefixu data:. */
  base64: string;
  mediaType: string;
}

/**
 * Odhadne velikost dat zakódovaných v base64.
 *
 * Počítá se z délky řetězce, ne dekódováním — dekódovat dvoumegový
 * řetězec jen proto, abychom zjistili, že je moc velký, je přesně to,
 * čemu má strop zabránit.
 */
export function base64ByteLength(value: string): number {
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return Math.floor((value.length * 3) / 4) - padding;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Přečte volitelný snímek z těla. Chyby přidává do `errors`, aby se
 * volajícímu vrátily všechny naráz.
 */
export function parseIngestImage(
  value: unknown,
  errors: string[],
): IngestImage | null {
  if (value === undefined || value === null) return null;

  if (!isPlainObject(value)) {
    errors.push("image musí být objekt");
    return null;
  }

  const mediaType = String(value.media_type ?? "").toLowerCase();
  const data = value.data;

  if (!POVOLENE_TYPY.has(mediaType)) {
    errors.push(`image.media_type musí být jeden z: ${[...POVOLENE_TYPY].join(", ")}`);
    return null;
  }
  if (typeof data !== "string" || data.length === 0) {
    errors.push("image.data musí být base64 řetězec");
    return null;
  }
  // Přísně: prefix data: ani zalomené řádky nepřijímáme, aby se
  // dekódování nechovalo jinak, než co změřil strop výš.
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data)) {
    errors.push("image.data není čistý base64 (bez prefixu a zalomení)");
    return null;
  }
  if (base64ByteLength(data) > MAX_IMAGE_BYTES) {
    errors.push(`snímek je větší než ${MAX_IMAGE_BYTES} B`);
    return null;
  }

  return { base64: data, mediaType };
}

const PRIPONY: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

/**
 * Cesta, pod kterou se snímek uloží: `<lokalita>/<id>.<přípona>`.
 *
 * První složka je UUID lokality, takže politika nad storage.objects
 * může pustit čtení toutéž funkcí jako u řádků.
 *
 * Vrací null u typu, který bucket stejně nepřijme — ať se chyba projeví
 * tady, ne až odmítnutím z úložiště.
 */
export function ingestImagePath(
  siteId: string,
  id: string,
  mediaType: string,
): string | null {
  const pripona = PRIPONY[mediaType];
  if (!pripona) return null;
  return `${siteId}/${id}.${pripona}`;
}
