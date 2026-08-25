import { createHash, createHmac } from "node:crypto";

// Ingest klíč jedné kamery.
//
// Klíč se neukládá, odvozuje se z hlavního INGEST_SECRET a ze sériového
// čísla kamery. Kdo vypáčí jednu kameru, dostane klíč jen k ní —
// z odvozeného klíče se hlavní tajemství zpětně spočítat nedá.
//
// V databázi je jen SHA-256 otisk, viz migrace 20260829120000.

/** Verze klíče, se kterou se kamera zakládá. Rotace = vyšší číslo. */
export const INITIAL_KEY_VERSION = 1;

/**
 * Klíč pro jednu kameru.
 *
 * Do odvození vstupuje i verze, takže rotace jedné kamery nesáhne na
 * ostatní. Oddělovač je tečka a sériové číslo ji obsahovat nesmí —
 * jinak by šlo `CAM-1` s verzí `2.1` splést s `CAM-1.2` a verzí `1`.
 */
export function deriveCameraKey(
  masterSecret: string,
  serialNumber: string,
  keyVersion: number = INITIAL_KEY_VERSION,
): string {
  if (serialNumber.includes(".")) {
    throw new Error("Sériové číslo kamery nesmí obsahovat tečku");
  }
  if (!Number.isInteger(keyVersion) || keyVersion < 1) {
    throw new Error("Verze klíče musí být celé číslo od 1");
  }
  return createHmac("sha256", masterSecret)
    .update(`${serialNumber}.${keyVersion}`, "utf8")
    .digest("hex");
}

/** Otisk, který se ukládá do cameras.ingest_secret_hash. */
export function cameraKeyFingerprint(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex");
}
