import {
  DETECTION_OBJECT_CLASSES,
  type DetectionObjectClass,
  type Json,
} from "../../types/database.ts";

// Validace těla ingest požadavku. Zvlášť od podpisu, protože se testuje
// jinak a chybové kódy míří na jiné HTTP stavy (400 vs. 401).

export interface DetectionPayload {
  cameraSerial: string;
  detectedAt: Date;
  objectClass: DetectionObjectClass;
  confidence: number | null;
  raw: Json;
}

export type PayloadResult =
  | { ok: true; payload: DetectionPayload }
  | { ok: false; errors: string[] };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" && value !== null && !Array.isArray(value)
  );
}

export function parseDetectionPayload(body: unknown): PayloadResult {
  const errors: string[] = [];

  if (!isPlainObject(body)) {
    return { ok: false, errors: ["Tělo požadavku musí být JSON objekt"] };
  }

  const rawSerial = body.camera_serial;
  const cameraSerial =
    typeof rawSerial === "string" ? rawSerial.trim() : "";
  if (!cameraSerial) {
    errors.push("camera_serial musí být neprázdný řetězec");
  }

  // detected_at je čas z kamery; chybí-li, bereme čas přijetí.
  let detectedAt = new Date();
  if (body.detected_at !== undefined && body.detected_at !== null) {
    if (typeof body.detected_at !== "string") {
      errors.push("detected_at musí být ISO 8601 řetězec");
    } else {
      const parsed = new Date(body.detected_at);
      if (Number.isNaN(parsed.getTime())) {
        errors.push("detected_at není platný ISO 8601 čas");
      } else {
        detectedAt = parsed;
      }
    }
  }

  let objectClass: DetectionObjectClass = "unknown";
  if (body.object_class !== undefined && body.object_class !== null) {
    const candidate = body.object_class;
    if (
      typeof candidate !== "string" ||
      !(DETECTION_OBJECT_CLASSES as readonly string[]).includes(candidate)
    ) {
      errors.push(
        `object_class musí být jedna z: ${DETECTION_OBJECT_CLASSES.join(", ")}`,
      );
    } else {
      objectClass = candidate as DetectionObjectClass;
    }
  }

  let confidence: number | null = null;
  if (body.confidence !== undefined && body.confidence !== null) {
    if (typeof body.confidence !== "number" || !Number.isFinite(body.confidence)) {
      errors.push("confidence musí být číslo");
    } else if (body.confidence < 0 || body.confidence > 1) {
      errors.push("confidence musí být v rozsahu 0–1");
    } else {
      confidence = body.confidence;
    }
  }

  let raw: Json = {};
  if (body.raw !== undefined && body.raw !== null) {
    if (!isPlainObject(body.raw)) {
      errors.push("raw musí být JSON objekt");
    } else {
      raw = body.raw;
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    payload: { cameraSerial, detectedAt, objectClass, confidence, raw },
  };
}
