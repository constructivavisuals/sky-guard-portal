import type { Metadata } from "next";
import Link from "next/link";
import { CalendarClock } from "lucide-react";

import { PAGE_SIZE, Pagination, pageFromParam, pageRange } from "@/components/pagination.tsx";
import { DataTable, Td, TdTight, Th, Tr } from "@/components/table.tsx";
import { EmptyState, PageHeader, Section } from "@/components/ui.tsx";
import { localDateISO, MAX_DAYS_AHEAD } from "@/lib/arrivals/rules.ts";
import { getCurrentProfile } from "@/lib/current-profile.ts";
import { formatDateTime, orDash } from "@/lib/format.ts";
import { isAdmin } from "@/lib/profile.ts";
import { getSiteSelection } from "@/lib/selected-site.ts";
import { createClient } from "@/lib/supabase/server.ts";

import { ArrivalForm, CancelArrival, type CarrierOption } from "./arrival-form.tsx";
import { ArrivalFilter, ROZSAHY, type RozsahKey } from "./filter.tsx";

export const metadata: Metadata = { title: "Ohlášené příjezdy" };

interface ArrivalRow {
  id: string;
  plate: string;
  arrival_date: string;
  note: string | null;
  night_ok: boolean;
  cancelled_at: string | null;
  created_at: string;
  carriers: { name: string } | null;
  sites: { name: string; timezone: string } | null;
  /** Vjezdy, které se na tohle ohlášení navázaly. Prázdné = zatím nic. */
  vehicle_passages: { id: string; passed_at: string }[];
}

const SELECT =
  "id, plate, arrival_date, note, night_ok, cancelled_at, created_at, " +
  "carriers(name), sites(name, timezone), vehicle_passages(id, passed_at)";

export default async function Page({ searchParams }: PageProps<"/prijezdy">) {
  const { strana, rozsah } = await searchParams;
  const page = pageFromParam(typeof strana === "string" ? strana : undefined);
  const { from, to } = pageRange(page);

  const rozsahKey: RozsahKey =
    typeof rozsah === "string" && rozsah in ROZSAHY ? (rozsah as RozsahKey) : "budouci";

  const [{ selected, selectedRow, rows: siteRows }, profile] = await Promise.all([
    getSiteSelection(),
    getCurrentProfile(),
  ]);
  const admin = isAdmin(profile);

  // Dnešek v pásmu vybrané lokality. Bez vybrané se bere pásmo té
  // první: hranice „dnes a dál“ je jedna pro celý seznam a míchat víc
  // pásem do jednoho filtru by stejně nedávalo smysl.
  const timezone = selectedRow?.timezone ?? siteRows[0]?.timezone ?? "Europe/Prague";
  const ted = new Date();
  const dnes = localDateISO(timezone, ted);

  let rows: ArrivalRow[] = [];
  let carriers: CarrierOption[] = [];
  let total = 0;
  let failed = false;

  try {
    const supabase = await createClient();

    let query = supabase
      .from("announced_arrivals")
      .select(SELECT, { count: "exact" })
      // Nejbližší příjezd nahoře u budoucích, nejnovější nahoře
      // u historie — v obou případech to, co člověka zajímá první.
      .order("arrival_date", { ascending: !ROZSAHY[rozsahKey].historie })
      .order("created_at", { ascending: false })
      .range(from, to);

    if (selected) query = query.eq("site_id", selected.id);
    if (!ROZSAHY[rozsahKey].historie) query = query.gte("arrival_date", dnes);

    const [seznam, dopravci] = await Promise.all([
      query.returns<ArrivalRow[]>(),
      // Dopravci jsou jen pro formulář, takže se tahají jen adminovi —
      // klientovi by RLS stejně vrátila prázdno.
      admin
        ? supabase
            .from("carriers")
            .select("id, name, site_id, sites(name)")
            .eq("active", true)
            .order("name")
            .returns<{ id: string; name: string; site_id: string; sites: { name: string } | null }[]>()
        : Promise.resolve({ data: [], error: null }),
    ]);

    if (seznam.error) failed = true;
    else {
      rows = seznam.data ?? [];
      total = seznam.count ?? 0;
    }

    carriers = (dopravci.data ?? [])
      .filter((carrier) => !selected || carrier.site_id === selected.id)
      .map((carrier) => ({
        id: carrier.id,
        name: carrier.name,
        siteName: carrier.sites?.name ?? "—",
      }));
  } catch {
    failed = true;
  }

  const zaklad = `/prijezdy${rozsahKey === "budouci" ? "" : `?rozsah=${rozsahKey}`}`;

  return (
    <>
      <PageHeader
        title="Ohlášené příjezdy"
        description={
          selected
            ? `Co dopravci avizovali na lokalitu ${selected.name}.`
            : "Co dopravci avizovali napříč lokalitami."
        }
        action={
          admin ? (
            <ArrivalForm
              carriers={carriers}
              today={dnes}
              maxDate={localDateISO(
                timezone,
                new Date(ted.getTime() + MAX_DAYS_AHEAD * 86_400_000),
              )}
            />
          ) : undefined
        }
      />

      <Section className="py-3 sm:py-3">
        <ArrivalFilter active={rozsahKey} />
      </Section>

      {failed ? (
        <EmptyState
          icon={<CalendarClock className="h-5 w-5" aria-hidden="true" />}
          title="Ohlášení se nepodařilo načíst"
          description="Zkuste to za chvíli znovu. Pokud potíž trvá, zkontrolujte připojení k databázi."
        />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<CalendarClock className="h-5 w-5" aria-hidden="true" />}
          title={
            ROZSAHY[rozsahKey].historie ? "Žádná ohlášení" : "Nic ohlášeného"
          }
          description={
            ROZSAHY[rozsahKey].historie
              ? "Dopravci zatím nic neohlásili."
              : "Na dnešek ani na další dny nikdo nic neohlásil. Historii zobrazíte přepínačem výš."
          }
        />
      ) : (
        <>
          <DataTable
            caption="Ohlášené příjezdy"
            head={
              <>
                <Th>Datum</Th>
                <Th>Značka</Th>
                <Th>Dopravce</Th>
                <Th>Lokalita</Th>
                <Th>Poznámka</Th>
                <Th>Noční</Th>
                <Th>Dorazilo</Th>
                {admin ? (
                  <Th className="w-12">
                    <span className="sr-only">Zrušit</span>
                  </Th>
                ) : null}
              </>
            }
          >
            {rows.map((row) => {
              const zruseno = row.cancelled_at !== null;
              const vjezd = row.vehicle_passages[0];
              return (
                <Tr key={row.id} className={zruseno ? "opacity-50" : undefined}>
                  <TdTight label="Datum" className="tabular-nums">
                    {formatDatum(row.arrival_date, row.sites?.timezone)}
                    {row.arrival_date === dnes ? (
                      <span className="ml-2 text-[var(--accent-bright)]">dnes</span>
                    ) : null}
                  </TdTight>
                  <Td label="Značka" className="font-mono">
                    {row.plate}
                  </Td>
                  <Td label="Dopravce">{orDash(row.carriers?.name)}</Td>
                  <Td label="Lokalita" className="text-[var(--text-muted)]">
                    {orDash(row.sites?.name)}
                  </Td>
                  <Td label="Poznámka" className="text-[var(--text-muted)]">
                    {orDash(row.note)}
                  </Td>
                  <Td label="Noční">
                    {row.night_ok ? (
                      <span className="text-[var(--success)]">Ano</span>
                    ) : (
                      <span className="text-[var(--text-muted)]">Ne</span>
                    )}
                  </Td>
                  <Td label="Dorazilo">
                    {zruseno ? (
                      <span className="text-[var(--text-muted)]">Zrušeno</span>
                    ) : vjezd ? (
                      // Odkaz na vjezd: z ohlášení se má dát dostat
                      // ke snímku od brány jedním klikem.
                      <Link
                        href={`/vjezdy/${vjezd.id}`}
                        className="text-[var(--accent)] hover:underline"
                      >
                        {formatDateTime(vjezd.passed_at, row.sites?.timezone)}
                      </Link>
                    ) : row.arrival_date < dnes ? (
                      // Den prošel a nikdo nedorazil. Není to chyba, ale
                      // je to jiný stav než „ještě může přijet“.
                      <span className="text-[var(--warning)]">Nedorazilo</span>
                    ) : (
                      <span className="text-[var(--text-muted)]">Čeká se</span>
                    )}
                  </Td>
                  {admin ? (
                    <Td className="text-right">
                      {zruseno ? null : <CancelArrival id={row.id} plate={row.plate} />}
                    </Td>
                  ) : null}
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

/** `YYYY-MM-DD` na „st 26. 8.“. Poledne kvůli posunu pásem. */
function formatDatum(iso: string, timeZone: string | undefined): string {
  const at = new Date(`${iso}T12:00:00Z`);
  if (Number.isNaN(at.getTime())) return iso;
  return new Intl.DateTimeFormat("cs-CZ", {
    timeZone: timeZone ?? "Europe/Prague",
    weekday: "short",
    day: "numeric",
    month: "numeric",
  }).format(at);
}
