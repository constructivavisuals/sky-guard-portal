import type { Metadata } from "next";
import { Cctv } from "lucide-react";

import { CameraStatusBadge } from "@/components/badges.tsx";
import { DataTable, Td, TdTight, Th, Tr } from "@/components/table.tsx";
import { EmptyState, Section } from "@/components/ui.tsx";
import { formatFocalLength, orDash } from "@/lib/format.ts";
import { getCurrentProfile } from "@/lib/current-profile.ts";
import { parsePointEwkbHex } from "@/lib/geo.ts";
import { isAdmin } from "@/lib/profile.ts";
import { createClient } from "@/lib/supabase/server.ts";
import type { CameraStatus } from "@/types/database.ts";

import { nactiAreal } from "../site.ts";
import { CameraForm, type ZoneChoice } from "./camera-form.tsx";

export const metadata: Metadata = { title: "Kamery" };

// Karta „Kamery“ areálu. Dřív globální seznam s filtrem podle lokality;
// ten filtr je teď součástí cesty.

interface CameraRow {
  id: string;
  site_id: string;
  zone_id: string | null;
  name: string;
  model: string | null;
  focal_mm: number | null;
  serial_number: string | null;
  /** EWKB hex; formulář ho rozebírá na šířku a délku. */
  location: string | null;
  azimuth: number | null;
  status: CameraStatus;
  sites: { name: string } | null;
  zones: { name: string } | null;
}

export default async function Page({ params }: PageProps<"/arealy/[id]/kamery">) {
  const { id } = await params;
  const [{ site }, profile] = await Promise.all([nactiAreal(id), getCurrentProfile()]);

  // Layout už na chybějící areál odpověděl.
  if (!site) return null;
  const sites = [{ id: site.id, name: site.name }];
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
        "id, site_id, zone_id, name, model, focal_mm, serial_number, location, azimuth, status, " +
          "sites(name), zones(name)",
      )
      .order("name");

    query = query.eq("site_id", id);

    const { data, error } = await query.returns<CameraRow[]>();
    if (error) failed = true;
    else rows = data ?? [];

    if (admin) {
      // Jen zóny tohohle areálu: kamera z jiné lokality do formuláře
      // nepatří a dřív se nabízely všechny.
      const { data: zoneRows } = await supabase
        .from("zones")
        .select("id, name, site_id")
        .eq("site_id", id)
        .order("name")
        .returns<ZoneChoice[]>();
      zoneChoices = zoneRows ?? [];
    }
  } catch {
    failed = true;
  }

  return (
    <>
      <Section className="py-3 sm:py-3">
        <div className="flex items-center justify-between gap-4">
          <p className="text-sm text-[var(--text-muted)]">
            Kamery areálu a jejich stav. Kamera bez zóny detekuje, ale zásah z ní nevznikne.
          </p>
          {admin ? <CameraForm sites={sites} zones={zoneChoices} /> : null}
        </div>
      </Section>

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
              <Td label="Název" className="font-medium">{row.name}</Td>
              <Td label="Zóna">{orDash(row.zones?.name)}</Td>
              <Td label="Model">{orDash(row.model)}</Td>
              <TdTight label="Ohnisko" className="text-right tabular-nums">
                {formatFocalLength(row.focal_mm)}
              </TdTight>
              {showSerial ? (
                <TdTight label="Sériové číslo" className="font-mono text-xs text-[var(--text-muted)]">
                  {orDash(row.serial_number)}
                </TdTight>
              ) : null}
              <Td label="Stav">
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
                      latitude: parsePointEwkbHex(row.location)?.latitude ?? null,
                      longitude: parsePointEwkbHex(row.location)?.longitude ?? null,
                      azimuth: row.azimuth,
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
