import type { Metadata } from "next";
import { ScanEye } from "lucide-react";

import { DispatchOutcomeShortBadge, ObjectClassBadge } from "@/components/badges.tsx";
import { PAGE_SIZE, Pagination, pageFromParam, pageRange } from "@/components/pagination.tsx";
import { DataTable, Td, TdTight, Th, Tr } from "@/components/table.tsx";
import { EmptyState, PageHeader } from "@/components/ui.tsx";
import { formatConfidence, formatDateTime, orDash } from "@/lib/format.ts";
import { getSiteSelection } from "@/lib/selected-site.ts";
import { createClient } from "@/lib/supabase/server.ts";
import type { DetectionObjectClass, DispatchOutcome } from "@/types/database.ts";

export const metadata: Metadata = { title: "Detekce" };

interface DetectionRow {
  id: string;
  detected_at: string;
  object_class: DetectionObjectClass;
  confidence: number | null;
  cameras: {
    name: string;
    site_id: string;
    sites: { name: string; timezone: string } | null;
  } | null;
  zones: { name: string } | null;
  // Vazba dispatches.triggered_by_detection → detections.id je 1:N,
  // PostgREST proto vrací pole. Prakticky bývá nejvýš jeden.
  dispatches: { outcome: DispatchOutcome }[];
}

export default async function Page({ searchParams }: PageProps<"/detekce">) {
  const { strana } = await searchParams;
  const page = pageFromParam(typeof strana === "string" ? strana : undefined);
  const { from, to } = pageRange(page);
  const { selected } = await getSiteSelection();

  let rows: DetectionRow[] = [];
  let total = 0;
  let failed = false;

  try {
    const supabase = await createClient();
    // cameras!inner, protože se přes ně filtruje lokalita — detekce
    // samy site_id nedrží.
    let query = supabase
      .from("detections")
      .select(
        "id, detected_at, object_class, confidence, cameras!inner(name, site_id, sites(name, timezone)), zones(name), dispatches(outcome)",
        { count: "exact" },
      )
      .order("detected_at", { ascending: false })
      .range(from, to);

    if (selected) query = query.eq("cameras.site_id", selected.id);

    const { data, count, error } = await query.returns<DetectionRow[]>();
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
        title="Detekce"
        description={
          selected
            ? `Co viděly kamery na lokalitě ${selected.name}.`
            : "Co viděly kamery napříč lokalitami."
        }
      />

      {failed ? (
        <EmptyState
          icon={<ScanEye className="h-5 w-5" aria-hidden="true" />}
          title="Detekce se nepodařilo načíst"
          description="Zkuste to za chvíli znovu. Pokud potíž trvá, zkontrolujte připojení k databázi."
        />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<ScanEye className="h-5 w-5" aria-hidden="true" />}
          title="Žádné detekce"
          description="Detekce z kamer se objeví, jakmile začne ingest posílat data."
        />
      ) : (
        <>
          <DataTable
            caption="Detekce z kamer, nejnovější první"
            head={
              <>
                <Th>Čas</Th>
                <Th>Lokalita</Th>
                <Th>Zóna</Th>
                <Th>Kamera</Th>
                <Th>Objekt</Th>
                <Th className="text-right">Jistota</Th>
                <Th>Výjezd</Th>
              </>
            }
          >
            {rows.map((row) => (
              <Tr key={row.id}>
                <TdTight className="text-[var(--text-muted)]">
                  {formatDateTime(row.detected_at, row.cameras?.sites?.timezone)}
                </TdTight>
                <Td>{orDash(row.cameras?.sites?.name)}</Td>
                <Td>{orDash(row.zones?.name)}</Td>
                <Td>{orDash(row.cameras?.name)}</Td>
                <Td>
                  <ObjectClassBadge objectClass={row.object_class} />
                </Td>
                <TdTight className="text-right tabular-nums">
                  {formatConfidence(row.confidence)}
                </TdTight>
                <Td>
                  <DispatchOutcomeShortBadge
                    outcome={row.dispatches[0]?.outcome ?? null}
                  />
                </Td>
              </Tr>
            ))}
          </DataTable>
          <Pagination page={page} total={total} basePath="/detekce" size={PAGE_SIZE} />
        </>
      )}
    </>
  );
}
