import type { Metadata } from "next";
import { Video } from "lucide-react";

import { Pagination, pageFromParam, pageRange } from "@/components/pagination.tsx";
import { DataTable, Td, TdTight, Th, Tr } from "@/components/table.tsx";
import { EmptyState, PageHeader, Section } from "@/components/ui.tsx";
import { localDateISO } from "@/lib/arrivals/rules.ts";
import {
  dayRange,
  isDayString,
  isMonthString,
  monthOf,
  type DayString,
  type MonthString,
} from "@/lib/recordings/timeline.ts";
import { formatBytes, formatDateTime, orDash } from "@/lib/format.ts";
import {
  recordingMediaHref,
  recordingPlayback,
  type RecordingPlayback,
} from "@/lib/recordings/storage.ts";
import { getSiteSelection } from "@/lib/selected-site.ts";
import { createClient } from "@/lib/supabase/server.ts";

import { CameraFilter, RecordingCalendar, zaznamyHref, type CameraOption } from "./filters.tsx";
import { DayTimeline } from "./timeline.tsx";

export const metadata: Metadata = { title: "Záznamy" };

// Záznamy ze stavebních kamer.
//
// Zatím jen seznam — je to obrazovka, na které se po montáži ověřuje,
// že řetěz kamera → relay → portál → úložiště opravdu šlape. Osa dne
// a přehrávač v detailu přijdou později; tohle je to, co k ověření
// stačí a bez čeho by se muselo do SQL Editoru.

interface RecordingRow {
  id: string;
  camera_id: string;
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
  searchParams: Promise<{
    strana?: string;
    kamera?: string;
    den?: string;
    mesic?: string;
  }>;
}) {
  const { strana, kamera, den, mesic } = await searchParams;
  const page = pageFromParam(strana);
  const { from, to } = pageRange(page);
  const { selected, selectedRow } = await getSiteSelection();

  // Kalendář i osa dne stojí na pásmu lokality, takže dávají smysl jen
  // u jedné vybrané. U „všech lokalit“ by se míchaly dny z různých
  // pásem, což by mlčky lhalo — zůstane prostý seznam.
  const timeZone = selectedRow?.timezone;
  const kalendar = Boolean(selected && timeZone);

  const kameraId = typeof kamera === "string" && kamera ? kamera : null;
  const vybranyDen: DayString | null = isDayString(den) ? den : null;
  const dnes = timeZone ? localDateISO(timeZone) : null;
  const mesicKalendare: MonthString = isMonthString(mesic)
    ? mesic
    : (vybranyDen ? monthOf(vybranyDen) : (dnes ? monthOf(dnes) : "2026-01"));

  const rozsah = vybranyDen && timeZone ? dayRange(vybranyDen, timeZone) : null;

  let rows: RecordingRow[] = [];
  let total = 0;
  let failed = false;
  let cameras: CameraOption[] = [];
  const pocty = new Map<DayString, number>();

  try {
    const supabase = await createClient();

    // Záznam nezná lokalitu přímo, visí na kameře — filtr proto jde
    // přes vnořený výběr. RLS platí stejně: read_camera_recordings
    // pouští jen záznamy z lokalit, na které uživatel vidí.
    let query = supabase
      .from("camera_recordings")
      .select(
        "id, camera_id, started_at, ended_at, event_type, size_bytes, storage_path, " +
          "uploaded_at, video_expired_at, " +
          "cameras!inner(name, serial_number, sites!inner(name, timezone))",
        { count: "exact" },
      )
      .order("started_at", { ascending: false });

    if (selected) query = query.eq("cameras.site_id", selected.id);
    if (kameraId) query = query.eq("camera_id", kameraId);

    if (rozsah) {
      // Den se filtruje na hranicích lokality, ne na UTC půlnoci.
      // Stránkování u dne nedává smysl — den je konečný.
      query = query
        .gte("started_at", rozsah.from.toISOString())
        .lt("started_at", rozsah.to.toISOString());
    } else {
      query = query.range(from, to);
    }

    const { data, count, error } = await query.returns<RecordingRow[]>();
    if (error) failed = true;
    else {
      rows = data ?? [];
      total = count ?? 0;

      // Adresy se tu UŽ NEPODEPISUJÍ. Video leží v Hetzneru, kde žádná
      // RLS není, takže se na ně odkazuje přes /api/media — ten pod RLS
      // ověří řádek a teprve pak podepíše. Bokem to ušetřilo hromadné
      // podepisování celé stránky souborů, ze kterých si uživatel
      // pustí většinou jeden.
    }

    // Kamery do filtru a počty do kalendáře. Obojí jen u vybrané
    // lokality; napříč lokalitami by to byl seznam bez konce.
    if (kalendar && selected) {
      const [{ data: cameraRows }, { data: dayRows }] = await Promise.all([
        supabase
          .from("cameras")
          .select("id, name, serial_number")
          .eq("site_id", selected.id)
          .eq("ingest_mode", "ftp")
          .order("name")
          .returns<CameraOption[]>(),
        supabase.rpc("camera_recording_day_counts", {
          p_site_id: selected.id,
          p_camera_id: kameraId,
        }),
      ]);

      cameras = cameraRows ?? [];
      for (const row of (dayRows ?? []) as { day: string; recordings: number }[]) {
        pocty.set(row.day, Number(row.recordings));
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
            : "Co natočily stavební kamery napříč lokalitami. Kalendář a osa dne dávají smysl jen u jedné lokality — přepněte ji v liště."
        }
        action={
          vybranyDen ? (
            <a
              href={zaznamyHref({ kamera: kameraId, mesic: mesicKalendare })}
              className="text-sm text-[var(--accent-bright)] hover:underline"
            >
              Zrušit den
            </a>
          ) : undefined
        }
      />

      {kalendar ? (
        <Section className="py-4 sm:py-4">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <CameraFilter
              cameras={cameras}
              active={kameraId}
              den={vybranyDen}
              mesic={mesicKalendare}
            />
            <div className="lg:w-[19rem] lg:shrink-0">
              <RecordingCalendar
                month={mesicKalendare}
                counts={pocty}
                selectedDay={vybranyDen}
                kamera={kameraId}
                today={dnes ?? ""}
              />
            </div>
          </div>
        </Section>
      ) : null}

      {failed ? (
        <EmptyState
          icon={<Video className="h-5 w-5" aria-hidden="true" />}
          title="Záznamy se nepodařilo načíst"
          description="Zkuste to za chvíli znovu. Pokud potíž trvá, zkontrolujte připojení k databázi."
        />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<Video className="h-5 w-5" aria-hidden="true" />}
          title={vybranyDen ? "V ten den se nic nenatočilo" : "Žádné záznamy"}
          description={
            vybranyDen
              ? "Vyberte jiný den v kalendáři. Dny se záznamy jsou zvýrazněné a nesou počet."
              : "Záznam se objeví, jakmile kamera pošle první soubor na relay. Když kamera hlásí a tady nic není, podívejte se do logu watcheru."
          }
        />
      ) : (
        <>
          {rozsah && vybranyDen ? (
            <DayTimeline
              day={vybranyDen}
              rows={rows}
              range={rozsah}
              timeZone={timeZone}
            />
          ) : null}

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
              const odkaz =
                stav === "ready" && row.storage_path
                  ? recordingMediaHref(row.storage_path)
                  : undefined;
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

          {/* Den je konečný, takže se nestránkuje. */}
          {vybranyDen ? null : (
            <Pagination page={page} total={total} basePath="/zaznamy" />
          )}
        </>
      )}
    </>
  );
}
