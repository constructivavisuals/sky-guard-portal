#!/usr/bin/env node
// Podepíše tělo požadavku relayovým tajemstvím a vypíše hotový curl.
//
// Ruční počítání HMAC je otrava a překlep v něm vypadá jako zamítnutý
// podpis, což se ladí špatně. Tenhle skript dělá totéž co relay:
// podepíše `${timestamp}.${tělo}` a vypíše příkaz, který jde vložit do
// terminálu.
//
//   RELAY_SECRET=… node scripts/relay-podpis.mjs ohlaseni  > /tmp/a.sh
//   RELAY_SECRET=… node scripts/relay-podpis.mjs potvrzeni <recording_id>
//
// Tělo se dá podstrčit i vlastní:
//   RELAY_SECRET=… node scripts/relay-podpis.mjs telo '{"a":1}'

import { createHmac } from "node:crypto";

const secret = process.env.RELAY_SECRET;
if (!secret) {
  console.error("Chybí RELAY_SECRET v prostředí.");
  process.exit(1);
}

const host = process.env.PORTAL_HOST ?? "http://localhost:3000";
const [rezim, arg] = process.argv.slice(2);

/** Ukázkové ohlášení. Časy jsou od teď, ať se trefí do tolerance. */
function ohlaseni() {
  const zacatek = new Date(Date.now() - 60_000);
  const konec = new Date(zacatek.getTime() + 43_000);
  const stamp = zacatek.toISOString().replace(/[-:]/g, "").slice(0, 15);
  return {
    cesta: "/api/ingest/recording",
    telo: {
      camera_serial: process.env.CAMERA_SERIAL ?? "BK024AAPAGB5592",
      sd_file_path: `test/${stamp}.dav`,
      started_at: zacatek.toISOString(),
      ended_at: konec.toISOString(),
      event_type: "motion",
      media_type: "video/mp4",
    },
  };
}

function potvrzeni(id) {
  if (!id) {
    console.error("Chybí recording_id: node scripts/relay-podpis.mjs potvrzeni <uuid>");
    process.exit(1);
  }
  return { cesta: "/api/ingest/recording/confirm", telo: { recording_id: id } };
}

let plan;
if (rezim === "potvrzeni") plan = potvrzeni(arg);
else if (rezim === "telo") plan = { cesta: "/api/ingest/recording", telo: JSON.parse(arg) };
else plan = ohlaseni();

// JSON.stringify musí být TOTÉŽ, co se pošle — podepisuje se bajt po
// bajtu, ne objekt. Proto se tělo ukládá do proměnné a použije dvakrát.
const telo = JSON.stringify(plan.telo);
const timestamp = String(Math.floor(Date.now() / 1000));
const podpis = createHmac("sha256", secret)
  .update(`${timestamp}.${telo}`, "utf8")
  .digest("hex");

console.log(`curl -sS -X POST '${host}${plan.cesta}' \\
  -H 'Content-Type: application/json' \\
  -H 'X-Timestamp: ${timestamp}' \\
  -H 'X-Signature: ${podpis}' \\
  --data '${telo.replace(/'/g, `'\\''`)}'`);
