import type { Metadata } from "next";
import { Cctv } from "lucide-react";

import { CameraStatusBadge } from "@/components/badges.tsx";
import { DataTable, Td, TdTight, Th, Tr } from "@/components/table.tsx";
import { EmptyState, PageHeader } from "@/components/ui.tsx";
import { formatFocalLength, orDash } from "@/lib/format.ts";
import { getSiteSelection } from "@/lib/selected-site.ts";
import { createClient } from "@/lib/supabase/server.ts";
import type { CameraStatus } from "@/types/database.ts";

export const metadata: Metadata = { title: "Kamery" };

interface CameraRow {
  id: string;
  name: string;
  model: string | null;
  focal_mm: number | null;
  serial_number: string | null;
  status: CameraStatus;
  sites: { name: string } | null;
  zones: { name: string } | null;
}

export default async function Page() {
  const { selected } = await getSiteSelection();

  let rows: CameraRow[] = [];
  let failed = false;

  try {
    const supabase = await createClient();
    let query = supabase
      .from("cameras")
      .select("id, name, model, focal_mm, serial_number, status, sites(name), zones(name)")
      .order("name");

    if (selected) query = query.eq("site_id", selected.id);

    const { data, error } = await query.returns<CameraRow[]>();
    if (error) failed = true;
    else rows = data ?? [];
  } catch {
    failed = true;
  }

  return (
    <>
      <PageHeader
        title="Kamery"
        description={
          selected
            ? `Kamery na lokalitě ${selected.name} a jejich stav.`
            : "Kamery na lokalitách a jejich stav."
        }
      />

      {failed ? (
        <EmptyState
          icon={<Cctv className="h-5 w-5" aria-hidden="true" />}
          title="Kamery se nepodařilo načíst"
          description="Zkuste to za chvíli znovu. Pokud potíž trvá, zkontrolujte připojení k databázi."
        />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<Cctv className="h-5 w-5" aria-hidden="true" />}
          title="Žádné kamery"
          description="Přidejte kameru k zóně, aby mohla posílat detekce."
        />
      ) : (
        <DataTable
          caption="Kamery a jejich stav"
          head={
            <>
              <Th>Název</Th>
              <Th>Lokalita</Th>
              <Th>Zóna</Th>
              <Th>Model</Th>
              <Th className="text-right">Ohnisko</Th>
              <Th>Sériové číslo</Th>
              <Th>Stav</Th>
            </>
          }
        >
          {rows.map((row) => (
            <Tr key={row.id}>
              <Td className="font-medium">{row.name}</Td>
              <Td>{orDash(row.sites?.name)}</Td>
              <Td>{orDash(row.zones?.name)}</Td>
              <Td>{orDash(row.model)}</Td>
              <TdTight className="text-right tabular-nums">
                {formatFocalLength(row.focal_mm)}
              </TdTight>
              <TdTight className="font-mono text-xs text-[var(--text-muted)]">
                {orDash(row.serial_number)}
              </TdTight>
              <Td>
                <CameraStatusBadge status={row.status} />
              </Td>
            </Tr>
          ))}
        </DataTable>
      )}
    </>
  );
}
