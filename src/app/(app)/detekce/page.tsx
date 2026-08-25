import type { Metadata } from "next";
import { ScanEye } from "lucide-react";

import { DispatchOutcomeShortBadge, ObjectClassBadge } from "@/components/badges.tsx";
import { PAGE_SIZE, Pagination, pageFromParam, pageRange } from "@/components/pagination.tsx";
import { DataTable, Td, TdTight, Th, Tr } from "@/components/table.tsx";
import { EmptyState, PageHeader } from "@/components/ui.tsx";
import { formatConfidence, formatDateTime, orDash } from "@/lib/format.ts";
import { getSiteSelection } from "@/lib/selected-site.ts";
import { createClient } from "@/lib/supabase/server.ts";
import {
  DETECTION_SOURCE_LABELS,
  type DetectionObjectClass,
  type DetectionSource,
  type DispatchOutcome,
  type Json,
} from "@/types/database.ts";

export const metadata: Metadata = { title: "Detekce" };

interface DetectionRow {
  id: string;
  detected_at: string;
  source: DetectionSource;
  object_class: DetectionObjectClass;
  confidence: number | null;
  /** Syrová data detektoru; u dronu z nich čteme souřadnici. */
  raw: Json;
  cameras: {
    name: string;
    site_id: string;
    sites: { name: string; timezone: string } | null;
  } | null;
  zones: { name: string } | null;
  flights: {
    id: string;
    fh_task_id: string | null;
    dispatches: { site_id: string; sites: { name: string; timezone: string } | null } | null;
  } | null;
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
    const query = supabase
      .from("detections")
      .select(
        "id, detected_at, source, object_class, confidence, raw, " +
          "cameras(name, site_id, sites(name, timezone)), zones(name), " +
          "flights(id, fh_task_id, dispatches(site_id, sites(name, timezone))), " +
          "dispatches!dispatches_triggered_by_detection_fkey(outcome)",
        { count: "exact" },
      )
      .order("detected_at", { ascending: false })
      .range(from, to);

    // Dronová detekce nemá kameru, takže se přes ni filtrovat nedá.
    // `cameras!inner` by je navíc ze seznamu úplně vyřadilo, proto se
    // filtruje až po načtení — na stránce po 50 řádcích to unese.
    const siteId = selected?.id ?? null;

    const { data, count, error } = await query.returns<DetectionRow[]>();
    if (error) failed = true;
    else {
      const all = data ?? [];
      rows = siteId
        ? all.filter(
            (row) =>
              row.cameras?.site_id === siteId ||
              row.flights?.dispatches?.site_id === siteId,
          )
        : all;
      total = siteId ? rows.length : (count ?? 0);
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
                  {formatDateTime(row.detected_at, timeZoneOf(row))}
                </TdTight>
                <Td label="Lokalita">{orDash(siteNameOf(row))}</Td>
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

/** Lokalita: u kamerové přes kameru, u dronové přes let a jeho zásah. */
function siteNameOf(row: DetectionRow): string | null {
  return row.cameras?.sites?.name ?? row.flights?.dispatches?.sites?.name ?? null;
}

function timeZoneOf(row: DetectionRow): string | undefined {
  return (
    row.cameras?.sites?.timezone ?? row.flights?.dispatches?.sites?.timezone
  );
}

/**
 * Souřadnice dronové detekce. Sloupec pro ně schéma nemá, takže se
 * čtou ze syrových dat detektoru — dron je hlásí spolu s telemetrií.
 * Kdyby na ně měly jít prostorové dotazy, bude to chtít vlastní sloupec
 * geography, ne jsonb.
 */
function coordsOf(raw: Json): { latitude: number; longitude: number } | null {
  const lat = raw?.latitude;
  const lon = raw?.longitude;
  if (typeof lat !== "number" || typeof lon !== "number") return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { latitude: lat, longitude: lon };
}

/** Kamerová detekce ukazuje kameru a zónu, dronová let a souřadnici. */
function Where({ row }: { row: DetectionRow }) {
  if (row.source === "drone") {
    const point = coordsOf(row.raw);
    return (
      <div className="min-w-0">
        <p className="truncate">
          {row.flights?.fh_task_id
            ? `Let ${row.flights.fh_task_id}`
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
