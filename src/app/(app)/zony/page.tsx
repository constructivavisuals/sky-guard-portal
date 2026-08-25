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
    let query = supabase
      .from("zones")
      .select(
        "id, site_id, name, location, default_level, enabled, sites(name), cameras(count)",
      )
      .order("name");

    if (selected) query = query.eq("site_id", selected.id);

    const { data, error } = await query.returns<ZoneRow[]>();
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
          description="Zóna je bod, na který dron letí. Bez ní se z detekce výjezd nespustí."
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
                <Td className="font-medium">{row.name}</Td>
                <Td>{row.sites?.name ?? "—"}</Td>
                <TdTight className="text-right tabular-nums">
                  {point ? point.latitude.toFixed(5) : "—"}
                </TdTight>
                <TdTight className="text-right tabular-nums">
                  {point ? point.longitude.toFixed(5) : "—"}
                </TdTight>
                <Td className="text-center tabular-nums">{row.default_level}</Td>
                <Td className="text-right tabular-nums">{row.cameras[0]?.count ?? 0}</Td>
                <Td>
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
