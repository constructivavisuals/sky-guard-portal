import type { Metadata } from "next";
import Link from "next/link";
import { CarFront } from "lucide-react";

import { PlateBadge } from "@/components/badges.tsx";
import { PAGE_SIZE, Pagination, pageFromParam, pageRange } from "@/components/pagination.tsx";
import { DataTable, Td, TdTight, Th, Tr } from "@/components/table.tsx";
import { EmptyState, PageHeader, Section } from "@/components/ui.tsx";
import { formatDateTime, orDash } from "@/lib/format.ts";
import { passageVerdict } from "@/lib/plates/verdict.ts";
import { getSiteSelection } from "@/lib/selected-site.ts";
import { createClient } from "@/lib/supabase/server.ts";
import type { PlateListType } from "@/types/database.ts";

import { PassageFilter, FILTERS, type FilterKey } from "./filter.tsx";

export const metadata: Metadata = { title: "Vjezdy" };

export interface PassageRow {
  id: string;
  passed_at: string;
  plate: string | null;
  confidence: number | null;
  list_match: PlateListType | null;
  known_label: string | null;
  plate_read_at: string | null;
  detection_id: string;
  sites: { name: string; timezone: string } | null;
  cameras: { name: string } | null;
}

export default async function Page({ searchParams }: PageProps<"/vjezdy">) {
  const { strana, filtr } = await searchParams;
  const page = pageFromParam(typeof strana === "string" ? strana : undefined);
  const { from, to } = pageRange(page);

  const filterKey: FilterKey =
    typeof filtr === "string" && filtr in FILTERS ? (filtr as FilterKey) : "vse";

  const { selected } = await getSiteSelection();

  let rows: PassageRow[] = [];
  let total = 0;
  let failed = false;

  try {
    const supabase = await createClient();
    let query = supabase
      .from("vehicle_passages")
      .select(
        "id, passed_at, plate, confidence, list_match, known_label, plate_read_at, " +
          "detection_id, sites(name, timezone), cameras(name)",
        { count: "exact" },
      )
      .order("passed_at", { ascending: false })
      .range(from, to);

    if (selected) query = query.eq("site_id", selected.id);
    query = FILTERS[filterKey].apply(query);

    const { data, error, count } = await query.returns<PassageRow[]>();
    if (error) failed = true;
    else {
      rows = data ?? [];
      total = count ?? 0;
    }
  } catch {
    failed = true;
  }

  const zaklad = `/vjezdy${filterKey === "vse" ? "" : `?filtr=${filterKey}`}`;

  return (
    <>
      <PageHeader
        title="Vjezdy"
        description={
          selected
            ? `Vozidla u brány na lokalitě ${selected.name}.`
            : "Vozidla u brány napříč lokalitami."
        }
      />

      <Section className="py-3 sm:py-3">
        <PassageFilter active={filterKey} />
      </Section>

      {failed ? (
        <EmptyState
          icon={<CarFront className="h-5 w-5" aria-hidden="true" />}
          title="Vjezdy se nepodařilo načíst"
          description="Zkuste to za chvíli znovu. Pokud potíž trvá, zkontrolujte připojení k databázi."
        />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<CarFront className="h-5 w-5" aria-hidden="true" />}
          title={filterKey === "vse" ? "Žádné vjezdy" : "Nic pod tímhle filtrem"}
          description={
            filterKey === "vse"
              ? "Vjezdy se objeví, jakmile kamera u brány začne posílat data."
              : "Zkuste jiný filtr, nebo se podívejte na všechny vjezdy."
          }
        />
      ) : (
        <>
          <DataTable
            caption="Vjezdy vozidel"
            head={
              <>
                <Th>Čas</Th>
                <Th>Značka</Th>
                <Th>Vyhodnocení</Th>
                <Th>Kamera</Th>
                <Th>Lokalita</Th>
                <Th className="w-24">
                  <span className="sr-only">Detail</span>
                </Th>
              </>
            }
          >
            {rows.map((row) => {
              const verdict = passageVerdict(row);
              return (
                <Tr key={row.id}>
                  <TdTight label="Čas" className="tabular-nums">
                    {formatDateTime(row.passed_at, row.sites?.timezone ?? "Europe/Prague")}
                  </TdTight>
                  <TdTight label="Značka" className="font-mono">
                    {row.plate ?? <span className="text-[var(--text-muted)]">—</span>}
                  </TdTight>
                  <Td label="Vyhodnocení">
                    <PlateBadge verdict={verdict} label={row.known_label} />
                  </Td>
                  <Td label="Kamera">{orDash(row.cameras?.name)}</Td>
                  <Td label="Lokalita">{orDash(row.sites?.name)}</Td>
                  <Td className="text-right">
                    <Link
                      href={`/vjezdy/${row.id}`}
                      className="text-[13px] text-[var(--accent-bright)] hover:underline"
                    >
                      Detail
                    </Link>
                  </Td>
                </Tr>
              );
            })}
          </DataTable>

          <Pagination page={page} total={total} basePath={zaklad} size={PAGE_SIZE} />
        </>
      )}
    </>
  );
}
