#!/usr/bin/env node
// Připraví další migraci k vložení do SQL Editoru.
//
// Migrace se pouštějí ručně, takže databáze o nich nevede záznam.
// Evidenci drží supabase/nasazene-migrace.txt v repu — díky tomu je
// stav nasazení vidět i v gitu, ne jen v hlavě.

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const REPO = new URL("..", import.meta.url).pathname;
const MIGRATIONS = join(REPO, "supabase/migrations");
const RECORD = join(REPO, "supabase/nasazene-migrace.txt");

const record = readFileSync(RECORD, "utf8");
const deployed = new Set(
  record
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#")),
);

const all = readdirSync(MIGRATIONS)
  .filter((name) => name.endsWith(".sql"))
  .sort();
const pending = all.filter((name) => !deployed.has(name));

// Migrace na sebe navazují, takže se nabízí nejstarší nenasazená, ne
// nejnovější — přeskočit starší by nechalo schéma v půlce.
const next = pending[0];

if (process.argv.includes("--hotovo")) {
  if (!next) {
    console.log("Není co potvrzovat, všechny migrace jsou nasazené.");
    process.exit(0);
  }
  writeFileSync(RECORD, `${record.replace(/\n+$/, "")}\n${next}\n`);
  console.log(`Zapsáno jako nasazené: ${next}`);
  const zbyva = pending.length - 1;
  console.log(
    zbyva === 0
      ? "Nic dalšího nečeká."
      : `Čeká ještě ${zbyva}: spusť znovu npm run migrace.`,
  );
  process.exit(0);
}

if (!next) {
  console.log("Všechny migrace jsou nasazené, nic k vložení.");
  process.exit(0);
}

const sql = readFileSync(join(MIGRATIONS, next), "utf8");
const copy = spawnSync("pbcopy", { input: sql });

if (copy.error || copy.status !== 0) {
  // Radši to říct nahlas, než nechat člověka vložit do editoru
  // obsah schránky z minula.
  console.error("Do schránky se to zkopírovat nepodařilo.");
  console.error(`Otevři ručně: supabase/migrations/${next}`);
  process.exit(1);
}

const lines = sql.split("\n").length;
console.log(`Ve schránce: ${next}  (${lines} řádků)`);
if (pending.length > 1) {
  console.log(`Čeká celkem ${pending.length}, tahle je na řadě první.`);
}
console.log("Po spuštění v SQL Editoru potvrď: npm run migrace -- --hotovo");
