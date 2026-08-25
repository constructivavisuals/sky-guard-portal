import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  ArrowLeft,
  CloudSun,
  Images,
  Plane,
  Route,
  ScanEye,
  Send,
  Sparkles,
} from "lucide-react";
import type { ReactNode } from "react";

import { ObjectClassBadge } from "@/components/badges.tsx";
import { Card, EmptyState, PageHeader } from "@/components/ui.tsx";
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
import { createClient } from "@/lib/supabase/server.ts";
import {
  FLIGHT_KIND_LABELS,
  FLIGHT_STATUS_LABELS,
  type DetectionObjectClass,
  type FlightConditions,
  type FlightKind,
  type FlightStatus,
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
  conditions: FlightConditions | null;
  fh_task_uuid: string | null;
  sites: { name: string; timezone: string } | null;
  patrols: { id: string; name: string; wayline_uuid: string } | null;
  dispatches: {
    id: string;
    sent_at: string;
    level_sent: number;
    zones: { name: string } | null;
  } | null;
}

interface DroneDetection {
  id: string;
  detected_at: string;
  object_class: DetectionObjectClass;
  confidence: number | null;
  location: string | null;
}

export default async function Page({ params }: PageProps<"/lety/[id]">) {
  const { id } = await params;

  let flight: FlightDetail | null = null;
  let detections: DroneDetection[] = [];
  let failed = false;

  try {
    const supabase = await createClient();
    const { data, error } = await supabase
      .from("flights")
      .select(
        "id, kind, started_at, ended_at, duration_s, distance_m, status, conditions, fh_task_uuid, " +
          "sites(name, timezone), patrols(id, name, wayline_uuid), " +
          "dispatches(id, sent_at, level_sent, zones(name))",
      )
      .eq("id", id)
      .maybeSingle<FlightDetail>();

    if (error) failed = true;
    else flight = data;

    if (flight) {
      // Detekce, které vznikly za tímhle letem. Kamerové sem nepatří —
      // ty visí na kameře, ne na letu.
      const { data: rows } = await supabase
        .from("detections")
        .select("id, detected_at, object_class, confidence, location")
        .eq("flight_id", id)
        .eq("source", "drone")
        .order("detected_at", { ascending: true })
        .returns<DroneDetection[]>();
      detections = rows ?? [];
    }
  } catch {
    failed = true;
  }

  if (failed) {
    return (
      <>
        <BackLink />
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

  return (
    <>
      <BackLink />
      <PageHeader
        title="Detail letu"
        description={`${orDash(flight.sites?.name)} · ${FLIGHT_KIND_LABELS[flight.kind]}`}
        action={
          <span className="inline-flex items-center rounded-full border border-[var(--border)] px-3 h-8 text-xs font-medium text-[var(--text-muted)]">
            {FLIGHT_STATUS_LABELS[flight.status]}
          </span>
        }
      />

      <div className="space-y-4">
        <Card className="p-5">
          <h2 className="text-sm font-medium text-[var(--text-muted)]">Průběh</h2>
          <dl className="mt-4 space-y-2 text-sm">
            <Row label="Start">{formatDateTime(flight.started_at, timeZone)}</Row>
            <Row label="Konec">{formatDateTime(flight.ended_at, timeZone)}</Row>
            <Row label="Trvání">{formatDuration(duration)}</Row>
            {flight.distance_m !== null ? (
              <Row label="Vzdálenost">
                {new Intl.NumberFormat("cs-CZ", {
                  maximumFractionDigits: 0,
                }).format(flight.distance_m)}{" "}
                m
              </Row>
            ) : null}
          </dl>
        </Card>

        <Card className="p-5">
          <div className="flex items-center gap-2">
            <CloudSun className="h-4 w-4 text-[var(--text-muted)]" aria-hidden="true" />
            <h2 className="text-sm font-medium text-[var(--text-muted)]">Podmínky</h2>
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
        </Card>

        <Card className="p-5">
          <div className="flex items-center gap-2">
            {flight.kind === "patrol" ? (
              <Route className="h-4 w-4 text-[var(--text-muted)]" aria-hidden="true" />
            ) : (
              <Send className="h-4 w-4 text-[var(--text-muted)]" aria-hidden="true" />
            )}
            <h2 className="text-sm font-medium text-[var(--text-muted)]">Původ</h2>
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
            {flight.fh_task_uuid ? (
              <Row label="Úloha FlightHub">
                <span className="font-mono text-xs break-all">
                  {flight.fh_task_uuid}
                </span>
              </Row>
            ) : null}
          </dl>
        </Card>

        <Card className="p-5">
          <div className="flex items-center gap-2">
            <ScanEye className="h-4 w-4 text-[var(--text-muted)]" aria-hidden="true" />
            <h2 className="text-sm font-medium text-[var(--text-muted)]">
              Detekce za letu
            </h2>
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
        </Card>

        {/* Trajektorie a média — místo v detailu, obsah přijde z DJI. */}
        <Card className="p-5 opacity-60">
          <div className="flex items-center gap-2">
            <Images className="h-4 w-4 text-[var(--text-muted)]" aria-hidden="true" />
            <h2 className="text-sm font-medium text-[var(--text-muted)]">
              Trajektorie a záznam
            </h2>
          </div>
          <p className="mt-3 text-sm text-[var(--text-muted)]">
            Trasa letu na mapě a pořízené snímky se doplní, až se budou
            tahat data z DJI FlightHub.
          </p>
          <p className="mt-2 inline-flex items-center gap-1.5 text-xs text-[var(--text-muted)]">
            <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
            Připravovaný krok
          </p>
        </Card>
      </div>
    </>
  );
}

function BackLink() {
  return (
    <Link
      href="/lety"
      className="mb-4 inline-flex items-center gap-1.5 text-sm text-[var(--text-muted)] transition hover:text-[var(--text)]"
    >
      <ArrowLeft className="h-4 w-4" aria-hidden="true" />
      Zpět na lety
    </Link>
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
