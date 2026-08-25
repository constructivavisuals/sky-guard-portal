import { DEFAULT_TOLERANCE_SECONDS } from "./signature.ts";

// Validace těla požadavku na vjezd.
//
// Stejná pravidla jako u detekce (payload.ts): čas je hlášený údaj
// omezený tolerancí podpisu, o rozhodnutí se stará server. Navíc je tu
// snímek — jediné místo v celém ingestu, kudy chodí binární data.

/** Snímek od brány. Větší se odmítá dřív, než se vůbec čte tělo. */
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

const POVOLENE_TYPY = new Set(["image/jpeg", "image/png", "image/webp"]);

export interface PassagePayload {
  cameraSerial: string;
  passedAt: Date;
  /** Snímek v base64 bez prefixu data:. Null, když kamera žádný neposlala. */
  image: { base64: string; mediaType: string } | null;
  /** Cokoli navíc od kamery — ukládá se k detekci. */
  raw: Record<string, unknown>;
}

export type PassageResult =
  | { ok: true; payload: PassagePayload }
  | { ok: false; errors: string[] };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

export function parsePassagePayload(
  body: unknown,
  now: Date = new Date(),
): PassageResult {
  const errors: string[] = [];

  if (!isPlainObject(body)) {
    return { ok: false, errors: ["Tělo požadavku musí být JSON objekt"] };
  }

  const rawSerial = body.camera_serial;
  const cameraSerial = typeof rawSerial === "string" ? rawSerial.trim() : "";
  if (!cameraSerial) {
    errors.push("camera_serial musí být neprázdný řetězec");
  }

  // Stejně jako u detekce: hlášený čas je jen údaj, ne zdroj pravdy,
  // a mimo toleranci podpisu se odmítá místo tichého přepsání na teď.
  let passedAt = now;
  if (body.passed_at !== undefined && body.passed_at !== null) {
    if (typeof body.passed_at !== "string") {
      errors.push("passed_at musí být ISO 8601 řetězec");
    } else {
      const parsed = new Date(body.passed_at);
      if (Number.isNaN(parsed.getTime())) {
        errors.push("passed_at není platný ISO 8601 čas");
      } else if (
        Math.abs(now.getTime() - parsed.getTime()) >
        DEFAULT_TOLERANCE_SECONDS * 1_000
      ) {
        errors.push(
          `passed_at se od času serveru liší o víc než ${DEFAULT_TOLERANCE_SECONDS} s`,
        );
      } else {
        passedAt = parsed;
      }
    }
  }

  let image: PassagePayload["image"] = null;
  if (body.image !== undefined && body.image !== null) {
    if (!isPlainObject(body.image)) {
      errors.push("image musí být objekt");
    } else {
      const mediaType = String(body.image.media_type ?? "").toLowerCase();
      const data = body.image.data;

      if (!POVOLENE_TYPY.has(mediaType)) {
        errors.push(
          `image.media_type musí být jeden z: ${[...POVOLENE_TYPY].join(", ")}`,
        );
      } else if (typeof data !== "string" || data.length === 0) {
        errors.push("image.data musí být base64 řetězec");
      } else if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data)) {
        // Přísně: prefix data: ani zalomené řádky nepřijímáme, aby se
        // dekódování nechovalo jinak, než co změřil strop výš.
        errors.push("image.data není čistý base64 (bez prefixu a zalomení)");
      } else if (base64ByteLength(data) > MAX_IMAGE_BYTES) {
        errors.push(`snímek je větší než ${MAX_IMAGE_BYTES} B`);
      } else {
        image = { base64: data, mediaType };
      }
    }
  }

  let raw: Record<string, unknown> = {};
  if (body.raw !== undefined && body.raw !== null) {
    if (!isPlainObject(body.raw)) errors.push("raw musí být JSON objekt");
    else raw = body.raw;
  }

  if (errors.length > 0) return { ok: false, errors };

  return { ok: true, payload: { cameraSerial, passedAt, image, raw } };
}
