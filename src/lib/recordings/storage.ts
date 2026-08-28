// Úložiště záznamů ze stavebních kamer.
//
// ═══ Video leží v HETZNERU, ne v Supabase ══════════════════════════
// Devět kamer nahrává nepřetržitě, zhruba 300 GB denně; týden zpětně
// jsou přes 2 TB a to Supabase Storage nezaplatí. Snímky detekcí
// a vjezdů zůstávají tam, kde byly — jsou malé a autorizace nad nimi
// stojí na RLS, kterou cizí S3 nemá.
//
// ═══ Čím se autorizace nahradila ═══════════════════════════════════
// U Supabase pouštěla čtení politika nad `storage.objects`. Hetzner
// žádnou RLS nezná: klíč platí na celý bucket. Adresa se proto
// podepisuje AŽ po tom, co se pod RLS ověří, že přihlášený uživatel
// na ten konkrétní řádek vidí — viz /api/media. Prefix v cestě určí
// tabulku, existence řádku rozhodne, teprve pak se podepisuje.
//
// Vlastnit cestu tedy nestačí; kdo na lokalitu nevidí, dostane 404
// i na cestu, kterou uhodl.
/**
 * Starý bucket v Supabase Storage.
 *
 * Nové záznamy sem už nejdou, ale ty nahrané před přechodem tu leží
 * dál a musí zůstat přehratelné — proto se nesmaže ani konstanta, ani
 * bucket. Kam který záznam patří, říká `camera_recordings
 * .storage_backend`.
 */
import { RECORDING_BACKENDS, type RecordingBackend } from "../../types/database.ts";

export const RECORDING_BUCKET = "zaznamy";

/** Kam se ukládají nové záznamy. */
export const DEFAULT_RECORDING_BACKEND: RecordingBackend = "hetzner";

export function isRecordingBackend(value: unknown): value is RecordingBackend {
  return (RECORDING_BACKENDS as readonly string[]).includes(value as string);
}

/**
 * Výchozí strop na objem videa jedné lokality: 500 GB.
 *
 * Dekadických, ne GiB — Hetzner účtuje v TB po deseti mocninách
 * a strop, který se s fakturou nedá porovnat, je k ničemu.
 *
 * ═══ Proč strop vůbec ══════════════════════════════════════════════
 * Hetzner tvrdý limit nenabízí: bucket roste dál a přiteče faktura.
 * Devět kamer udělá 300 GB denně, takže zaseknutá retence nebo kamera
 * přepnutá do vyšší kvality vyjede přes rozpočet za pár dní. Strop je
 * levnější než překvapení.
 *
 * Musí sedět s DEFAULT v migraci 20260918120000.
 */
export const DEFAULT_RECORDING_QUOTA_BYTES = 500_000_000_000;

/**
 * Adresa pro přehrání záznamu.
 *
 * Ne podepsaná adresa úložiště, ale cesta do portálu — teprve ten pod
 * RLS ověří, že se uživatel smí dívat, a odkáže dál. Cesta se kóduje
 * po segmentech, aby lomítka zůstala lomítky.
 */
export function recordingMediaHref(storagePath: string): string {
  const cesta = storagePath.split("/").map(encodeURIComponent).join("/");
  return `/api/media/zaznamy/${cesta}`;
}

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
