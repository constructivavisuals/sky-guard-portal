import {
  isSupportedRecordingType,
  type RecordingPlayback,
} from "../recordings/storage.ts";

// Validace těla požadavků od relaye.
//
// ═══ Čas tu NENÍ omezený tolerancí podpisu ═════════════════════════
// U detekce se hlášený čas musí vejít do pěti minut, protože detekce
// se hlásí, když se stane. Záznam ze stavební kamery je jiný případ:
// soubor se nahrává až po dotočení, relay ho může zpracovat s odstupem
// a po výpadku sítě leží ve frontě klidně den. Odmítnout ho kvůli stáří
// by znamenalo zahodit záznam, který existuje.
//
// Omezení jsou proto volnější a jiného druhu: dozadu měsíc (co je
// starší, stejně nikdo nedohledá), dopředu jen pár minut na rozjeté
// hodiny (záznam z budoucnosti neexistuje).

/** Jak starý smí být hlášený začátek záznamu. */
export const MAX_RECORDING_AGE_DAYS = 30;

/** A jak daleko dopředu — jen rezerva na rozjeté hodiny kamery. */
export const MAX_RECORDING_FUTURE_SECONDS = 300;

/** Strop na cestu v inboxu; delší je překlep, ne cesta. */
const MAX_PATH_LENGTH = 500;

export interface RecordingAnnounce {
  cameraSerial: string;
  /** Cesta v FTP inboxu relaye. Klíč idempotence. */
  sdFilePath: string;
  startedAt: Date;
  endedAt: Date | null;
  eventType: string | null;
  mediaType: string;
}

export interface RecordingConfirm {
  recordingId: string;
}

export type RecordingResult<T> =
  | { ok: true; payload: T }
  | { ok: false; errors: string[] };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Čas z těla, nebo null. Chybu zapíše do `errors`. */
function cas(
  value: unknown,
  pole: string,
  errors: string[],
  povinny: boolean,
): Date | null {
  if (value === undefined || value === null) {
    if (povinny) errors.push(`${pole} chybí`);
    return null;
  }
  if (typeof value !== "string") {
    errors.push(`${pole} musí být ISO 8601 řetězec`);
    return null;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    errors.push(`${pole} není platný ISO 8601 čas`);
    return null;
  }
  return parsed;
}

export function parseRecordingAnnounce(
  body: unknown,
  now: Date = new Date(),
): RecordingResult<RecordingAnnounce> {
  const errors: string[] = [];

  if (!isPlainObject(body)) {
    return { ok: false, errors: ["Tělo požadavku musí být JSON objekt"] };
  }

  const rawSerial = body.camera_serial;
  const cameraSerial = typeof rawSerial === "string" ? rawSerial.trim() : "";
  if (!cameraSerial) errors.push("camera_serial musí být neprázdný řetězec");

  const rawPath = body.sd_file_path;
  const sdFilePath = typeof rawPath === "string" ? rawPath.trim() : "";
  if (!sdFilePath) {
    errors.push("sd_file_path musí být neprázdný řetězec");
  } else if (sdFilePath.length > MAX_PATH_LENGTH) {
    errors.push("sd_file_path je nesmyslně dlouhá");
  } else if (sdFilePath.includes("..")) {
    // Do úložiště se tahle cesta nedostane — ta se skládá z UUID —
    // ale je to klíč idempotence a v logu. Dvě tečky v ní znamenají,
    // že něco skládá cesty jinak, než si myslíme.
    errors.push("sd_file_path nesmí obsahovat ..");
  }

  const startedAt = cas(body.started_at, "started_at", errors, true);
  if (startedAt) {
    const stariMs = now.getTime() - startedAt.getTime();
    if (stariMs > MAX_RECORDING_AGE_DAYS * 86_400_000) {
      errors.push(`started_at je starší než ${MAX_RECORDING_AGE_DAYS} dní`);
    } else if (stariMs < -MAX_RECORDING_FUTURE_SECONDS * 1_000) {
      errors.push("started_at je v budoucnosti");
    }
  }

  const endedAt = cas(body.ended_at, "ended_at", errors, false);
  if (startedAt && endedAt && endedAt.getTime() < startedAt.getTime()) {
    errors.push("ended_at je dřív než started_at");
  }

  const rawType = body.media_type;
  const mediaType = typeof rawType === "string" ? rawType.trim() : "";
  if (!isSupportedRecordingType(mediaType)) {
    // Radši odmítnout, než nahrát soubor, který bucket stejně nevezme.
    errors.push("media_type musí být video/mp4 nebo video/quicktime");
  }

  let eventType: string | null = null;
  if (body.event_type !== undefined && body.event_type !== null) {
    if (typeof body.event_type !== "string") {
      errors.push("event_type musí být řetězec");
    } else {
      const ocisteny = body.event_type.trim().slice(0, 40);
      eventType = ocisteny === "" ? null : ocisteny;
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    payload: {
      cameraSerial,
      sdFilePath,
      startedAt: startedAt as Date,
      endedAt,
      eventType,
      mediaType,
    },
  };
}

export function parseRecordingConfirm(
  body: unknown,
): RecordingResult<RecordingConfirm> {
  if (!isPlainObject(body)) {
    return { ok: false, errors: ["Tělo požadavku musí být JSON objekt"] };
  }

  const raw = body.recording_id;
  const recordingId = typeof raw === "string" ? raw.trim() : "";
  if (!UUID.test(recordingId)) {
    return { ok: false, errors: ["recording_id musí být UUID"] };
  }

  return { ok: true, payload: { recordingId } };
}

/**
 * Smí se pro tenhle záznam vystavit nahrávací adresa?
 *
 * Ne, když soubor už dorazil. Ohlášení se dá zopakovat (relay to dělá
 * po neúspěšném nahrání), ale zopakovat ho na hotový záznam by
 * znamenalo vystavit adresu, kterou jde přepsat existující soubor —
 * a to je z odchyceného požadavku levný způsob, jak zaměnit důkaz.
 */
export function mayIssueUploadUrl(playback: RecordingPlayback): boolean {
  return playback === "pending" || playback === "missing";
}
