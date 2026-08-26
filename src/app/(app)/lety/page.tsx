import type { Metadata } from "next";
import Link from "next/link";
import { Plane } from "lucide-react";

import { PAGE_SIZE, Pagination, pageFromParam, pageRange } from "@/components/pagination.tsx";
import { ThreatBadge } from "@/components/threat.tsx";
import { DataTable, Td, TdTight, Th, Tr } from "@/components/table.tsx";
import { EmptyState, PageHeader } from "@/components/ui.tsx";
import {
  durationBetween,
  formatConditions,
  formatDateTime,
  formatDuration,
  orDash,
} from "@/lib/format.ts";
import { getSiteSelection } from "@/lib/selected-site.ts";
import { createClient } from "@/lib/supabase/server.ts";
import {
  FLIGHT_KIND_LABELS,
  FLIGHT_STATUS_LABELS,
  type FlightConditions,
  type FlightKind,
  type FlightStatus,
} from "@/types/database.ts";

export const metadata: Metadata = { title: "Lety" };

export interface FlightRow {
  id: string;
  kind: FlightKind;
  started_at: string | null;
  ended_at: string | null;
  duration_s: number | null;
  status: FlightStatus;
  threat_confirmed: boolean | null;
  threat_checked_at: string | null;
  conditions: FlightConditions | null;
  sites: { name: string; timezone: string } | null;
  patrols: { id: string; name: string } | null;
  dispatches: { id: string; zones: { name: string } | null } | null;
}

const SELECT =
  "id, kind, started_at, ended_at, duration_s, status, conditions, " +
  "sites(name, timezone), patrols(id, name), dispatches(id, zones(name))";

/** Sloupce kontroly snímků přidává migrace 20260903120000. */
const SELECT_THREAT = "threat_confirmed, threat_checked_at";

export default async function Page({ searchParams }: PageProps<"/lety">) {
  const { strana } = await searchParams;
  const page = pageFromParam(typeof strana === "string" ? strana : undefined);
  const { from, to } = pageRange(page);
  const { selected } = await getSiteSelection();

  let rows: FlightRow[] = [];
  let total = 0;
  let failed = false;

  try {
    const supabase = await createClient();
    // Let zná svou lokalitu přímo (migrace 20260827180000), takže filtr
    // jde do dotazu a platí na hlídkové i zásahové stejně.
    // Dvoustupňový výběr: sloupce kontroly snímků přidává migrace,
    // která se nasazuje ručně, a PostgREST odmítne celý dotaz, když
    // jediný sloupec chybí. Bez záchytné větve by seznam letů zůstal
    // prázdný.
    const dotaz = (sloupce: string) => {
      let query = supabase
        .from("flights")
        .select(sloupce, { count: "exact" })
        .order("started_at", { ascending: false, nullsFirst: false })
        .range(from, to);
      if (selected) query = query.eq("site_id", selected.id);
      return query.returns<FlightRow[]>();
    };

    let { data, count, error } = await dotaz(`${SELECT}, ${SELECT_THREAT}`);

    if (error) {
      ({ data, count, error } = await dotaz(SELECT));
      // Bez sloupců vypadá každý let jako nezkontrolovaný, což je
      // pravda: kontrola opravdu neproběhla.
      if (data) {
        data = data.map((row) => ({
          ...row,
          threat_confirmed: null,
          threat_checked_at: null,
        }));
      }
    }

    if (error) failed = true;
    else {
      rows = data ?? [];
      total = count ?? 0;
    }
  } catch {
    failed = true;
  }

  return (
    <>
      <PageHeader
        title="Lety"
        description={
          selected
            ? `Co dron odletěl na lokalitě ${selected.name}.`
            : "Co dron odletěl napříč lokalitami."
        }
      />

      {failed ? (
        <EmptyState
          icon={<Plane className="h-5 w-5" aria-hidden="true" />}
          title="Lety se nepodařilo načíst"
          description="Zkuste to za chvíli znovu. Pokud potíž trvá, zkontrolujte připojení k databázi."
        />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<Plane className="h-5 w-5" aria-hidden="true" />}
          title="Žádné lety"
          description="Lety se objeví, jakmile odstartuje první hlídka nebo zásah."
        />
      ) : (
        <>
          <DataTable
            caption="Lety, nejnovější první"
            head={
              <>
                <Th>Start</Th>
                <Th>Typ</Th>
                <Th>Původ</Th>
                <Th className="text-right">Trvání</Th>
                <Th>Podmínky</Th>
                <Th>Nález</Th>
                <Th>Stav</Th>
              </>
            }
          >
            {rows.map((row) => (
              <Tr key={row.id} className="relative">
                <TdTight label="Start" className="text-[var(--text-muted)]">
                  {/* Odkaz roztažený přes celý řádek — klik kamkoli
                      otevře detail letu. */}
                  <Link
                    href={`/lety/${row.id}`}
                    className="after:absolute after:inset-0 after:content-[''] hover:underline"
                  >
                    {formatDateTime(row.started_at, row.sites?.timezone)}
                  </Link>
                </TdTight>
                <Td label="Typ">{FLIGHT_KIND_LABELS[row.kind]}</Td>
                <Td label="Původ">
                  <Origin row={row} />
                </Td>
                <TdTight label="Trvání" className="text-right tabular-nums">
                  {formatDuration(
                    row.duration_s ?? durationBetween(row.started_at, row.ended_at),
                  )}
                </TdTight>
                <Td label="Podmínky" className="text-[var(--text-muted)]">
                  {formatConditions(row.conditions)}
                </Td>
                <Td label="Nález">
                  <ThreatBadge state={row} />
                </Td>
                <Td label="Stav">{FLIGHT_STATUS_LABELS[row.status]}</Td>
              </Tr>
            ))}
          </DataTable>
          <Pagination page={page} total={total} basePath="/lety" size={PAGE_SIZE} />
        </>
      )}
    </>
  );
}

/**
 * Odkud let vzešel. Odkazy musí být nad překryvem řádku, jinak by je
 * spolkl — proto relative a z-10.
 */
function Origin({ row }: { row: FlightRow }) {
  const linkClass =
    "relative z-10 text-[var(--accent)] hover:underline";

  if (row.kind === "patrol") {
    return row.patrols ? (
      // Hlídka nemá vlastní detail, seznam je nejblíž tomu, co uživatel
      // hledá.
      <Link href="/hlidky" className={linkClass}>
        {row.patrols.name}
      </Link>
    ) : (
      <span className="text-[var(--text-muted)]">Hlídka smazána</span>
    );
  }

  return row.dispatches ? (
    <Link href={`/zasahy/${row.dispatches.id}`} className={linkClass}>
      Zásah — {orDash(row.dispatches.zones?.name)}
    </Link>
  ) : (
    <span className="text-[var(--text-muted)]">Ruční mise</span>
  );
}
