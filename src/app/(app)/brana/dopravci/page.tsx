import type { Metadata } from "next";
import { Truck } from "lucide-react";

import { DataTable, Td, TdTight, Th, Tr } from "@/components/table.tsx";
import { EmptyState, PageHeader } from "@/components/ui.tsx";
import { getCurrentProfile } from "@/lib/current-profile.ts";
import { formatDateTime, orDash } from "@/lib/format.ts";
import { isAdmin } from "@/lib/profile.ts";
import { getSiteSelection } from "@/lib/selected-site.ts";
import { createClient } from "@/lib/supabase/server.ts";

import { CarrierForm, CopyLink, ToggleCarrier } from "./carrier-form.tsx";

export const metadata: Metadata = { title: "Dopravci" };

interface CarrierRow {
  id: string;
  name: string;
  contact: string | null;
  token: string;
  valid_until: string | null;
  active: boolean;
  created_at: string;
  sites: { name: string } | null;
  announced_arrivals: { count: number }[];
}

export default async function Page() {
  const [{ selected, sites }, profile] = await Promise.all([
    getSiteSelection(),
    getCurrentProfile(),
  ]);

  // Skrytí stránky není zámek — ten je v politikách na carriers, které
  // stojí na is_admin(). Neadminovi by dotaz vrátil prázdno i bez téhle
  // větve; takhle aspoň dostane větu místo prázdné tabulky.
  if (!isAdmin(profile)) {
    return (
      <>
        <PageHeader title="Dopravci" />
        <EmptyState
          icon={<Truck className="h-5 w-5" aria-hidden="true" />}
          title="Jen pro administrátora"
          description="Odkazy pro dopravce spravuje správce portálu."
        />
      </>
    );
  }

  let rows: CarrierRow[] = [];
  let failed = false;

  try {
    const supabase = await createClient();
    let query = supabase
      .from("carriers")
      .select(
        "id, name, contact, token, valid_until, active, created_at, sites(name), announced_arrivals(count)",
      )
      .order("active", { ascending: false })
      .order("name");

    if (selected) query = query.eq("site_id", selected.id);

    const { data, error } = await query.returns<CarrierRow[]>();
    if (error) failed = true;
    else rows = data ?? [];
  } catch {
    failed = true;
  }

  return (
    <>
      <PageHeader
        title="Dopravci"
        description={
          selected
            ? `Kdo smí ohlašovat příjezdy na lokalitu ${selected.name}.`
            : "Kdo smí ohlašovat příjezdy."
        }
        action={<CarrierForm sites={sites} />}
      />

      {failed ? (
        <EmptyState
          icon={<Truck className="h-5 w-5" aria-hidden="true" />}
          title="Dopravce se nepodařilo načíst"
          description="Zkuste to za chvíli znovu. Pokud potíž trvá, zkontrolujte připojení k databázi."
        />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<Truck className="h-5 w-5" aria-hidden="true" />}
          title="Žádní dopravci"
          description="Dopravce dostane odkaz, na kterém ohlásí, kdy a s jakou značkou přijede. Ohlášený příjezd pak nespustí zásah."
        />
      ) : (
        <DataTable
          caption="Dopravci a jejich odkazy"
          head={
            <>
              <Th>Firma</Th>
              <Th>Lokalita</Th>
              <Th>Kontakt</Th>
              <Th>Platnost</Th>
              <Th className="text-right">Ohlášení</Th>
              <Th>Stav</Th>
              <Th className="text-right">
                <span className="sr-only">Odkaz</span>
              </Th>
            </>
          }
        >
          {rows.map((row) => (
            <Tr key={row.id}>
              <Td label="Firma" className="font-medium">
                {row.name}
              </Td>
              <Td label="Lokalita">{orDash(row.sites?.name)}</Td>
              <Td label="Kontakt" className="text-[var(--text-muted)]">
                {orDash(row.contact)}
              </Td>
              <TdTight label="Platnost" className="text-[var(--text-muted)]">
                {row.valid_until
                  ? formatDateTime(`${row.valid_until}T12:00:00Z`).split(" ").slice(0, 3).join(" ")
                  : "Bez omezení"}
              </TdTight>
              <Td label="Ohlášení" className="text-right tabular-nums">
                {row.announced_arrivals[0]?.count ?? 0}
              </Td>
              <Td label="Stav">
                {row.active ? (
                  <span className="text-[var(--success)]">Aktivní</span>
                ) : (
                  <span className="text-[var(--text-muted)]">Vypnutý</span>
                )}
              </Td>
              <Td className="text-right">
                <span className="inline-flex items-center gap-1">
                  {/* Odkaz se dá zkopírovat, jen dokud platí — u vypnutého
                      by to bylo pozvání k tomu ho poslat dál. */}
                  {row.active ? <CopyLink token={row.token} /> : null}
                  <ToggleCarrier id={row.id} active={row.active} />
                </span>
              </Td>
            </Tr>
          ))}
        </DataTable>
      )}
    </>
  );
}
