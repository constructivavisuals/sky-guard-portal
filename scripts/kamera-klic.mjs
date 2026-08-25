#!/usr/bin/env node
// Vypíše ingest klíč jedné kamery a SQL, kterým se zaeviduje otisk.
//
// Klíč se nikam neukládá — ani do repa, ani do databáze. Sem se vypíše
// proto, aby ho bylo možné nastavit v kameře; do databáze jde jen jeho
// otisk, aby server poznal, že kamera už na společném tajemství neběží.
//
//   npm run kamera-klic CAM-VV-01
//   npm run kamera-klic CAM-VV-01 2      # rotace na verzi 2

import { deriveCameraKey, cameraKeyFingerprint } from "../src/lib/ingest/camera-key.ts";

const [serial, versionRaw] = process.argv.slice(2);

if (!serial) {
  console.error("Použití: npm run kamera-klic <sériové-číslo> [verze]");
  process.exit(1);
}

try {
  process.loadEnvFile(".env.local");
} catch {
  // Proměnná může přijít i z prostředí; chybí-li, řekne to kontrola níž.
}

const master = process.env.INGEST_SECRET;
if (!master) {
  console.error("Chybí INGEST_SECRET (.env.local nebo prostředí).");
  process.exit(1);
}

const version = versionRaw === undefined ? 1 : Number(versionRaw);

let key;
try {
  key = deriveCameraKey(master, serial, version);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

const fingerprint = cameraKeyFingerprint(key);

console.log(`Kamera ${serial}, verze klíče ${version}`);
console.log();
console.log("Klíč do kamery (podepisuje se jím HMAC-SHA256):");
console.log(`  ${key}`);
console.log();
console.log("SQL do databáze — obsahuje jen otisk, ne klíč:");
console.log(
  `  UPDATE cameras SET ingest_secret_hash = '${fingerprint}', ` +
    `ingest_key_version = ${version} WHERE serial_number = '${serial}';`,
);
console.log();
console.log("Klíč si nikam nepoznamenávejte — když se ztratí, vypíše se znovu.");
