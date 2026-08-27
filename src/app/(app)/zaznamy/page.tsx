import type { Metadata } from "next";
import { Video } from "lucide-react";

import { Pagination, pageFromParam, pageRange } from "@/components/pagination.tsx";
import { DataTable, Td, TdTight, Th, Tr } from "@/components/table.tsx";
import { EmptyState, PageHeader } from "@/components/ui.tsx";
import { formatBytes, formatDateTime, orDash } from "@/lib/format.ts";
import {
  RECORDING_BUCKET,
  RECORDING_SIGNED_URL_TTL,
  recordingPlayback,
  type RecordingPlayback,
} from "@/lib/recordings/storage.ts";
import { getSiteSelection } from "@/lib/selected-site.ts";
import { createClient } from "@/lib/supabase/server.ts";

export const metadata: Metadata = { title: "Záznamy" };

// Záznamy ze stavebních kamer.
//
// Zatím jen seznam — je to obrazovka, na které se po montáži ověřuje,
// že řetěz kamera → relay → portál → úložiště opravdu šlape. Osa dne
// a přehrávač v detailu přijdou později; tohle je to, co k ověření
// stačí a bez čeho by se muselo do SQL Editoru.

interface RecordingRow {
  id: string;
  started_at: string;
  ended_at: string | null;
  event_type: string | null;
  size_bytes: number | null;
  storage_path: string | null;
  uploaded_at: string | null;
  video_expired_at: string | null;
  cameras: {
    name: string;
    serial_number: string | null;
    sites: { name: string; timezone: string } | null;
  } | null;
}

/** Co se dá s řádkem dělat a jak se to jmenuje. */
const STAV: Record<RecordingPlayback, { label: string; tone: string }> = {
  ready: { label: "Nahráno", tone: "text-[var(--success)]" },
  pending: { label: "Přenáší se", tone: "text-[var(--warning)]" },
  expired: { label: "Po lhůtě", tone: "text-[var(--text-muted)]" },
  missing: { label: "Bez souboru", tone: "text-[var(--danger)]" },
};

const EVENT_LABELS: Record<string, string> = {
  motion: "Pohyb",
  regular: "Průběžný",
  alarm: "Alarm",
  intelligent: "Analytika",
};

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ strana?: string }>;
}) {
  const { strana } = await searchParams;
  const page = pageFromParam(strana);
  const { from, to } = pageRange(page);
  const { selected } = await getSiteSelection();

  let rows: RecordingRow[] = [];
  let total = 0;
  let failed = false;
  /** Podepsané adresy k nahraným souborům, podle cesty. */
  const odkazy = new Map<string, string>();

  try {
    const supabase = await createClient();

    // Záznam nezná lokalitu přímo, visí na kameře — filtr proto jde
    // přes vnořený výběr. RLS platí stejně: read_camera_recordings
    // pouští jen záznamy z lokalit, na které uživatel vidí.
    let query = supabase
      .from("camera_recordings")
      .select(
        "id, started_at, ended_at, event_type, size_bytes, storage_path, " +
          "uploaded_at, video_expired_at, " +
          "cameras!inner(name, serial_number, sites!inner(name, timezone))",
        { count: "exact" },
      )
      .order("started_at", { ascending: false })
      .range(from, to);

    if (selected) query = query.eq("cameras.site_id", selected.id);

    const { data, count, error } = await query.returns<RecordingRow[]>();
    if (error) failed = true;
    else {
      rows = data ?? [];
      total = count ?? 0;

      // Jedno volání na celou stránku, ne jedno na řádek. Podepisuje se
      // klientem přihlášeného uživatele, takže o přístupu k souboru
      // rozhoduje politika nad storage.objects, ne tenhle kód.
      const cesty = rows
        .filter((row) => recordingPlayback(row) === "ready" && row.storage_path)
        .map((row) => row.storage_path as string);

      if (cesty.length > 0) {
        const { data: podepsane } = await supabase.storage
          .from(RECORDING_BUCKET)
          .createSignedUrls(cesty, RECORDING_SIGNED_URL_TTL);

        for (const item of podepsane ?? []) {
          if (item.path && item.signedUrl) odkazy.set(item.path, item.signedUrl);
        }
      }
    }
  } catch {
    failed = true;
  }

  return (
    <>
      <PageHeader
        title="Záznamy"
        description={
          selected
            ? `Co natočily kamery na lokalitě ${selected.name}.`
            : "Co natočily stavební kamery napříč lokalitami."
        }
      />

      {failed ? (
        <EmptyState
          icon={<Video className="h-5 w-5" aria-hidden="true" />}
          title="Záznamy se nepodařilo načíst"
          description="Zkuste to za chvíli znovu. Pokud potíž trvá, zkontrolujte připojení k databázi."
        />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<Video className="h-5 w-5" aria-hidden="true" />}
          title="Žádné záznamy"
          description="Záznam se objeví, jakmile kamera pošle první soubor na relay. Když kamera hlásí a tady nic není, podívejte se do logu watcheru."
        />
      ) : (
        <>
          <DataTable
            caption="Záznamy ze stavebních kamer, nejnovější první"
            head={
              <>
                <Th>Čas</Th>
                <Th>Kamera</Th>
                <Th>Lokalita</Th>
                <Th>Událost</Th>
                <Th className="text-right">Velikost</Th>
                <Th>Stav</Th>
                <Th className="w-24"><span className="sr-only">Video</span></Th>
              </>
            }
          >
            {rows.map((row) => {
              const stav = recordingPlayback(row);
              const odkaz = row.storage_path ? odkazy.get(row.storage_path) : undefined;
              const timeZone = row.cameras?.sites?.timezone;

              return (
                <Tr key={row.id}>
                  <TdTight label="Čas" className="text-[var(--text-muted)]">
                    {formatDateTime(row.started_at, timeZone)}
                  </TdTight>
                  <Td label="Kamera">
                    <span className="font-medium">{orDash(row.cameras?.name)}</span>
                    {/* Sériové číslo je to, podle čeho se kamera páruje —
                        při montáži je první, co se ověřuje. */}
                    {row.cameras?.serial_number ? (
                      <span className="mt-0.5 block font-mono text-xs text-[var(--text-muted)]">
                        {row.cameras.serial_number}
                      </span>
                    ) : null}
                  </Td>
                  <Td label="Lokalita" className="text-[var(--text-muted)]">
                    {orDash(row.cameras?.sites?.name)}
                  </Td>
                  <Td label="Událost">
                    {row.event_type
                      ? (EVENT_LABELS[row.event_type] ?? row.event_type)
                      : "—"}
                  </Td>
                  <TdTight label="Velikost" className="text-right tabular-nums">
                    {formatBytes(row.size_bytes)}
                  </TdTight>
                  <Td label="Stav">
                    <span className={STAV[stav].tone}>{STAV[stav].label}</span>
                  </Td>
                  <Td className="text-right">
                    {odkaz ? (
                      // Podepsaná adresa platí krátce; otevírá se v nové
                      // kartě, ať se nepřijde o rozdělanou stránku.
                      <a
                        href={odkaz}
                        target="_blank"
                        rel="noreferrer"
                        className="text-[var(--accent-bright)] hover:underline"
                      >
                        Přehrát
                      </a>
                    ) : null}
                  </Td>
                </Tr>
              );
            })}
          </DataTable>

          <Pagination page={page} total={total} basePath="/zaznamy" />
        </>
      )}
    </>
  );
}
