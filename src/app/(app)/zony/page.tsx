import type { Metadata } from "next";
import { Radar } from "lucide-react";

import { DataTable, Td, TdTight, Th, Tr } from "@/components/table.tsx";
import { EmptyState, PageHeader } from "@/components/ui.tsx";
import { getCurrentProfile } from "@/lib/current-profile.ts";
import { parsePointEwkbHex } from "@/lib/geo.ts";
import { isAdmin } from "@/lib/profile.ts";
import { getSiteSelection } from "@/lib/selected-site.ts";
import { createClient } from "@/lib/supabase/server.ts";

import { ZoneForm } from "./zone-form.tsx";

export const metadata: Metadata = { title: "Zóny" };

interface ZoneRow {
  id: string;
  site_id: string;
  name: string;
  location: string | null;
  wayline_uuid: string | null;
  default_level: number;
  enabled: boolean;
  sites: { name: string } | null;
  cameras: { count: number }[];
}

export default async function Page() {
  const [{ selected, sites }, profile] = await Promise.all([
    getSiteSelection(),
    getCurrentProfile(),
  ]);
  const admin = isAdmin(profile);

  let rows: ZoneRow[] = [];
  let failed = false;

  try {
    const supabase = await createClient();
    const dotaz = (sloupce: string) => {
      let query = supabase.from("zones").select(sloupce).order("name");
      if (selected) query = query.eq("site_id", selected.id);
      return query.returns<ZoneRow[]>();
    };

    // Dvoustupňový výběr: wayline_uuid přidává migrace 20260903180000,
    // která se nasazuje ručně, a PostgREST odmítne celý dotaz, když
    // jediný sloupec chybí. Bez záchytné větve by seznam zón zůstal
    // prázdný.
    const SLOUPCE = "id, site_id, name, location, default_level, enabled, sites(name), cameras(count)";
    let { data, error } = await dotaz(`${SLOUPCE}, wayline_uuid`);

    if (error) {
      ({ data, error } = await dotaz(SLOUPCE));
      if (data) data = data.map((row) => ({ ...row, wayline_uuid: null }));
    }

    if (error) failed = true;
    else rows = data ?? [];
  } catch {
    failed = true;
  }

  return (
    <>
      <PageHeader
        title="Zóny"
        description={
          selected
            ? `Hlídané body na lokalitě ${selected.name}.`
            : "Hlídané body perimetru napříč lokalitami."
        }
        action={admin ? <ZoneForm sites={sites} /> : undefined}
      />

      {failed ? (
        <EmptyState
          icon={<Radar className="h-5 w-5" aria-hidden="true" />}
          title="Zóny se nepodařilo načíst"
          description="Zkuste to za chvíli znovu. Pokud potíž trvá, zkontrolujte připojení k databázi."
        />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<Radar className="h-5 w-5" aria-hidden="true" />}
          title="Žádné zóny"
          description="Zóna je bod, na který dron letí. Bez ní se z detekce zásah nespustí."
        />
      ) : (
        <DataTable
          caption="Zóny perimetru"
          head={
            <>
              <Th>Název</Th>
              <Th>Lokalita</Th>
              <Th className="text-right">Šířka</Th>
              <Th className="text-right">Délka</Th>
              <Th>Trasa</Th>
              <Th className="text-center">Úroveň</Th>
              <Th className="text-right">Kamery</Th>
              <Th>Stav</Th>
              {admin ? <Th className="w-12"><span className="sr-only">Úpravy</span></Th> : null}
            </>
          }
        >
          {rows.map((row) => {
            const point = parsePointEwkbHex(row.location);
            return (
              <Tr key={row.id}>
                <Td label="Název" className="font-medium">{row.name}</Td>
                <Td label="Lokalita">{row.sites?.name ?? "—"}</Td>
                <TdTight label="Šířka" className="text-right tabular-nums">
                  {point ? point.latitude.toFixed(5) : "—"}
                </TdTight>
                <TdTight label="Délka" className="text-right tabular-nums">
                  {point ? point.longitude.toFixed(5) : "—"}
                </TdTight>
                <Td label="Trasa">
                  {/* Bez trasy zásah z téhle zóny neodejde. Oranžová,
                      ne červená: nic se nerozbilo, jen to někdo musí
                      doplnit — týž význam jako u kamery bez zóny. */}
                  {row.wayline_uuid ? (
                    <span className="font-mono text-xs break-all">{row.wayline_uuid}</span>
                  ) : (
                    <span className="text-[var(--warning)]">Bez trasy</span>
                  )}
                </Td>
                <Td label="Úroveň" className="text-center tabular-nums">{row.default_level}</Td>
                <Td label="Kamery" className="text-right tabular-nums">{row.cameras[0]?.count ?? 0}</Td>
                <Td label="Stav">
                  {row.enabled ? (
                    <span className="text-[var(--success)]">Zapnutá</span>
                  ) : (
                    <span className="text-[var(--text-muted)]">Vypnutá</span>
                  )}
                </Td>
                {admin ? (
                  <Td className="text-right">
                    <ZoneForm
                      sites={sites}
                      zone={{
                        id: row.id,
                        site_id: row.site_id,
                        name: row.name,
                        latitude: point?.latitude ?? null,
                        longitude: point?.longitude ?? null,
                        wayline_uuid: row.wayline_uuid,
                        default_level: row.default_level,
                        enabled: row.enabled,
                      }}
                    />
                  </Td>
                ) : null}
              </Tr>
            );
          })}
        </DataTable>
      )}
    </>
  );
}
