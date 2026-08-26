import type { Metadata } from "next";
import { FileText } from "lucide-react";

import { BlockTitle, EmptyState, Metric, PageHeader, Section } from "@/components/ui.tsx";
import { getCurrentProfile } from "@/lib/current-profile.ts";
import { formatDateTime, orDash } from "@/lib/format.ts";
import { isAdmin } from "@/lib/profile.ts";
import {
  SKIP_REASON_LABELS,
  currentMonth,
  loadMonthlyReport,
  monthPeriod,
  parseMonth,
  type MonthlyReport,
} from "@/lib/reports/data.ts";
import { getSiteSelection } from "@/lib/selected-site.ts";
import { createClient } from "@/lib/supabase/server.ts";
import { DISPATCH_OUTCOME_LABELS } from "@/types/database.ts";

import { ReportPicker } from "./picker.tsx";

export const metadata: Metadata = { title: "Reporty" };

/** Kolik měsíců zpět jde vybrat. Dál se stejně nic nezaznamenávalo. */
const MONTHS_BACK = 12;

export default async function Page({ searchParams }: PageProps<"/reporty">) {
  const { lokalita, mesic } = await searchParams;
  const [{ sites, rows }, profile] = await Promise.all([
    getSiteSelection(),
    getCurrentProfile(),
  ]);

  if (sites.length === 0) {
    return (
      <>
        <PageHeader title="Reporty" />
        <EmptyState
          icon={<FileText className="h-5 w-5" aria-hidden="true" />}
          title="Žádná lokalita"
          description="Report se dělá k lokalitě. Až vám nějakou přidělí, objeví se tady."
        />
      </>
    );
  }

  // Vybraná lokalita z adresy; jinak první, na kterou uživatel vidí.
  // Cizí id nepustí RLS, takže se jen vrátí prázdno a spadne se na první.
  const zvolena =
    (typeof lokalita === "string" && sites.find((site) => site.id === lokalita)) ||
    sites[0];
  const siteRow = rows.find((row) => row.id === zvolena.id);
  const timezone = siteRow?.timezone ?? "Europe/Prague";

  const month =
    parseMonth(typeof mesic === "string" ? mesic : null) ?? currentMonth(timezone);

  const admin = isAdmin(profile);

  let report: MonthlyReport | null = null;
  let failed = false;

  try {
    const supabase = await createClient();
    report = await loadMonthlyReport(supabase, {
      site: { id: zvolena.id, name: zvolena.name, timezone },
      month,
      includeOperations: admin,
    });
  } catch {
    failed = true;
  }

  return (
    <>
      <PageHeader
        title="Reporty"
        description="Měsíční přehled ostrahy k odeslání nebo vytištění."
      />

      <Section>
        <ReportPicker
          sites={sites}
          siteId={zvolena.id}
          month={month}
          months={nabidkaMesicu(timezone)}
        />
      </Section>

      {failed || !report ? (
        <EmptyState
          icon={<FileText className="h-5 w-5" aria-hidden="true" />}
          title="Report se nepodařilo sestavit"
          description="Zkuste to za chvíli znovu. Pokud potíž trvá, zkontrolujte připojení k databázi."
        />
      ) : (
        <Nahled report={report} />
      )}
    </>
  );
}

/** Posledních MONTHS_BACK měsíců včetně toho běžícího. */
function nabidkaMesicu(timeZone: string): { value: string; label: string }[] {
  const now = new Date();
  const out: { value: string; label: string }[] = [];

  for (let zpet = 0; zpet < MONTHS_BACK; zpet++) {
    // Přes UTC aritmetiku po měsících, ne odečítáním dní: měsíce mají
    // různou délku a odečtení 30 dní by některý přeskočilo.
    const at = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - zpet, 15, 12, 0),
    );
    const value = currentMonth(timeZone, at);
    out.push({ value, label: monthPeriod(value, timeZone).label });
  }

  return out;
}

function Nahled({ report }: { report: MonthlyReport }) {
  const { summary, passages, operations } = report;

  return (
    <>
      <Section>
        <BlockTitle>
          {report.site.name} · {report.period.label}
        </BlockTitle>
        <p className="text-sm leading-relaxed text-[var(--text-muted)]">
          {report.client.companyName
            ? `${report.client.companyName}. `
            : ""}
          Náhled ukazuje totéž, co bude v PDF — obojí čte stejná data,
          takže se čísla nemůžou rozejít.
        </p>
      </Section>

      <div className="hairline-grid grid-cols-2 lg:grid-cols-5">
        <Metric label="Detekcí">{summary.detections}</Metric>
        <Metric label="Zásahů">{summary.dispatches}</Metric>
        <Metric label="Letů">{summary.flights}</Metric>
        <Metric label="Nalétaných minut">{summary.flightMinutes}</Metric>
        <Metric
          label="Potvrzených nálezů"
          tone={summary.threats > 0 ? "danger" : undefined}
        >
          {summary.threats}
        </Metric>
      </div>

      <Section>
        <BlockTitle>Detekce po dnech</BlockTitle>
        <Graf values={report.detectionsByDay} />
      </Section>

      <Section>
        <BlockTitle>Zásahy podle výsledku</BlockTitle>
        {report.dispatchOutcomes.length === 0 ? (
          <p className="text-sm text-[var(--text-muted)]">
            Za tenhle měsíc nevznikl žádný zásah.
          </p>
        ) : (
          <dl className="text-sm">
            {report.dispatchOutcomes.map((row) => (
              <div
                key={row.outcome}
                className="flex items-center justify-between gap-4 border-b border-[var(--line)] py-2.5 last:border-b-0"
              >
                <dt className="text-[var(--text-muted)]">
                  {DISPATCH_OUTCOME_LABELS[row.outcome]}
                </dt>
                <dd className="tabular-nums">{row.count}</dd>
              </div>
            ))}
          </dl>
        )}
      </Section>

      <Section>
        <BlockTitle>Potvrzené nálezy</BlockTitle>
        {report.threats.length === 0 ? (
          <p className="text-sm text-[var(--text-muted)]">
            Model na snímcích z letů nikoho nenašel.
          </p>
        ) : (
          <ul className="text-sm">
            {report.threats.map((threat) => (
              <li
                key={threat.flightId}
                className="border-b border-[var(--line)] py-3 last:border-b-0"
              >
                <p className="tabular-nums">
                  {threat.at ? formatDateTime(threat.at, report.site.timezone) : "Bez času"}
                  {" · "}
                  <span className="text-[var(--text-muted)]">
                    {orDash(threat.zoneName)}
                  </span>
                </p>
                {threat.note ? (
                  <p className="mt-1 text-[13px] leading-relaxed text-[var(--text-muted)]">
                    {threat.note}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section last={!operations}>
        <BlockTitle>Vjezdy</BlockTitle>
        <dl className="text-sm">
          {(
            [
              ["Celkem vozidel", passages.total],
              ["Z toho ohlášených předem", passages.announced],
              ["Z toho s neznámou značkou", passages.unknownPlates],
            ] as const
          ).map(([label, value]) => (
            <div
              key={label}
              className="flex items-center justify-between gap-4 border-b border-[var(--line)] py-2.5 last:border-b-0"
            >
              <dt className="text-[var(--text-muted)]">{label}</dt>
              <dd className="tabular-nums">{value}</dd>
            </div>
          ))}
        </dl>
      </Section>

      {operations ? (
        <Section last>
          <BlockTitle>Provoz systému</BlockTitle>
          {/* Jen pro admina. Klienta nezajímá, kolikrát neběžel cron —
              zajímá ho, co se dělo v areálu. */}
          <p className="text-sm">
            Dostupnost automatiky{" "}
            <span
              className={
                (operations.availability ?? 1) < 0.9
                  ? "text-[var(--warning)]"
                  : "text-[var(--success)]"
              }
            >
              {operations.availability === null
                ? "neměřeno"
                : `${Math.round(operations.availability * 100)} %`}
            </span>
          </p>
          <p className="mt-1 text-xs leading-relaxed text-[var(--text-muted)]">
            Podíl skutečných běhů plánovače k očekávaným. Nižší číslo
            znamená, že nejel cron, ne že se něco stalo v areálu.
          </p>

          <dl className="mt-4 text-sm">
            {operations.cronRuns.map((job) => (
              <div
                key={job.name}
                className="flex items-center justify-between gap-4 border-b border-[var(--line)] py-2.5"
              >
                <dt className="text-[var(--text-muted)]">{job.label}</dt>
                <dd className="tabular-nums">
                  {job.runs} / {job.expected}
                </dd>
              </div>
            ))}
            <div className="flex items-center justify-between gap-4 border-b border-[var(--line)] py-2.5">
              <dt>Přeskočených hlídek</dt>
              <dd className="tabular-nums">{operations.skippedPatrols}</dd>
            </div>
            {operations.skipReasons.map((row) => (
              <div
                key={row.reason}
                className="flex items-center justify-between gap-4 border-b border-[var(--line)] py-2 pl-4 last:border-b-0"
              >
                <dt className="text-[var(--text-muted)]">
                  {SKIP_REASON_LABELS[row.reason] ?? row.reason}
                </dt>
                <dd className="tabular-nums text-[var(--text-muted)]">{row.count}</dd>
              </div>
            ))}
          </dl>

          {operations.skipReasons.length === 0 && operations.skippedPatrols > 0 ? (
            <p className="mt-3 text-xs text-[var(--text-muted)]">
              Důvody se u těchhle běhů ještě nezaznamenávaly.
            </p>
          ) : null}
        </Section>
      ) : null}
    </>
  );
}

/** Sloupcový graf. Stejná data i tvar jako v PDF. */
function Graf({ values }: { values: number[] }) {
  const max = Math.max(1, ...values);

  return (
    <div>
      <div className="flex h-28 items-end gap-[2px]" role="img" aria-label="Detekce po dnech">
        {values.map((value, index) => (
          <div
            key={index}
            className="min-w-0 flex-1 bg-[var(--accent)]"
            style={{ height: `${Math.max(value > 0 ? 2 : 0, (value / max) * 100)}%` }}
            title={`${index + 1}. — ${value}`}
          />
        ))}
      </div>
      <div className="mt-2 flex justify-between text-[11px] tabular-nums text-[var(--text-muted)]">
        <span>1.</span>
        <span>Nejvíc za den: {max}</span>
        <span>{values.length}.</span>
      </div>
    </div>
  );
}
