// Úložiště záznamů ze stavebních kamer.
//
// Bucket je privátní: na záznamu ze stavby jsou lidé při práci a cizí
// pozemek. Adresa se podepisuje a podpis platí krátce. První složka
// v cestě je UUID lokality, takže politika nad storage.objects pouští
// čtení toutéž funkcí jako u řádků — viz migrace 20260915180000.

export const RECORDING_BUCKET = "zaznamy";

/**
 * Jak dlouho platí podepsaná adresa záznamu.
 *
 * Delší než u snímků (300 s), kratší než u médií z letů (600 s):
 * záznam se přehrává, ne prohlíží, a minutové video se za deset minut
 * stihne pustit i na špatném připojení.
 */
export const RECORDING_SIGNED_URL_TTL = 600;

/**
 * Jak dlouho platí JEDNORÁZOVÁ nahrávací adresa pro relay.
 *
 * Supabase je vystavuje na dvě hodiny; kratší dobu si neurčíme, tak
 * aspoň víme, s čím počítat. Relay soubor pošle hned — když to trvá
 * déle, něco je špatně a lepší je nechat pokus vypršet a zopakovat ho
 * než čekat.
 */
export const UPLOAD_URL_TTL_SECONDS = 2 * 60 * 60;

/** Přípony, které umíme přijmout. Musí sedět s bucketem. */
const PRIPONY: Record<string, string> = {
  "video/mp4": "mp4",
  "video/quicktime": "mov",
};

export function isSupportedRecordingType(mediaType: string): boolean {
  return mediaType in PRIPONY;
}

/**
 * Cesta, pod kterou záznam leží.
 *
 * `<lokalita>/<kamera>/RRRR/MM/DD/HHMMSS-<událost>.<přípona>`
 *
 * Lokalita je první schválně: na ní stojí čtecí politika. Kamera druhá,
 * aby šlo v úložišti projít jedno zařízení. Datum ve složkách, ať se
 * v bucketu dá orientovat i bez databáze.
 *
 * Vrací null u nepodporovaného typu — soubor se pak nenahraje vůbec,
 * což je lepší než ho uložit pod příponou, kterou bucket odmítne.
 */
export function recordingPath(options: {
  siteId: string;
  cameraId: string;
  startedAt: Date;
  eventType: string | null;
  mediaType: string;
}): string | null {
  const pripona = PRIPONY[options.mediaType];
  if (!pripona) return null;

  const { startedAt } = options;
  if (Number.isNaN(startedAt.getTime())) return null;

  // UTC, ne místní čas: cesta se skládá na serveru i v relayi a musí
  // vyjít stejně. Místní den je věc zobrazení, ne uložení.
  const rok = startedAt.getUTCFullYear();
  const mesic = String(startedAt.getUTCMonth() + 1).padStart(2, "0");
  const den = String(startedAt.getUTCDate()).padStart(2, "0");
  const cas =
    String(startedAt.getUTCHours()).padStart(2, "0") +
    String(startedAt.getUTCMinutes()).padStart(2, "0") +
    String(startedAt.getUTCSeconds()).padStart(2, "0");

  // Typ události jde do názvu, ať se v bucketu pozná pohyb od pravidelné
  // nahrávky. Čistí se přísně: do cesty nesmí lomítko ani tečka.
  const udalost = (options.eventType ?? "unknown")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 20);

  return `${options.siteId}/${options.cameraId}/${rok}/${mesic}/${den}/${cas}-${udalost || "unknown"}.${pripona}`;
}

/**
 * Je záznam přehratelný?
 *
 * Tři různé „ne“, které se nesmí slít: soubor ještě nedorazil, video
 * po lhůtě smazané, a záznam bez cesty (starší import). UI z toho
 * potřebuje vědět, kterou větu napsat.
 */
export type RecordingPlayback = "ready" | "pending" | "expired" | "missing";

export function recordingPlayback(row: {
  storage_path: string | null;
  uploaded_at: string | null;
  video_expired_at: string | null;
}): RecordingPlayback {
  if (row.video_expired_at) return "expired";
  if (!row.storage_path) return "missing";
  if (!row.uploaded_at) return "pending";
  return "ready";
}
