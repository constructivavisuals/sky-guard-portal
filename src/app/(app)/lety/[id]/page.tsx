import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  ArrowLeft,
  CloudSun,
  Images,
  MoveUp,
  Plane,
  Route,
  Ruler,
  ScanEye,
  Send,
  Timer,
} from "lucide-react";
import type { ReactNode } from "react";

import { AreaMap } from "@/components/area-map.tsx";
import { ObjectClassBadge } from "@/components/badges.tsx";
import {
  MEDIA_COLUMNS,
  MediaGallery,
  signMedia,
  type MediaRow,
  type SignedMedia,
} from "@/components/media-gallery.tsx";
import { ThreatCallout } from "@/components/threat.tsx";
import {
  BlockTitle,
  EmptyState,
  Metric,
  PageHeader,
  Section,
} from "@/components/ui.tsx";
import {
  AREA_MAP_SITE_COLUMNS,
  loadAreaMap,
  type AreaMapData,
  type AreaMapSite,
} from "@/lib/area-map-data.ts";
import { getCurrentProfile } from "@/lib/current-profile.ts";
import { maxHeight, trajectoryPoints } from "@/lib/flights/trajectory.ts";
import {
  durationBetween,
  formatConfidence,
  formatDateTime,
  formatDuration,
  formatRainfall,
  formatTemperature,
  formatWindSpeed,
  orDash,
} from "@/lib/format.ts";
import { parsePointEwkbHex } from "@/lib/geo.ts";
import { isOperator } from "@/lib/profile.ts";
import { createClient } from "@/lib/supabase/server.ts";
import {
  FLIGHT_KIND_LABELS,
  FLIGHT_STATUS_LABELS,
  type DetectionObjectClass,
  type FlightConditions,
  type FlightKind,
  type FlightStatus,
  type Json,
} from "@/types/database.ts";

export const metadata: Metadata = { title: "Detail letu" };

interface FlightDetail {
  id: string;
  kind: FlightKind;
  started_at: string | null;
  ended_at: string | null;
  duration_s: number | null;
  distance_m: number | null;
  status: FlightStatus;
  fh_status: string | null;
  trajectory: Json;
  threat_confirmed: boolean | null;
  threat_note: string | null;
  threat_checked_at: string | null;
  conditions: FlightConditions | null;
  fh_task_uuid: string | null;
  sites: (AreaMapSite & { timezone: string }) | null;
  patrols: { id: string; name: string; wayline_uuid: string } | null;
  dispatches: {
    id: string;
    sent_at: string;
    level_sent: number;
    zones: { name: string } | null;
  } | null;
}

/** Sloupce kontroly snímků přidává migrace 20260903120000. */
const THREAT_COLUMNS = "threat_confirmed, threat_note, threat_checked_at";

const FLIGHT_COLUMNS =
  "id, kind, started_at, ended_at, duration_s, distance_m, status, fh_status, " +
  "trajectory, conditions, fh_task_uuid, " +
  `sites(id, name, timezone, dock_sn, ${AREA_MAP_SITE_COLUMNS}), ` +
  "patrols(id, name, wayline_uuid), " +
  "dispatches(id, sent_at, level_sent, zones(name))";

interface DroneDetection {
  id: string;
  detected_at: string;
  object_class: DetectionObjectClass;
  confidence: number | null;
  location: string | null;
}

export default async function Page({ params }: PageProps<"/lety/[id]">) {
  const { id } = await params;

  const profile = await getCurrentProfile();
  const showDiagnostics = isOperator(profile);

  let flight: FlightDetail | null = null;
  let detections: DroneDetection[] = [];
  let media: SignedMedia[] = [];
  let map: AreaMapData | null = null;
  let failed = false;

  try {
    const supabase = await createClient();

    // Dvoustupňový výběr: sloupce kontroly snímků přidává migrace,
    // která se nasazuje ručně. PostgREST odmítne celý dotaz, když
    // jediný sloupec chybí — a detail letu by pak nešel otevřít vůbec.
    let data: FlightDetail | null = null;
    const sKontrolou = await supabase
      .from("flights")
      .select(`${FLIGHT_COLUMNS}, ${THREAT_COLUMNS}`)
      .eq("id", id)
      .maybeSingle<FlightDetail>();

    if (sKontrolou.error) {
      const bez = await supabase
        .from("flights")
        .select(FLIGHT_COLUMNS)
        .eq("id", id)
        .maybeSingle<FlightDetail>();
      if (bez.error) failed = true;
      else if (bez.data) {
        data = {
          ...bez.data,
          threat_confirmed: null,
          threat_note: null,
          threat_checked_at: null,
        };
      }
    } else {
      data = sKontrolou.data;
    }

    flight = data;

    if (flight) {
      const [detekce, zaznam, podklad] = await Promise.all([
        // Detekce, které vznikly za tímhle letem. Kamerové sem nepatří —
        // ty visí na kameře, ne na letu.
        supabase
          .from("detections")
          .select("id, detected_at, object_class, confidence, location")
          .eq("flight_id", id)
          .eq("source", "drone")
          .order("detected_at", { ascending: true })
          .returns<DroneDetection[]>(),
        supabase
          .from("media")
          .select(MEDIA_COLUMNS)
          .eq("flight_id", id)
          // Chronologicky, jak se let odvíjel. Snímky bez razítka
          // nakonec — nemají se kam zařadit.
          .order("captured_at", { ascending: true, nullsFirst: false })
          .returns<MediaRow[]>(),
        flight.sites ? loadAreaMap(supabase, flight.sites) : Promise.resolve(null),
      ]);

      detections = detekce.data ?? [];
      map = podklad;

      const rows = zaznam.data ?? [];
      media = await signMedia(supabase, rows);
    }
  } catch {
    failed = true;
  }

  if (failed) {
    return (
      <>
        <BackLink href="/lety" label="Lety" />
        <PageHeader title="Detail letu" />
        <EmptyState
          icon={<Plane className="h-5 w-5" aria-hidden="true" />}
          title="Let se nepodařilo načíst"
          description="Zkuste to za chvíli znovu. Pokud potíž trvá, zkontrolujte připojení k databázi."
        />
      </>
    );
  }

  // RLS vrátí prázdno i tehdy, když let existuje, ale patří pod lokalitu
  // bez přístupu — pro uživatele je to totéž jako neexistuje.
  if (!flight) notFound();

  const timeZone = flight.sites?.timezone;
  const duration =
    flight.duration_s ?? durationBetween(flight.started_at, flight.ended_at);
  const track = trajectoryPoints(flight.trajectory);
  const vyska = maxHeight(track);

  return (
    <>
      <BackLink href="/lety" label="Lety" />
      <PageHeader
        title="Detail letu"
        description={`${orDash(flight.sites?.name)} · ${FLIGHT_KIND_LABELS[flight.kind]}`}
        action={
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center rounded-full border border-[var(--line)] px-3 h-8 text-xs font-medium text-[var(--text-muted)]">
              {FLIGHT_STATUS_LABELS[flight.status]}
            </span>
            {/* Stav z DJI je diagnostika: náš enum je jeho zjednodušení
                a klientovi by dvě skoro stejná slova vedle sebe nic
                neřekla. */}
            {showDiagnostics && flight.fh_status ? (
              <span
                className="inline-flex items-center rounded-full border border-[var(--line)] bg-[var(--surface-2)] px-3 h-8 font-mono text-xs text-[var(--text-muted)]"
                title="Stav úlohy doslova z FlightHubu"
              >
                DJI: {flight.fh_status}
              </span>
            ) : null}
          </div>
        }
      />

      <div className="space-y-4">
        <Section>
          <BlockTitle>Kontrola snímků</BlockTitle>
          <ThreatCallout state={flight} />
        </Section>

        {/* ── Trasa ─────────────────────────────────────────────── */}
        <Section flush className="px-5 py-5 sm:px-8 sm:py-6">
          <BlockTitle>Trasa letu</BlockTitle>
          {map ? (
            <AreaMap
              imageUrl={map.imageUrl}
              bounds={map.bounds}
              points={map.points}
              siteName={flight.sites?.name ?? "areálu"}
              track={track}
            />
          ) : (
            <p className="text-sm text-[var(--text-muted)]">
              Let nemá lokalitu, takže není na jaký podklad trasu kreslit.
            </p>
          )}

          {track.length === 0 ? (
            <p className="mt-3 text-sm text-[var(--text-muted)]">
              {flight.ended_at
                ? "Trajektorie k letu nedorazila. FlightHub ji u přerušených misí někdy nemá."
                : "Trasa se dotáhne, až let skončí."}
            </p>
          ) : null}

          <div className="mt-5 grid grid-cols-1 border-t border-[var(--line)] sm:grid-cols-3">
            <Metric
              label="Vzdálenost"
              icon={<Ruler className="h-3.5 w-3.5" aria-hidden="true" />}
              className="border-b border-[var(--line)] sm:border-b-0 sm:border-r"
            >
              {flight.distance_m === null
                ? "—"
                : `${new Intl.NumberFormat("cs-CZ", {
                    maximumFractionDigits: 0,
                  }).format(flight.distance_m)} m`}
            </Metric>
            <Metric
              label="Trvání"
              icon={<Timer className="h-3.5 w-3.5" aria-hidden="true" />}
              className="border-b border-[var(--line)] sm:border-b-0 sm:border-r"
            >
              {formatDuration(duration)}
            </Metric>
            <Metric
              label="Maximální výška"
              icon={<MoveUp className="h-3.5 w-3.5" aria-hidden="true" />}
            >
              {vyska === null
                ? "—"
                : `${new Intl.NumberFormat("cs-CZ", {
                    maximumFractionDigits: 0,
                  }).format(vyska)} m`}
            </Metric>
          </div>
          {vyska === null && track.length > 0 ? (
            <p className="mt-2 text-xs text-[var(--text-muted)]">
              Výšku dron u téhle trasy nehlásil.
            </p>
          ) : null}
        </Section>

        {/* ── Záznam ────────────────────────────────────────────── */}
        <Section>
          <div className="flex items-center gap-2">
            <Images className="h-4 w-4 text-[var(--text-muted)]" aria-hidden="true" />
            <BlockTitle>Záznam</BlockTitle>
          </div>
          <MediaGallery items={media} timeZone={timeZone} />
        </Section>

        <Section>
          <BlockTitle>Průběh</BlockTitle>
          <dl className="mt-4 space-y-2 text-sm">
            <Row label="Start">{formatDateTime(flight.started_at, timeZone)}</Row>
            <Row label="Konec">{formatDateTime(flight.ended_at, timeZone)}</Row>
            <Row label="Trvání">{formatDuration(duration)}</Row>
          </dl>
        </Section>

        <Section>
          <div className="flex items-center gap-2">
            <CloudSun className="h-4 w-4 text-[var(--text-muted)]" aria-hidden="true" />
            <BlockTitle>Podmínky</BlockTitle>
          </div>
          {flight.conditions ? (
            <>
              <dl className="mt-4 space-y-2 text-sm">
                <Row label="Vítr">{formatWindSpeed(flight.conditions.wind_speed)}</Row>
                <Row label="Srážky">{formatRainfall(flight.conditions.rainfall)}</Row>
                <Row label="Teplota">
                  {formatTemperature(flight.conditions.environment_temperature)}
                </Row>
              </dl>
              {/* Odečet je z okamžiku plánování, ne ze startu — mezi nimi
                  může být až deset minut. */}
              <p className="mt-3 text-xs text-[var(--text-muted)]">
                Odečteno z doku {formatDateTime(flight.conditions.measured_at, timeZone)}.
              </p>
            </>
          ) : (
            <p className="mt-3 text-sm text-[var(--text-muted)]">
              Dok podmínky nehlásil. U letů, které nevznikly z hlídky, se
              neodečítají vůbec.
            </p>
          )}
        </Section>

        <Section>
          <div className="flex items-center gap-2">
            {flight.kind === "patrol" ? (
              <Route className="h-4 w-4 text-[var(--text-muted)]" aria-hidden="true" />
            ) : (
              <Send className="h-4 w-4 text-[var(--text-muted)]" aria-hidden="true" />
            )}
            <BlockTitle>Původ</BlockTitle>
          </div>
          <dl className="mt-4 space-y-2 text-sm">
            {flight.kind === "patrol" ? (
              flight.patrols ? (
                <>
                  <Row label="Hlídka">
                    <Link href="/hlidky" className="text-[var(--accent)] hover:underline">
                      {flight.patrols.name}
                    </Link>
                  </Row>
                  <Row label="Trasa">
                    <span className="font-mono text-xs break-all">
                      {flight.patrols.wayline_uuid}
                    </span>
                  </Row>
                </>
              ) : (
                <Row label="Hlídka">Smazána</Row>
              )
            ) : flight.dispatches ? (
              <>
                <Row label="Zásah">
                  <Link
                    href={`/zasahy/${flight.dispatches.id}`}
                    className="text-[var(--accent)] hover:underline"
                  >
                    {formatDateTime(flight.dispatches.sent_at, timeZone)}
                  </Link>
                </Row>
                <Row label="Zóna">{orDash(flight.dispatches.zones?.name)}</Row>
                <Row label="Úroveň">{flight.dispatches.level_sent}</Row>
              </>
            ) : (
              <Row label="Původ">Ruční mise mimo portál</Row>
            )}
            {flight.fh_task_uuid && showDiagnostics ? (
              <Row label="Úloha FlightHub">
                <span className="font-mono text-xs break-all">
                  {flight.fh_task_uuid}
                </span>
              </Row>
            ) : null}
          </dl>
        </Section>

        <Section last>
          <div className="flex items-center gap-2">
            <ScanEye className="h-4 w-4 text-[var(--text-muted)]" aria-hidden="true" />
            <BlockTitle>Detekce za letu</BlockTitle>
          </div>
          {detections.length === 0 ? (
            <p className="mt-3 text-sm text-[var(--text-muted)]">
              Dron při tomhle letu nic nezaznamenal.
            </p>
          ) : (
            <ul className="mt-4 space-y-3">
              {detections.map((detection) => {
                const point = parsePointEwkbHex(detection.location);
                return (
                  <li key={detection.id} className="flex items-start gap-3">
                    <ObjectClassBadge objectClass={detection.object_class} />
                    <div className="min-w-0 text-sm">
                      <p>{formatDateTime(detection.detected_at, timeZone)}</p>
                      <p className="text-xs tabular-nums text-[var(--text-muted)]">
                        {formatConfidence(detection.confidence)}
                        {point
                          ? ` · ${point.latitude.toFixed(5)}, ${point.longitude.toFixed(5)}`
                          : ""}
                      </p>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Section>
      </div>
    </>
  );
}

function BackLink({ href, label }: { href: string; label: string }) {
  return (
    <div className="border-b border-[var(--line)] px-5 py-2.5 sm:px-8">
      <Link
        href={href}
        className="inline-flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.12em] text-[var(--text-muted)] transition hover:text-[var(--text)]"
      >
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
        {label}
      </Link>
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <dt className="shrink-0 text-[var(--text-muted)]">{label}</dt>
      <dd className="min-w-0 text-right">{children}</dd>
    </div>
  );
}
