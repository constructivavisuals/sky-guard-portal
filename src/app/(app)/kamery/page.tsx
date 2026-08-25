import type { Metadata } from "next";
import { Cctv } from "lucide-react";

import { CameraStatusBadge } from "@/components/badges.tsx";
import { DataTable, Td, TdTight, Th, Tr } from "@/components/table.tsx";
import { EmptyState, PageHeader } from "@/components/ui.tsx";
import { formatFocalLength, orDash } from "@/lib/format.ts";
import { getCurrentProfile } from "@/lib/current-profile.ts";
import { isAdmin } from "@/lib/profile.ts";
import { getSiteSelection } from "@/lib/selected-site.ts";
import { createClient } from "@/lib/supabase/server.ts";
import type { CameraStatus } from "@/types/database.ts";

import { CameraForm, type ZoneChoice } from "./camera-form.tsx";

export const metadata: Metadata = { title: "Kamery" };

interface CameraRow {
  id: string;
  site_id: string;
  zone_id: string | null;
  name: string;
  model: string | null;
  focal_mm: number | null;
  serial_number: string | null;
  status: CameraStatus;
  sites: { name: string } | null;
  zones: { name: string } | null;
}

export default async function Page() {
  const [{ selected, sites }, profile] = await Promise.all([
    getSiteSelection(),
    getCurrentProfile(),
  ]);
  // Sériová čísla jsou údaj pro správu hardwaru, ne pro klienta.
  // Skrytí je úklid obrazovky, ne bezpečnostní opatření.
  const showSerial = isAdmin(profile);
  const admin = showSerial;

  let rows: CameraRow[] = [];
  let zoneChoices: ZoneChoice[] = [];
  let failed = false;

  try {
    const supabase = await createClient();
    let query = supabase
      .from("cameras")
      .select(
        "id, site_id, zone_id, name, model, focal_mm, serial_number, status, sites(name), zones(name)",
      )
      .order("name");

    if (selected) query = query.eq("site_id", selected.id);

    const { data, error } = await query.returns<CameraRow[]>();
    if (error) failed = true;
    else rows = data ?? [];

    if (admin) {
      // Formulář nabízí zóny podle vybrané lokality, takže je potřebuje
      // všechny — ne jen ty z aktuálního filtru.
      const { data: zoneRows } = await supabase
        .from("zones")
        .select("id, name, site_id")
        .order("name")
        .returns<ZoneChoice[]>();
      zoneChoices = zoneRows ?? [];
    }
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
        action={
          admin ? <CameraForm sites={sites} zones={zoneChoices} /> : undefined
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
              {showSerial ? <Th>Sériové číslo</Th> : null}
              <Th>Stav</Th>
              {admin ? <Th className="w-12"><span className="sr-only">Úpravy</span></Th> : null}
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
              {showSerial ? (
                <TdTight className="font-mono text-xs text-[var(--text-muted)]">
                  {orDash(row.serial_number)}
                </TdTight>
              ) : null}
              <Td>
                <CameraStatusBadge status={row.status} />
              </Td>
              {admin ? (
                <Td className="text-right">
                  <CameraForm
                    sites={sites}
                    zones={zoneChoices}
                    camera={{
                      id: row.id,
                      site_id: row.site_id,
                      zone_id: row.zone_id,
                      name: row.name,
                      model: row.model,
                      serial_number: row.serial_number,
                      focal_mm: row.focal_mm,
                      status: row.status,
                    }}
                  />
                </Td>
              ) : null}
            </Tr>
          ))}
        </DataTable>
      )}
    </>
  );
}
