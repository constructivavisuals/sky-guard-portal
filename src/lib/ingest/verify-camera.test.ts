import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { cameraKeyFingerprint, deriveCameraKey } from "./camera-key.ts";
import type { IngestCameraRow } from "./camera-lookup.ts";
import { computeSignature } from "./signature.ts";
import { verifyForCamera } from "./verify-camera.ts";

// Rotace hlavního tajemství. Podstatné je, že kamera, na kterou ještě
// nikdo nesáhl, hlásí dál — jinak by výměna tajemství znamenala výpadek
// celé ostrahy, který se navíc pozná až po hodině.

const NOVE = "nove-tajemstvi";
const STARE = "stare-tajemstvi";
const SERIAL = "CAM-BRANA";
const NOW = new Date("2026-08-27T10:00:00Z");
const TS = String(Math.floor(NOW.getTime() / 1000));
const BODY = '{"camera_serial":"CAM-BRANA"}';

/** Kamera s vlastním klíčem odvozeným z daného tajemství. */
function camera(secret: string): IngestCameraRow {
  return {
    id: "cam-1",
    site_id: "site-1",
    zone_id: null,
    serial_number: SERIAL,
    ingest_secret_hash: cameraKeyFingerprint(deriveCameraKey(secret, SERIAL, 1)),
    ingest_key_version: 1,
    ingest_mode: "http",
    detects_person: true,
    detects_vehicle: true,
    reads_plate: false,
    sites: null,
    zones: null,
  };
}

/** Podpis, jak ho spočítá kamera se svým klíčem. */
function podpis(secret: string): string {
  return computeSignature(deriveCameraKey(secret, SERIAL, 1), TS, BODY);
}

function overit(secrets: string[], cam: IngestCameraRow | null, signature: string) {
  return verifyForCamera({
    rawBody: BODY,
    signature,
    timestamp: TS,
    now: NOW,
    secrets,
    camera: cam,
  });
}

describe("verifyForCamera — rotace tajemství", () => {
  it("přepnutá kamera projde na nové tajemství", () => {
    const r = overit([NOVE, STARE], camera(NOVE), podpis(NOVE));
    assert.equal(r.valid, true);
    assert.equal(r.valid && r.usedPrevious, false);
  });

  it("nepřepnutá kamera projde na předchozí a je to vidět", () => {
    // Tohle je celý smysl věci: kamera, na kterou ještě nikdo nesáhl,
    // hlásí dál a v logu je vidět, že čeká na přehrání.
    const r = overit([NOVE, STARE], camera(STARE), podpis(STARE));
    assert.equal(r.valid, true);
    assert.equal(r.valid && r.usedPrevious, true);
  });

  it("bez předchozího tajemství stará kamera neprojde", () => {
    // Po dokončení rotace se proměnná smaže a starý klíč přestane
    // platit — o to jde.
    const r = overit([NOVE], camera(STARE), podpis(STARE));
    assert.equal(r.valid, false);
  });

  it("cizí podpis neprojde ani na jedno tajemství", () => {
    const r = overit([NOVE, STARE], camera(NOVE), computeSignature("cizi", TS, BODY));
    assert.equal(r.valid, false);
    assert.equal(r.valid === false && r.reason, "signature_mismatch");
  });

  it("kamera bez vlastního klíče jede na společném tajemství", () => {
    const bezKlice = { ...camera(NOVE), ingest_secret_hash: null };
    const r = overit([NOVE, STARE], bezKlice, computeSignature(NOVE, TS, BODY));
    assert.equal(r.valid, true);
  });

  it("kamera bez klíče projde i na předchozí společné tajemství", () => {
    const bezKlice = { ...camera(NOVE), ingest_secret_hash: null };
    const r = overit([NOVE, STARE], bezKlice, computeSignature(STARE, TS, BODY));
    assert.equal(r.valid, true);
    assert.equal(r.valid && r.usedPrevious, true);
  });

  it("neznámá kamera se ověřuje společným tajemstvím", () => {
    // Aby se z odpovědi nedalo zjistit, jestli sériové číslo existuje.
    const r = overit([NOVE], null, computeSignature(NOVE, TS, BODY));
    assert.equal(r.valid, true);
  });

  it("staré razítko neprojde a důvod se nezamlčí", () => {
    const stary = String(Math.floor(NOW.getTime() / 1000) - 3600);
    const r = verifyForCamera({
      rawBody: BODY,
      signature: computeSignature(deriveCameraKey(NOVE, SERIAL, 1), stary, BODY),
      timestamp: stary,
      now: NOW,
      secrets: [NOVE, STARE],
      camera: camera(NOVE),
    });
    assert.equal(r.valid, false);
    assert.equal(r.valid === false && r.reason, "stale_timestamp");
  });

  it("otisk, který nesedí na žádné tajemství, je chyba nastavení", () => {
    const zcizi = { ...camera(NOVE), ingest_secret_hash: "0".repeat(64) };
    const r = overit([NOVE, STARE], zcizi, podpis(NOVE));
    assert.equal(r.valid, false);
    assert.equal(r.valid === false && r.reason, "signature_mismatch");
  });
});

describe("ingestSecrets", () => {
  // Chování proměnných se testuje přes podstrčené prostředí; sahat na
  // process.env v testech by ovlivnilo ostatní soubory.
  it("prázdné nebo shodné předchozí tajemství se ignoruje", async () => {
    const { ingestSecrets } = await import("../env.ts");
    const puvodni = { ...process.env };
    try {
      process.env.INGEST_SECRET = "a";

      process.env.INGEST_SECRET_PREVIOUS = "";
      assert.deepEqual(ingestSecrets(), ["a"]);

      process.env.INGEST_SECRET_PREVIOUS = "   ";
      assert.deepEqual(ingestSecrets(), ["a"]);

      // Shodná hodnota by jen zdvojila práci.
      process.env.INGEST_SECRET_PREVIOUS = "a";
      assert.deepEqual(ingestSecrets(), ["a"]);

      process.env.INGEST_SECRET_PREVIOUS = "b";
      assert.deepEqual(ingestSecrets(), ["a", "b"]);
    } finally {
      process.env = puvodni;
    }
  });
});

// ═══ Relay za stavební kameru ══════════════════════════════════════
// Stavební kamera se podepsat neumí. Události přeposílá relay, který
// drží vlastní tajemství. Rozhoduje o tom ingest_mode v databázi —
// kdyby si to volající směl vybrat hlavičkou, stačila by kompromitace
// VPS k podvržení detekce od kamery u brány.

const RELAY = "relay-tajemstvi";
const RELAY_STARE = "relay-predchozi";

/** Stavební kamera: režim ftp, žádný vlastní klíč. */
function ftpKamera(): IngestCameraRow {
  return { ...camera(NOVE), ingest_mode: "ftp", ingest_secret_hash: null };
}

function overitSRelayem(
  cam: IngestCameraRow | null,
  signature: string,
  relaySecrets: string[],
) {
  return verifyForCamera({
    rawBody: BODY,
    signature,
    timestamp: TS,
    now: NOW,
    secrets: [NOVE, STARE],
    relaySecrets,
    camera: cam,
  });
}

/** Podpis relaye: přímo tajemstvím, bez odvozování na kameru. */
const relayPodpis = (secret: string) => computeSignature(secret, TS, BODY);

describe("verifyForCamera — relay", () => {
  it("relay se za FTP kameru podepíše", () => {
    const r = overitSRelayem(ftpKamera(), relayPodpis(RELAY), [RELAY]);
    assert.equal(r.valid, true);
    assert.equal(r.valid && r.actor, "relay");
  });

  it("rotace RELAY_SECRET nezastaví hlášení a je vidět v logu", () => {
    const r = overitSRelayem(ftpKamera(), relayPodpis(RELAY_STARE), [RELAY, RELAY_STARE]);
    assert.equal(r.valid, true);
    assert.equal(r.valid && r.usedPrevious, true);
  });

  it("bez RELAY_SECRET FTP kamera neprojde", () => {
    // Přijmout to bez ověření by z endpointu udělalo otevřený zápis
    // do evidence. Radši ticho, které je vidět na přehledu.
    const r = overitSRelayem(ftpKamera(), relayPodpis(RELAY), []);
    assert.equal(r.valid, false);
  });

  it("INGEST_SECRET za FTP kameru nemluví", () => {
    // Jinak by kdokoli s hlavním tajemstvím obešel hranici relaye.
    const r = overitSRelayem(ftpKamera(), podpis(NOVE), [RELAY]);
    assert.equal(r.valid, false);
  });

  it("relay se NEsmí podepsat za kameru, která se umí podepsat sama", () => {
    // Tohle je ta věta, kvůli které je rozhodnutí v databázi: kamera
    // u brány otevírá závoru, a relay na VPS k ní nesmí mít cestu.
    const brana = camera(NOVE); // ingest_mode: "http"
    const r = overitSRelayem(brana, relayPodpis(RELAY), [RELAY]);
    assert.equal(r.valid, false);
  });

  it("HTTP kamera se pořád podepisuje sama", () => {
    const r = overitSRelayem(camera(NOVE), podpis(NOVE), [RELAY]);
    assert.equal(r.valid, true);
    assert.equal(r.valid && r.actor, "camera");
  });
});
