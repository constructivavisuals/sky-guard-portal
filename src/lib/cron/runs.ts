// Evidence běhů cronu.
//
// ═══ Proč vůbec ════════════════════════════════════════════════════
// Tři endpointy volá cron zvenčí, ne Vercel. Když se crontab rozbije,
// vyprší certifikát nebo někdo přehodí CRON_SECRET, portál se nezmění:
// hlídky prostě přestanou létat, lety se přestanou dotahovat a varování
// chodit. Na obrazovce to vypadá úplně stejně jako klidná noc.
//
// Proto se každý běh zapíše a přehled hlídá, že poslední není starší
// než trojnásobek intervalu. Trojnásobek, ne dvojnásobek: jeden
// vynechaný běh je běžná věc (restart, timeout), tři po sobě už ne.
// ═══════════════════════════════════════════════════════════════════

export interface CronJob {
  name: string;
  label: string;
  /** Jak často se má volat. Musí sedět s crontabem v README. */
  intervalMinutes: number;
}

export const CRON_JOBS: readonly CronJob[] = [
  { name: "patrols", label: "Plánování hlídek", intervalMinutes: 5 },
  { name: "flights", label: "Dotahování letů z DJI", intervalMinutes: 15 },
  { name: "warnings", label: "Kontrola varování", intervalMinutes: 30 },
];

/** Kolikanásobek intervalu se ještě toleruje. */
export const CRON_STALE_MULTIPLIER = 3;

/** Jak dlouho se běhy drží. Starší už nikdo nedohledává. */
export const CRON_RETENTION_DAYS = 7;

export interface CronRunSummary {
  name: string;
  /** null = endpoint ještě nikdy neběžel. */
  lastRunAt: Date | null;
}

export interface CronWarning {
  key: string;
  text: string;
}

/**
 * Které crony neběží.
 *
 * Bere seznam úloh, ne jen záznamů: úloha, po které v tabulce není ani
 * řádek, je stejný problém jako úloha zaseklá — jenom se pozná hůř.
 */
export function cronWarnings(
  runs: readonly CronRunSummary[],
  now: Date = new Date(),
  jobs: readonly CronJob[] = CRON_JOBS,
): CronWarning[] {
  const podleJmena = new Map(runs.map((run) => [run.name, run.lastRunAt]));
  const out: CronWarning[] = [];

  for (const job of jobs) {
    const last = podleJmena.get(job.name) ?? null;

    if (!last) {
      out.push({
        key: `cron_never_${job.name}`,
        text: `Automatická úloha „${job.label}“ zatím nikdy neproběhla. Bez ní se nic neplánuje ani nedotahuje.`,
      });
      continue;
    }

    const stariMs = now.getTime() - last.getTime();
    // Neplatné razítko by dalo NaN a to projde každým porovnáním jako
    // false — varování by tiše zmizelo, což je přesně ta chyba, kterou
    // tahle evidence řeší.
    if (!Number.isFinite(stariMs)) {
      out.push({
        key: `cron_unreadable_${job.name}`,
        text: `U úlohy „${job.label}“ se nedá přečíst čas posledního běhu.`,
      });
      continue;
    }

    const prahMs = job.intervalMinutes * CRON_STALE_MULTIPLIER * 60_000;
    if (stariMs <= prahMs) continue;

    out.push({
      key: `cron_stale_${job.name}`,
      text: `Automatická úloha „${job.label}“ neběžela ${formatStari(stariMs)}, přestože má jezdit každých ${job.intervalMinutes} min.`,
    });
  }

  return out;
}

/** Stáří česky, hrubě. Přesnost tu nikdo nepotřebuje. */
function formatStari(ms: number): string {
  const minut = Math.floor(ms / 60_000);
  if (minut < 90) return `${minut} min`;
  const hodin = Math.floor(minut / 60);
  if (hodin < 48) return `${hodin} h`;
  return `${Math.floor(hodin / 24)} dní`;
}
