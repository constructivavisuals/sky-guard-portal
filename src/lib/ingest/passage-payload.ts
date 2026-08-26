import {
  base64ByteLength,
  MAX_IMAGE_BYTES,
  parseIngestImage,
  type IngestImage,
} from "./image.ts";
import { DEFAULT_TOLERANCE_SECONDS } from "./signature.ts";

// Validace těla požadavku na vjezd.
//
// Stejná pravidla jako u detekce (payload.ts): čas je hlášený údaj
// omezený tolerancí podpisu, o rozhodnutí se stará server. Navíc je tu
// snímek — jediné místo v celém ingestu, kudy chodí binární data.

export { base64ByteLength, MAX_IMAGE_BYTES };

export interface PassagePayload {
  cameraSerial: string;
  passedAt: Date;
  /** Snímek v base64 bez prefixu data:. Null, když kamera žádný neposlala. */
  image: IngestImage | null;
  /** Cokoli navíc od kamery — ukládá se k detekci. */
  raw: Record<string, unknown>;
}

export type PassageResult =
  | { ok: true; payload: PassagePayload }
  | { ok: false; errors: string[] };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

  const image = parseIngestImage(body.image, errors);

  let raw: Record<string, unknown> = {};
  if (body.raw !== undefined && body.raw !== null) {
    if (!isPlainObject(body.raw)) errors.push("raw musí být JSON objekt");
    else raw = body.raw;
  }

  if (errors.length > 0) return { ok: false, errors };

  return { ok: true, payload: { cameraSerial, passedAt, image, raw } };
}
