// Hledá import ze serverového souboru do "use client" modulu.
//
// Komponenta se z klientského modulu importovat SMÍ (server ji jen
// vykreslí). Nesmí se z něj volat funkce — server dostane klientskou
// referenci a spadne to až za běhu, což build nechytí.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve, dirname } from "node:path";

const KOREN = "src";
const soubory = [];
(function projdi(dir) {
  for (const jmeno of readdirSync(dir)) {
    const cesta = join(dir, jmeno);
    if (statSync(cesta).isDirectory()) projdi(cesta);
    else if (/\.tsx?$/.test(cesta) && !cesta.endsWith(".test.ts")) soubory.push(cesta);
  }
})(KOREN);

const jeKlient = new Map();
for (const f of soubory) {
  const obsah = readFileSync(f, "utf8");
  jeKlient.set(resolve(f), /^\s*["']use client["']/.test(obsah));
}

/** Vyřeší relativní i @/ import na soubor v repu. */
function cil(zdroj, spec) {
  let zaklad;
  if (spec.startsWith("@/")) zaklad = resolve("src", spec.slice(2));
  else if (spec.startsWith(".")) zaklad = resolve(dirname(zdroj), spec);
  else return null;
  for (const p of [zaklad, `${zaklad}.ts`, `${zaklad}.tsx`, join(zaklad, "index.ts")]) {
    if (jeKlient.has(resolve(p))) return resolve(p);
  }
  return null;
}

const nalezy = [];
for (const f of soubory) {
  const abs = resolve(f);
  if (jeKlient.get(abs)) continue; // klient → klient je v pořádku

  const obsah = readFileSync(f, "utf8");
  const re = /import\s+(type\s+)?\{([^}]+)\}\s+from\s+["']([^"']+)["']/g;
  let m;
  while ((m = re.exec(obsah))) {
    const [, jeTyp, seznam, spec] = m;
    if (jeTyp) continue; // typy se mažou při překladu
    const target = cil(abs, spec);
    if (!target || !jeKlient.get(target)) continue;

    for (const raw of seznam.split(",")) {
      const jmeno = raw.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0].trim();
      if (!jmeno || raw.trim().startsWith("type ")) continue;
      // Velké písmeno = komponenta, ta se jen vykresluje.
      if (/^[A-Z]/.test(jmeno)) continue;
      // Volá se ta hodnota v tomhle souboru?
      const volani = new RegExp(`\\b${jmeno}\\s*\\(`);
      if (volani.test(obsah)) {
        nalezy.push(`${f}: volá ${jmeno}() z klientského ${spec}`);
      } else {
        nalezy.push(`${f}: bere hodnotu ${jmeno} z klientského ${spec} (ověřit)`);
      }
    }
  }
}

if (nalezy.length === 0) {
  console.log("ok  žádný server nevolá hodnotu z klientského modulu");
} else {
  console.log("NÁLEZY:");
  for (const n of nalezy) console.log("  - " + n);
  process.exitCode = 1;
}
