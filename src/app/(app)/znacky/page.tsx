import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ScanLine } from "lucide-react";

import { DataTable, Td, Th, Tr } from "@/components/table.tsx";
import { EmptyState, PageHeader, Section } from "@/components/ui.tsx";
import { getCurrentProfile } from "@/lib/current-profile.ts";
import { orDash } from "@/lib/format.ts";
import { isAdmin } from "@/lib/profile.ts";
import { getSiteSelection } from "@/lib/selected-site.ts";
import { createClient } from "@/lib/supabase/server.ts";
import { PLATE_LIST_TYPE_LABELS, type PlateListType } from "@/types/database.ts";

import { PlateDelete, PlateForm } from "./plate-form.tsx";

export const metadata: Metadata = { title: "Značky" };

interface PlateRow {
  id: string;
  site_id: string;
  plate: string;
  label: string | null;
  list_type: PlateListType;
  note: string | null;
  sites: { name: string } | null;
}

export default async function Page() {
  const [{ selected, sites }, profile] = await Promise.all([
    getSiteSelection(),
    getCurrentProfile(),
  ]);

  // Seznam rozhoduje o tom, jestli vzlétne dron. Klientovi ho
  // neukazujeme ani ke čtení — zámkem je RLS, tohle je jen zavřené
  // dveře místo prázdné stránky.
  if (!isAdmin(profile)) notFound();

  let rows: PlateRow[] = [];
  let failed = false;

  try {
    const supabase = await createClient();
    let query = supabase
      .from("known_plates")
      .select("id, site_id, plate, label, list_type, note, sites(name)")
      .order("list_type")
      .order("plate");

    if (selected) query = query.eq("site_id", selected.id);

    const { data, error } = await query.returns<PlateRow[]>();
    if (error) failed = true;
    else rows = data ?? [];
  } catch {
    failed = true;
  }

  return (
    <>
      <PageHeader
        title="Značky"
        description={
          selected
            ? `Známá a nežádoucí vozidla na lokalitě ${selected.name}.`
            : "Známá a nežádoucí vozidla napříč lokalitami."
        }
        action={<PlateForm sites={sites} />}
      />

      {failed ? (
        <EmptyState
          icon={<ScanLine className="h-5 w-5" aria-hidden="true" />}
          title="Značky se nepodařilo načíst"
          description="Zkuste to za chvíli znovu. Pokud potíž trvá, zkontrolujte připojení k databázi."
        />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<ScanLine className="h-5 w-5" aria-hidden="true" />}
          title="Seznam je prázdný"
          description="Dokud tu nic není, je každé vozidlo u brány neznámé a v době střežení spustí zásah."
        />
      ) : (
        <>
          <DataTable
            caption="Známé a nežádoucí značky"
            head={
              <>
                <Th>Značka</Th>
                <Th>Popisek</Th>
                <Th>Seznam</Th>
                <Th>Lokalita</Th>
                <Th>Poznámka</Th>
                <Th className="w-24">
                  <span className="sr-only">Úpravy</span>
                </Th>
              </>
            }
          >
            {rows.map((row) => (
              <Tr key={row.id}>
                <Td label="Značka" className="font-mono">
                  {row.plate}
                </Td>
                <Td label="Popisek">{orDash(row.label)}</Td>
                <Td label="Seznam">
                  <span
                    className={
                      row.list_type === "deny"
                        ? "text-[var(--danger)]"
                        : "text-[var(--success)]"
                    }
                  >
                    {PLATE_LIST_TYPE_LABELS[row.list_type]}
                  </span>
                </Td>
                <Td label="Lokalita">{orDash(row.sites?.name)}</Td>
                <Td label="Poznámka" className="text-[var(--text-muted)]">
                  {orDash(row.note)}
                </Td>
                <Td className="text-right">
                  <div className="inline-flex items-center">
                    <PlateForm
                      sites={sites}
                      plate={{
                        id: row.id,
                        site_id: row.site_id,
                        plate: row.plate,
                        label: row.label,
                        list_type: row.list_type,
                        note: row.note,
                      }}
                    />
                    <PlateDelete
                      plate={{
                        id: row.id,
                        site_id: row.site_id,
                        plate: row.plate,
                        label: row.label,
                        list_type: row.list_type,
                        note: row.note,
                      }}
                    />
                  </div>
                </Td>
              </Tr>
            ))}
          </DataTable>

          <Section className="text-xs leading-relaxed text-[var(--text-muted)]">
            Značka mimo tenhle seznam je v době střežení neznámá a spustí
            zásah na stupni vozidla. Nežádoucí ho zvedne na stupeň jako
            u osoby. Známá zásah nespouští — dron ale i tak vzlétne, protože
            v okamžiku příjezdu značku ještě nikdo nepřečetl.
          </Section>
        </>
      )}
    </>
  );
}
