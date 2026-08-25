import type { Metadata } from "next";
import { Fragment } from "react";
import { Send } from "lucide-react";

import { DispatchOutcomeBadge, LevelBadge } from "@/components/badges.tsx";
import { PAGE_SIZE, Pagination, pageFromParam, pageRange } from "@/components/pagination.tsx";
import { DataTable, Td, TdTight, Th, Tr } from "@/components/table.tsx";
import { EmptyState, PageHeader } from "@/components/ui.tsx";
import { formatDateTime, orDash } from "@/lib/format.ts";
import { getCurrentProfile } from "@/lib/current-profile.ts";
import { isAdmin } from "@/lib/profile.ts";
import { getSiteSelection } from "@/lib/selected-site.ts";
import { createClient } from "@/lib/supabase/server.ts";
import type { DispatchOutcome, Json } from "@/types/database.ts";

export const metadata: Metadata = { title: "Výjezdy" };

interface DispatchRow {
  id: string;
  sent_at: string;
  level_sent: number;
  outcome: DispatchOutcome;
  fh_incident_uuid: string | null;
  http_status: number | null;
  response: Json;
  sites: { name: string; timezone: string } | null;
  zones: { name: string } | null;
}

export default async function Page({ searchParams }: PageProps<"/vyjezdy">) {
  const { strana } = await searchParams;
  const page = pageFromParam(typeof strana === "string" ? strana : undefined);
  const { from, to } = pageRange(page);
  const [{ selected }, profile] = await Promise.all([
    getSiteSelection(),
    getCurrentProfile(),
  ]);
  // Ladicí údaje z FlightHubu klienta nezajímají a jen zaplevelují
  // tabulku. Není to bezpečnostní hranice — stránka se vykresluje na
  // serveru, takže se skrytá data do prohlížeče nedostanou, ale kdyby
  // se dostala, pořád platí, že jediná záruka je RLS.
  const showDiagnostics = isAdmin(profile);
  const columnCount = showDiagnostics ? 7 : 5;

  let rows: DispatchRow[] = [];
  let total = 0;
  let failed = false;

  try {
    const supabase = await createClient();
    let query = supabase
      .from("dispatches")
      .select(
        "id, sent_at, level_sent, outcome, fh_incident_uuid, http_status, response, sites(name, timezone), zones(name)",
        { count: "exact" },
      )
      .order("sent_at", { ascending: false })
      .range(from, to);

    if (selected) query = query.eq("site_id", selected.id);

    const { data, count, error } = await query.returns<DispatchRow[]>();
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
        title="Výjezdy"
        description={
          selected
            ? `Pokusy o výjezd na lokalitě ${selected.name} včetně potlačených.`
            : "Pokusy o výjezd dronu včetně potlačených."
        }
      />

      {failed ? (
        <EmptyState
          icon={<Send className="h-5 w-5" aria-hidden="true" />}
          title="Výjezdy se nepodařilo načíst"
          description="Zkuste to za chvíli znovu. Pokud potíž trvá, zkontrolujte připojení k databázi."
        />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<Send className="h-5 w-5" aria-hidden="true" />}
          title="Žádné výjezdy"
          description="Každý pokus o výjezd se sem zapíše — i ten potlačený nebo neúspěšný."
        />
      ) : (
        <>
          <DataTable
            caption="Pokusy o výjezd, nejnovější první"
            head={
              <>
                <Th>Čas</Th>
                <Th>Lokalita</Th>
                <Th>Zóna</Th>
                <Th className="text-center">Úroveň</Th>
                <Th>Výsledek</Th>
                {showDiagnostics ? (
                  <>
                    <Th>Incident FlightHub</Th>
                    <Th className="text-right">HTTP</Th>
                  </>
                ) : null}
              </>
            }
          >
            {rows.map((row) => (
              <Fragment key={row.id}>
              <Tr
                className={
                  row.outcome === "failed" && showDiagnostics ? "border-b-0" : ""
                }
              >
                <TdTight className="text-[var(--text-muted)]">
                  {formatDateTime(row.sent_at, row.sites?.timezone)}
                </TdTight>
                <Td>{orDash(row.sites?.name)}</Td>
                <Td>{orDash(row.zones?.name)}</Td>
                <Td className="text-center">
                  <LevelBadge level={row.level_sent} />
                </Td>
                <Td>
                  <DispatchOutcomeBadge outcome={row.outcome} />
                </Td>
                {showDiagnostics ? (
                  <>
                    {/* UUID se láme, ne posouvá — jinak jediný dlouhý
                        řetězec roztáhne celou tabulku. */}
                    <Td className="font-mono text-xs break-all text-[var(--text-muted)]">
                      {orDash(row.fh_incident_uuid)}
                    </Td>
                    <TdTight className="text-right tabular-nums">
                      {row.http_status ?? "—"}
                    </TdTight>
                  </>
                ) : null}
              </Tr>
              {/* Detail dostává vlastní řádek přes celou šířku — v buňce
                  by surová odpověď roztáhla sloupec „Výsledek“. Rozbaluje
                  se jen u selhaných, jinde není co ukazovat. */}
              {row.outcome === "failed" && showDiagnostics ? (
                <Tr>
                  <Td colSpan={columnCount} className="pt-0">
                    <details>
                      <summary className="cursor-pointer text-xs text-[var(--text-muted)] hover:text-[var(--text)]">
                        Detail chyby
                      </summary>
                      <pre className="mt-2 overflow-x-auto rounded-lg border border-[var(--border)] bg-[var(--bg)] p-3 text-xs leading-relaxed text-[var(--text-muted)]">
                        {JSON.stringify(row.response, null, 2)}
                      </pre>
                    </details>
                  </Td>
                </Tr>
              ) : null}
              </Fragment>
            ))}
          </DataTable>
          <Pagination page={page} total={total} basePath="/vyjezdy" size={PAGE_SIZE} />
        </>
      )}
    </>
  );
}
