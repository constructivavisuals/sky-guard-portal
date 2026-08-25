import type { Metadata } from "next";
import { Route } from "lucide-react";

import { DataTable, Td, TdTight, Th, Tr } from "@/components/table.tsx";
import { EmptyState, PageHeader } from "@/components/ui.tsx";
import { getCurrentProfile } from "@/lib/current-profile.ts";
import { listWaylines, type Wayline } from "@/lib/dispatch/flighthub.ts";
import { formatArmedDays, formatArmedWindow, orDash, plural } from "@/lib/format.ts";
import { isAdmin } from "@/lib/profile.ts";
import { getSiteSelection } from "@/lib/selected-site.ts";
import { createClient } from "@/lib/supabase/server.ts";
import type { IsoWeekday } from "@/types/database.ts";

import { PatrolForm } from "./patrol-form.tsx";

export const metadata: Metadata = { title: "Hlídky" };

interface PatrolRow {
  id: string;
  site_id: string;
  name: string;
  wayline_uuid: string;
  enabled: boolean;
  window_from: string;
  window_to: string;
  days: IsoWeekday[];
  interval_minutes: number;
  sites: { name: string; dock_sn: string | null } | null;
}

export default async function Page() {
  const [{ selected, sites }, profile] = await Promise.all([
    getSiteSelection(),
    getCurrentProfile(),
  ]);
  const admin = isAdmin(profile);

  let rows: PatrolRow[] = [];
  let failed = false;
  let waylines: Wayline[] = [];
  let waylineError: string | null = null;

  try {
    const supabase = await createClient();
    let query = supabase
      .from("patrols")
      .select(
        "id, site_id, name, wayline_uuid, enabled, window_from, window_to, days, interval_minutes, sites(name, dock_sn)",
      )
      .order("name");

    if (selected) query = query.eq("site_id", selected.id);

    const { data, error } = await query.returns<PatrolRow[]>();
    if (error) failed = true;
    else rows = data ?? [];

    // Trasy se tahají jen adminovi — nikdo jiný formulář neuvidí,
    // takže by to bylo volání do FlightHubu pro nic.
    if (admin) {
      const result = await listWaylines();
      if (result.ok) waylines = result.waylines;
      else waylineError = result.message;
    }
  } catch {
    failed = true;
  }

  return (
    <>
      <PageHeader
        title="Hlídky"
        description={
          selected
            ? `Pravidelné oblety na lokalitě ${selected.name}.`
            : "Pravidelné oblety napříč lokalitami."
        }
        action={
          admin ? (
            <PatrolForm sites={sites} waylines={waylines} waylineError={waylineError} />
          ) : undefined
        }
      />

      {failed ? (
        <EmptyState
          icon={<Route className="h-5 w-5" aria-hidden="true" />}
          title="Hlídky se nepodařilo načíst"
          description="Zkuste to za chvíli znovu. Pokud potíž trvá, zkontrolujte připojení k databázi."
        />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<Route className="h-5 w-5" aria-hidden="true" />}
          title="Žádné hlídky"
          description="Hlídka je předpis, podle kterého dron pravidelně obletí zadanou trasu."
        />
      ) : (
        <DataTable
          caption="Naplánované hlídky"
          head={
            <>
              <Th>Název</Th>
              <Th>Lokalita</Th>
              <Th>Okno</Th>
              <Th>Dny</Th>
              <Th className="text-right">Interval</Th>
              <Th>Stav</Th>
              {admin ? (
                <Th className="w-12">
                  <span className="sr-only">Úpravy</span>
                </Th>
              ) : null}
            </>
          }
        >
          {rows.map((row) => (
            <Tr key={row.id}>
              <Td label="Název" className="font-medium">
                {row.name}
              </Td>
              <Td label="Lokalita">
                {orDash(row.sites?.name)}
                {/* Bez sériového čísla docku nemá cron kam let poslat. */}
                {row.sites && !row.sites.dock_sn ? (
                  <span className="block text-xs text-[var(--warning)]">
                    Lokalita nemá sériové číslo docku
                  </span>
                ) : null}
              </Td>
              <TdTight label="Okno">
                {formatArmedWindow(row.window_from, row.window_to)}
              </TdTight>
              <Td label="Dny">{formatArmedDays(row.days)}</Td>
              <TdTight label="Interval" className="text-right tabular-nums">
                {plural(row.interval_minutes, "minuta", "minuty", "minut")}
              </TdTight>
              <Td label="Stav">
                {row.enabled ? (
                  <span className="text-[var(--success)]">Zapnutá</span>
                ) : (
                  <span className="text-[var(--text-muted)]">Vypnutá</span>
                )}
              </Td>
              {admin ? (
                <Td className="text-right">
                  <PatrolForm
                    sites={sites}
                    waylines={waylines}
                    waylineError={waylineError}
                    patrol={{
                      id: row.id,
                      site_id: row.site_id,
                      name: row.name,
                      wayline_uuid: row.wayline_uuid,
                      enabled: row.enabled,
                      window_from: row.window_from,
                      window_to: row.window_to,
                      days: row.days,
                      interval_minutes: row.interval_minutes,
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
