import { CRON_JOBS } from "./runs.ts";

// Hlídač mimo hlídaný systém.
//
// ═══ Proč to nestačí mít v cron_runs ═══════════════════════════════
// Evidence běhů i varování na přehledu žijí uvnitř portálu. Když umře
// VPS, na které cron běží, `cron_runs` zestárne a přehled to sice
// ukáže — jenže notifikaci o tom posílá `varovani`, tedy právě ten
// mrtvý cron. Nikdo se nic nedozví, dokud si sám neotevře portál.
// Hlídky nelétají, lety se nedotahují, snímky se neuklízí, a obrazovka
// vypadá jako klidná noc.
//
// Proto ping ven: healthchecks.io čeká na signál a když nepřijde do
// nastaveného okna, ozve se samo. Je to dead man's switch — hlídá
// TICHO, ne chybu, takže funguje i tehdy, když celý stroj zhasne.
//
// ═══ Dvě místa, odkud se pingá ═════════════════════════════════════
// 1) crontab na VPS (`curl -fsS … && curl hc-ping.com/UUID`) —
//    doloží, že stroj žije a endpoint odpověděl 2xx.
// 2) tenhle modul z endpointu — doloží navíc, JAK běh dopadl:
//    `/fail` u chybného, prostý ping u úspěšného.
//
// Stačí jedno z toho. Když je nastavená proměnná, jede obojí a je to
// v pořádku: healthchecks.io bere opakovaný ping jako jeden.
// ═══════════════════════════════════════════════════════════════════

/** Ping nesmí zdržet odpověď endpointu o víc než tohle. */
export const HEALTHCHECK_TIMEOUT_MS = 5_000;

/**
 * Název proměnné prostředí s adresou pro danou úlohu.
 *
 * `patrols` → `HEALTHCHECK_URL_PATROLS`. Nenastavená proměnná znamená
 * „tuhle úlohu zvenčí nehlídáme“ a je to tichý, dovolený stav — jinak
 * by první nasazení bez healthchecks.io zaplavilo log.
 */
export function healthcheckEnvName(job: string): string {
  return `HEALTHCHECK_URL_${job.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
}

/** Adresa pro danou úlohu, nebo null. Prázdná hodnota se bere jako nenastavená. */
export function healthcheckUrl(
  job: string,
  env: Record<string, string | undefined> = process.env,
): string | null {
  const raw = env[healthcheckEnvName(job)]?.trim();
  if (!raw) return null;

  // Jen https, a jen absolutní adresa. Kdyby se do proměnné dostal
  // překlep, ping má selhat hned tady, ne až voláním někam do sítě.
  if (!raw.startsWith("https://")) {
    console.warn("Adresa hlídače není https — ping se neposílá", { job });
    return null;
  }
  return raw.replace(/\/+$/, "");
}

/**
 * Ohlásí doběhnutí úlohy hlídači.
 *
 * NIKDY nevyhazuje a nikdy nemění výsledek běhu — platí tu totéž co
 * pro `recordCronRun`: dohled nad cronem nesmí být tím, co cron shodí.
 */
export async function pingHealthcheck(job: string, ok: boolean): Promise<void> {
  const url = healthcheckUrl(job);
  if (!url) return;

  try {
    await fetch(ok ? url : `${url}/fail`, {
      method: "POST",
      // Tělo si healthchecks.io uloží k pingu; jméno úlohy v něm
      // pomůže, když se adresy někdy prohodí.
      body: job,
      signal: AbortSignal.timeout(HEALTHCHECK_TIMEOUT_MS),
      cache: "no-store",
    });
  } catch (error) {
    // Nedostupný hlídač není chyba běhu. Zaloguje se, aby se poznalo,
    // že hlídání nefunguje — samo o sobě to ale nic nezastaví.
    console.warn("Ping hlídači selhal", {
      job,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Které úlohy hlídač zvenčí zatím nemají. Pro dohledovou stránku. */
export function jobsWithoutHealthcheck(
  env: Record<string, string | undefined> = process.env,
): string[] {
  return CRON_JOBS.filter((job) => !healthcheckUrl(job.name, env)).map(
    (job) => job.name,
  );
}
