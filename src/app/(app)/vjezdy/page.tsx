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
  /** Ohlášení, kterému vjezd odpovídal. Migrace 20260906120000. */
  announced_arrivals: { id: string; night_ok: boolean; carriers: { name: string } | null } | null;
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

    // Dvoustupňový výběr: announced_arrivals přidává migrace
    // 20260906120000 a PostgREST odmítne celý dotaz, když jediný
    // sloupec chybí. Bez záchytné větve by seznam vjezdů zůstal prázdný.
    const ZAKLAD =
      "id, passed_at, plate, confidence, list_match, known_label, plate_read_at, " +
      "detection_id, sites(name, timezone), cameras(name)";
    const S_OHLASENIM =
      `${ZAKLAD}, announced_arrivals(id, night_ok, carriers(name))`;

    const dotaz = (sloupce: string) => {
      let query = supabase
        .from("vehicle_passages")
        .select(sloupce, { count: "exact" })
        .order("passed_at", { ascending: false })
        .range(from, to);

      if (selected) query = query.eq("site_id", selected.id);
      return FILTERS[filterKey].apply(query).returns<PassageRow[]>() as unknown as Promise<{
        data: PassageRow[] | null;
        error: { message: string } | null;
        count: number | null;
      }>;
    };

    let vysledek = await dotaz(S_OHLASENIM);

    if (vysledek.error) {
      const bez = await dotaz(ZAKLAD);
      // Bez sloupce vypadá každý vjezd jako neohlášený, což je pravda:
      // ohlášení se do něj zatím nemá jak dostat.
      vysledek = {
        ...bez,
        data: (bez.data ?? []).map((row) => ({ ...row, announced_arrivals: null })),
      } as typeof vysledek;
    }

    if (vysledek.error) failed = true;
    else {
      rows = vysledek.data ?? [];
      total = vysledek.count ?? 0;
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
                <Th>Ohlášeno</Th>
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
                  <Td label="Ohlášeno">
                    <AnnouncedCell row={row} />
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

/**
 * Byl vjezd předem ohlášený?
 *
 * Rozlišuje se i to, jestli ohlášení platilo na noc — denní ohlášení
 * v době střežení zásah nezastaví a v seznamu to musí být vidět, jinak
 * by vypadalo jako chyba, že dron vzlétl.
 */
function AnnouncedCell({ row }: { row: PassageRow }) {
  const arrival = row.announced_arrivals;
  if (!arrival) {
    return <span className="text-[var(--text-muted)]">—</span>;
  }

  const dopravce = arrival.carriers?.name;
  return (
    <span className="inline-flex flex-col">
      <span className={arrival.night_ok ? "text-[var(--success)]" : "text-[var(--text)]"}>
        {arrival.night_ok ? "Ano, i v noci" : "Ano, jen ve dne"}
      </span>
      {dopravce ? (
        <span className="text-xs text-[var(--text-muted)]">{dopravce}</span>
      ) : null}
    </span>
  );
}
