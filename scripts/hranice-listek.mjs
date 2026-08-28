#!/usr/bin/env node
// Shoda lístku na živý obraz mezi portálem a relayem.
//
// Podpis počítají DVĚ nezávislé implementace: TypeScript v portálu
// (src/lib/live/token.ts) ho vydává, Python na relayi
// (infra/sky-watcher/live.py) ho ověřuje. Když se rozejdou v tom, co
// přesně se podepisuje, projeví se to jako „neplatný lístek“ — tedy
// stejně jako špatné tajemství. Hledalo by se to v prostředí místo
// v kódu, a to je ta nejdražší možná záměna.
//
// Tenhle skript proto nechá TS vydat lístky a Python je ověřit, na
// týchž vstupech, včetně těch, které mají SELHAT — kdyby Python
// pouštěl všechno, prošel by test i s rozbitým ověřením.
//
//   node scripts/hranice-listek.mjs

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");

const { issueLiveToken } = await import(join(REPO, "src/lib/live/token.ts"));

const SECRET = "parita-tajemstvi-zivy-obraz";
const NOW = new Date("2026-08-28T12:00:00Z");
const TED = Math.floor(NOW.getTime() / 1000);

const STREAMY = [
  "BK024AAPAGB5592",
  "cam-01",
  // Sériové číslo s podtržítkem: go2rtc jím odlišuje vedlejší proud.
  "BK024AAPAGB5592_sub",
  // Znaky, na kterých by se rozešlo kódování.
  "kamera-ěščřž",
  "a.b.c",
];

/** Co má projít a co ne. Obojí schválně. */
const PRIPADY = [];

for (const stream of STREAMY) {
  const { token } = issueLiveToken({ stream, secret: SECRET, now: NOW });
  PRIPADY.push({ popis: `platný — ${stream}`, stream, token, ceka: "ok" });
  // Týž lístek na jinou kameru projít NESMÍ.
  PRIPADY.push({
    popis: `cizí kamera — ${stream}`,
    stream: `${stream}-jina`,
    token,
    ceka: "bad_signature",
  });
}

const { token: kratky } = issueLiveToken({
  stream: "BK024AAPAGB5592",
  secret: SECRET,
  now: NOW,
  ttlSeconds: 1,
});
PRIPADY.push({
  popis: "propadlý",
  stream: "BK024AAPAGB5592",
  token: kratky,
  ceka: "expired",
  ted: TED + 5,
});

const { token: platny } = issueLiveToken({
  stream: "BK024AAPAGB5592",
  secret: SECRET,
  now: NOW,
});
const [exp, sig] = platny.split(".");

PRIPADY.push({
  popis: "prodloužená platnost",
  stream: "BK024AAPAGB5592",
  token: `${Number(exp) + 3600}.${sig}`,
  ceka: "bad_signature",
});
PRIPADY.push({
  popis: "zmršený tvar",
  stream: "BK024AAPAGB5592",
  token: "bez-tecky",
  ceka: "malformed",
});
PRIPADY.push({
  popis: "cizí tajemství",
  stream: "BK024AAPAGB5592",
  // Podpis ze správného tvaru, ale spočítaný jinde.
  token: `${exp}.${"f".repeat(64)}`,
  ceka: "bad_signature",
});

const vstup = JSON.stringify(
  PRIPADY.map(({ stream, token, ted }) => ({ stream, token, ted: ted ?? TED })),
);

const python = spawnSync(
  "python3",
  ["-c", `
import json, os, sys
os.environ["LIVE_STREAM_SECRET"] = ${JSON.stringify(SECRET)}
os.environ.setdefault("PORTAL_URL", "http://localhost")
os.environ.setdefault("RELAY_SECRET", "x")
sys.path.insert(0, ${JSON.stringify(join(REPO, "infra/sky-watcher"))})
import live
print(json.dumps([
    live.overit_listek(p["stream"], p["token"], p["ted"]) or "ok"
    for p in json.load(sys.stdin)
]))
`],
  { input: vstup, encoding: "utf8" },
);

if (python.status !== 0) {
  console.error("Python se nespustil:\n" + (python.stderr || ""));
  process.exit(1);
}

const vysledky = JSON.parse(python.stdout);
let chyb = 0;

for (const [i, pripad] of PRIPADY.entries()) {
  const dostal = vysledky[i];
  if (dostal === pripad.ceka) {
    console.log(`ok    ${pripad.popis} → ${dostal}`);
  } else {
    console.log(`FAIL  ${pripad.popis} — TS čeká ${pripad.ceka}, Python řekl ${dostal}`);
    chyb += 1;
  }
}

if (chyb > 0) {
  console.error(`\nSELHALO ${chyb} případů: portál a relay se v lístku rozešly.`);
  process.exit(1);
}
console.log("\nok  portál i relay počítají lístek stejně");
