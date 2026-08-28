#!/usr/bin/env node
// Přetagování už nahraných záznamů v Hetzneru.
//
//   node --experimental-strip-types scripts/pretaguj-zaznamy.mjs < cesty.txt
//   … --pretaguj        skutečně zapíše (výchozí je jen rozbor)
//
// Cesty se čtou ze standardního vstupu, jedna na řádek. Získají se
// z portálu:
//
//   SELECT storage_path FROM camera_recordings
//    WHERE storage_backend = 'hetzner' AND video_expired_at IS NULL;
//
// ═══ CO TENHLE SKRIPT NEUMÍ ════════════════════════════════════════
// Nevrátí parametry streamu, které `-tag:v hvc1` při remuxu VYHODIL
// ze vzorků. Ty v souboru nejsou a není odkud je vzít — ověřeno
// měřením: ani `ffmpeg -c copy -tag:v hev1`, ani přepsání
// čtyřznakového kódu je do vzorků nedoplní.
//
// Umí jediné: přepsat ten kód z `hvc1` na `hev1`. Pomůže to jen tehdy,
// když souboru vadil samotný kód, ne chybějící parametry. Když kamera
// parametry za běhu měnila, je ten záznam neopravitelný a musel by se
// znovu stáhnout z SD karty kamery.
//
// Proto je výchozí režim ROZBOR: řekne, kolika souborů se to týká,
// a zapisuje se až na výslovné přání. Přepsat 2 TB kvůli čtyřem
// bajtům na soubor je drahé a stojí za to vědět předem, do čeho se jde.

import { hetznerStorageConfig } from "../src/lib/env.ts";
import { objectUrl, presignUrl, signedHeaders } from "../src/lib/storage/s3.ts";
import { headObject } from "../src/lib/storage/objects.ts";
import { najdiFourcc, prepisFourcc } from "../src/lib/storage/mp4.ts";

const PRETAGUJ = process.argv.includes("--pretaguj");

/** Kolik bajtů od začátku stačí na hlavičku. Díky +faststart je moov první. */
const HLAVICKA_BYTES = 256 * 1024;

async function stahniHlavicku(cfg, klic, delka) {
  const konec = Math.min(HLAVICKA_BYTES, delka) - 1;
  const hlavicky = signedHeaders(cfg, { method: "GET", key: klic });
  const odpoved = await fetch(objectUrl(cfg, klic), {
    headers: { ...hlavicky, Range: `bytes=0-${konec}` },
  });
  if (!odpoved.ok && odpoved.status !== 206) {
    throw new Error(`GET ${odpoved.status}`);
  }
  return Buffer.from(await odpoved.arrayBuffer());
}

async function prepis(cfg, klic) {
  // Celý objekt: S3 neumí změnit čtyři bajty na místě, zápis je vždy
  // celý objekt znovu.
  const url = presignUrl(cfg, { method: "GET", key: klic, expiresIn: 600 });
  const odpoved = await fetch(url);
  if (!odpoved.ok) throw new Error(`stažení ${odpoved.status}`);
  const data = Buffer.from(await odpoved.arrayBuffer());

  const nalez = najdiFourcc(data);
  if (!nalez || nalez.kod !== "hvc1") return false;
  prepisFourcc(data, nalez, "hev1");

  const nahrani = presignUrl(cfg, { method: "PUT", key: klic, expiresIn: 600 });
  const zapis = await fetch(nahrani, {
    method: "PUT",
    body: data,
    headers: { "Content-Type": "video/mp4" },
  });
  if (!zapis.ok) throw new Error(`nahrání ${zapis.status}`);
  return true;
}

async function main() {
  const cfg = hetznerStorageConfig();

  const vstup = await new Promise((res) => {
    let text = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (kus) => (text += kus));
    process.stdin.on("end", () => res(text));
  });

  const cesty = vstup.split("\n").map((r) => r.trim()).filter(Boolean);
  if (cesty.length === 0) {
    console.error("Na vstupu nejsou žádné cesty. Viz hlavička skriptu.");
    process.exit(2);
  }

  const souhrn = { hvc1: 0, hev1: 0, jine: 0, chyba: 0, prepsano: 0 };

  for (const klic of cesty) {
    try {
      const info = await headObject(cfg, klic);
      if (!info) {
        console.log(`chybí     ${klic}`);
        souhrn.chyba += 1;
        continue;
      }

      const hlavicka = await stahniHlavicku(cfg, klic, info.size ?? HLAVICKA_BYTES);
      const nalez = najdiFourcc(hlavicka);

      if (!nalez) {
        console.log(`nečitelné ${klic}`);
        souhrn.chyba += 1;
        continue;
      }

      if (nalez.kod === "hvc1") {
        souhrn.hvc1 += 1;
        if (PRETAGUJ) {
          await prepis(cfg, klic);
          souhrn.prepsano += 1;
          console.log(`přepsáno  ${klic}`);
        } else {
          console.log(`hvc1      ${klic}`);
        }
      } else if (nalez.kod === "hev1") {
        souhrn.hev1 += 1;
      } else {
        souhrn.jine += 1;
      }
    } catch (chyba) {
      souhrn.chyba += 1;
      console.log(`chyba     ${klic} — ${chyba.message}`);
    }
  }

  console.log("\n── Souhrn");
  console.log(`  hvc1 (dotčené)   ${souhrn.hvc1}`);
  console.log(`  hev1 (v pořádku) ${souhrn.hev1}`);
  console.log(`  jiný kodek       ${souhrn.jine}`);
  console.log(`  chyby            ${souhrn.chyba}`);
  if (PRETAGUJ) console.log(`  přepsáno         ${souhrn.prepsano}`);
  else if (souhrn.hvc1 > 0) {
    console.log("\n  Zápis se nekonal. Než ho pustíš, přečti si hlavičku");
    console.log("  skriptu — přetagování NEVRÁTÍ vyhozené parametry streamu.");
  }
}

// Spuštěné přímo, ne importované kvůli testu.
if (process.argv[1]?.endsWith("pretaguj-zaznamy.mjs")) {
  await main();
}
