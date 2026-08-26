import type { Metadata } from "next";
import Link from "next/link";
import { ScanEye } from "lucide-react";

import { DispatchOutcomeShortBadge, ObjectClassBadge } from "@/components/badges.tsx";
import { PAGE_SIZE, Pagination, pageFromParam, pageRange } from "@/components/pagination.tsx";
import { DataTable, Td, TdTight, Th, Tr } from "@/components/table.tsx";
import { EmptyState, PageHeader } from "@/components/ui.tsx";
import { formatConfidence, formatDateTime, orDash } from "@/lib/format.ts";
import { parsePointEwkbHex } from "@/lib/geo.ts";
import { getSiteSelection } from "@/lib/selected-site.ts";
import { createClient } from "@/lib/supabase/server.ts";
import {
  DETECTION_SOURCE_LABELS,
  type DetectionObjectClass,
  type DetectionSource,
  type DispatchOutcome,
} from "@/types/database.ts";

export const metadata: Metadata = { title: "Detekce" };

interface DetectionRow {
  id: string;
  detected_at: string;
  source: DetectionSource;
  object_class: DetectionObjectClass;
  confidence: number | null;
  /** geography(Point) jako hex EWKB. Vyplněné jen u dronových. */
  location: string | null;
  sites: { name: string; timezone: string } | null;
  cameras: { name: string } | null;
  zones: { name: string } | null;
  flights: { id: string; fh_task_uuid: string | null } | null;
  // Vazba dispatches.triggered_by_detection → detections.id je 1:N,
  // PostgREST proto vrací pole. Prakticky bývá nejvýš jeden.
  dispatches: { id: string; outcome: DispatchOutcome }[];
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
    // Detekce zná svou lokalitu přímo (migrace 20260825180000), takže
    // filtr jde rovnou do dotazu a platí na kamerové i dronové stejně.
    // Dřív se muselo dofiltrovávat po načtení, protože dronová detekce
    // nemá kameru, přes kterou se filtrovalo.
    let query = supabase
      .from("detections")
      .select(
        "id, detected_at, source, object_class, confidence, location, " +
          "sites(name, timezone), cameras(name), zones(name), " +
          "flights(id, fh_task_uuid), " +
          "dispatches!dispatches_triggered_by_detection_fkey(id, outcome)",
        { count: "exact" },
      )
      .order("detected_at", { ascending: false })
      .range(from, to);

    if (selected) query = query.eq("site_id", selected.id);

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
            ? `Co viděly kamery a drony na lokalitě ${selected.name}.`
            : "Co viděly kamery a drony napříč lokalitami."
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
          description="Detekce se objeví, jakmile začne ingest posílat data z kamer nebo z dronu."
        />
      ) : (
        <>
          <DataTable
            caption="Detekce, nejnovější první"
            head={
              <>
                <Th>Čas</Th>
                <Th>Lokalita</Th>
                <Th>Zdroj</Th>
                <Th>Kde</Th>
                <Th>Objekt</Th>
                <Th className="text-right">Jistota</Th>
                <Th>Zásah</Th>
              </>
            }
          >
            {rows.map((row) => (
              <Tr key={row.id}>
                <TdTight label="Čas" className="text-[var(--text-muted)]">
                  {formatDateTime(row.detected_at, row.sites?.timezone)}
                </TdTight>
                <Td label="Lokalita">{orDash(row.sites?.name)}</Td>
                <Td label="Zdroj">{DETECTION_SOURCE_LABELS[row.source]}</Td>
                <Td label="Kde">
                  <Where row={row} />
                </Td>
                <Td label="Objekt">
                  <ObjectClassBadge objectClass={row.object_class} />
                </Td>
                <TdTight label="Jistota" className="text-right tabular-nums">
                  {formatConfidence(row.confidence)}
                </TdTight>
                <Td label="Zásah">
                  {/* Odznak vede na detail zásahu. Ten už vypráví celý
                      příběh detekce — kameru, zónu, rozhodnutí i let —
                      takže seznam detekcí nemusí mít vlastní detail
                      a přestal být slepou uličkou. */}
                  <DispatchLink dispatch={row.dispatches[0] ?? null} />
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

/** Kamerová detekce ukazuje kameru a zónu, dronová let a souřadnici. */
function Where({ row }: { row: DetectionRow }) {
  if (row.source === "drone") {
    // Poloha má od migrace 20260825180000 vlastní sloupec geography;
    // PostgREST ji vrací jako hex EWKB, ne GeoJSON.
    const point = parsePointEwkbHex(row.location);
    return (
      <div className="min-w-0">
        <p className="truncate">
          {row.flights?.fh_task_uuid
            ? `Let ${row.flights.fh_task_uuid}`
            : "Let bez označení"}
        </p>
        <p className="text-xs tabular-nums text-[var(--text-muted)]">
          {point
            ? `${point.latitude.toFixed(5)}, ${point.longitude.toFixed(5)}`
            : "Bez souřadnic"}
        </p>
      </div>
    );
  }

  return (
    <div className="min-w-0">
      <p className="truncate">{orDash(row.cameras?.name)}</p>
      <p className="truncate text-xs text-[var(--text-muted)]">
        {orDash(row.zones?.name)}
      </p>
    </div>
  );
}

/**
 * Odznak výsledku, u zásahu jako odkaz.
 *
 * Bez zásahu odkaz nikam nevede a zůstává jen odznak: detekce mimo
 * ostrý režim nebo z kamery bez zóny žádný řádek v dispatches nemá.
 */
function DispatchLink({
  dispatch,
}: {
  dispatch: { id: string; outcome: DispatchOutcome } | null;
}) {
  if (!dispatch) return <DispatchOutcomeShortBadge outcome={null} />;

  return (
    <Link
      href={`/zasahy/${dispatch.id}`}
      className="inline-flex rounded-[var(--radius-pill)] transition hover:opacity-80"
    >
      <DispatchOutcomeShortBadge outcome={dispatch.outcome} />
    </Link>
  );
}
