import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  ArrowLeft,
  Crosshair,
  ExternalLink,
  MapPin,
  Plane,
  ScanEye,
  Send,
  Sparkles,
} from "lucide-react";
import type { ReactNode } from "react";

import { DispatchOutcomeBadge, LevelBadge, ObjectClassBadge } from "@/components/badges.tsx";
import { Card, EmptyState, IconBadge, PageHeader } from "@/components/ui.tsx";
import { getCurrentProfile } from "@/lib/current-profile.ts";
import {
  explainLevel,
  explainOutcome,
  mapUrl,
} from "@/lib/dispatch/explain.ts";
import {
  formatArmedDays,
  formatArmedWindow,
  formatConfidence,
  formatDateTime,
  orDash,
} from "@/lib/format.ts";
import { parsePointEwkbHex } from "@/lib/geo.ts";
import { isOperator } from "@/lib/profile.ts";
import { createClient } from "@/lib/supabase/server.ts";
import type {
  DetectionObjectClass,
  DispatchOutcome,
  IsoWeekday,
  Json,
} from "@/types/database.ts";

export const metadata: Metadata = { title: "Detail zásahu" };

interface DispatchDetail {
  id: string;
  sent_at: string;
  level_sent: number;
  outcome: DispatchOutcome;
  fh_incident_uuid: string | null;
  http_status: number | null;
  response: Json;
  sites: {
    name: string;
    timezone: string;
    armed_from: string;
    armed_to: string;
    armed_days: IsoWeekday[];
    cooldown_seconds: number;
  } | null;
  zones: { name: string; location: string | null } | null;
  detections: {
    id: string;
    detected_at: string;
    object_class: DetectionObjectClass;
    confidence: number | null;
    cameras: { name: string } | null;
    zones: { name: string } | null;
  } | null;
}

export default async function Page({ params }: PageProps<"/zasahy/[id]">) {
  const { id } = await params;

  const [profile] = await Promise.all([getCurrentProfile()]);
  const showDiagnostics = isOperator(profile);

  let dispatch: DispatchDetail | null = null;
  let failed = false;

  try {
    const supabase = await createClient();
    const { data, error } = await supabase
      .from("dispatches")
      .select(
        "id, sent_at, level_sent, outcome, fh_incident_uuid, http_status, response, " +
          "sites(name, timezone, armed_from, armed_to, armed_days, cooldown_seconds), " +
          "zones(name, location), " +
          "detections!dispatches_triggered_by_detection_fkey(id, detected_at, object_class, confidence, cameras(name), zones(name))",
      )
      .eq("id", id)
      .maybeSingle<DispatchDetail>();

    if (error) failed = true;
    else dispatch = data;
  } catch {
    failed = true;
  }

  if (failed) {
    return (
      <>
        <BackLink />
        <PageHeader title="Detail zásahu" />
        <EmptyState
          icon={<Send className="h-5 w-5" aria-hidden="true" />}
          title="Zásah se nepodařilo načíst"
          description="Zkuste to za chvíli znovu. Pokud potíž trvá, zkontrolujte připojení k databázi."
        />
      </>
    );
  }

  // RLS vrátí prázdno i tehdy, když zásah existuje, ale patří pod
  // lokalitu bez přístupu — pro uživatele je to totéž jako neexistuje.
  if (!dispatch) notFound();

  const site = dispatch.sites;
  const zone = dispatch.zones;
  const detection = dispatch.detections;
  const timeZone = site?.timezone;
  const point = parsePointEwkbHex(zone?.location ?? null);

  const level = explainLevel(detection?.object_class ?? null, dispatch.level_sent);
  const outcome = explainOutcome(dispatch.outcome, {
    armedWindow: site ? formatArmedWindow(site.armed_from, site.armed_to) : undefined,
    armedDays: site ? formatArmedDays(site.armed_days) : undefined,
    cooldownSeconds: site?.cooldown_seconds,
  });

  return (
    <>
      <BackLink />
      <PageHeader
        title="Detail zásahu"
        description={`${orDash(site?.name)} · ${orDash(zone?.name)}`}
        action={<DispatchOutcomeBadge outcome={dispatch.outcome} />}
      />

      <ol className="space-y-0">
        {/* ── Detekce ─────────────────────────────────────────── */}
        <Step
          icon={<ScanEye className="h-5 w-5" aria-hidden="true" />}
          title="Detekce"
          time={detection ? formatDateTime(detection.detected_at, timeZone) : null}
        >
          {detection ? (
            <Facts
              items={[
                ["Kamera", orDash(detection.cameras?.name)],
                ["Zóna", orDash(detection.zones?.name)],
                [
                  "Objekt",
                  <ObjectClassBadge key="o" objectClass={detection.object_class} />,
                ],
                ["Jistota", formatConfidence(detection.confidence)],
              ]}
            />
          ) : (
            <p className="text-sm text-[var(--text-muted)]">
              Zásah nevznikl z detekce — spustil ho někdo ručně z portálu.
              Kamera, zóna ani jistota k němu proto nejsou.
            </p>
          )}
        </Step>

        {/* ── Rozhodnutí ──────────────────────────────────────── */}
        <Step
          icon={<Crosshair className="h-5 w-5" aria-hidden="true" />}
          title="Rozhodnutí"
        >
          <div className="flex items-center gap-3">
            <LevelBadge level={dispatch.level_sent} />
            <span className="text-sm">
              {level.escalated ? "Eskalováno" : "Bez eskalace"}
            </span>
          </div>
          <p className="mt-2 text-sm text-[var(--text-muted)]">{level.text}</p>
          <p className="mt-3 text-sm font-medium">{outcome.title}</p>
          <p className="mt-1 text-sm text-[var(--text-muted)]">{outcome.text}</p>
          {/* Databáze si důvod rozhodnutí neukládá — dopočítává se ze
              stejných pravidel, podle kterých ingest rozhodoval. */}
          <p className="mt-3 text-xs text-[var(--text-muted)]">
            Odvozeno z nastavení lokality a třídy objektu; databáze si
            samotné rozhodnutí neukládá.
          </p>
        </Step>

        {/* ── Odeslání ────────────────────────────────────────── */}
        <Step
          icon={<Send className="h-5 w-5" aria-hidden="true" />}
          title="Odeslání do FlightHubu"
          time={formatDateTime(dispatch.sent_at, timeZone)}
        >
          {showDiagnostics ? (
            <Facts
              items={[
                [
                  "Incident",
                  <span key="i" className="font-mono text-xs break-all">
                    {orDash(dispatch.fh_incident_uuid)}
                  </span>,
                ],
                ["HTTP", dispatch.http_status ?? "—"],
              ]}
            />
          ) : null}

          {dispatch.outcome === "failed" && showDiagnostics ? (
            <details className="mt-3">
              <summary className="cursor-pointer text-xs text-[var(--text-muted)] hover:text-[var(--text)]">
                Detail chyby
              </summary>
              <pre className="mt-2 max-w-full overflow-x-auto rounded-lg border border-[var(--border)] bg-[var(--bg)] p-3 text-xs leading-relaxed text-[var(--text-muted)]">
                {JSON.stringify(dispatch.response, null, 2)}
              </pre>
            </details>
          ) : null}

          {!showDiagnostics ? (
            <p className="text-sm text-[var(--text-muted)]">
              Zásah byl {dispatch.outcome === "sent" ? "odeslán" : "zpracován"}{" "}
              {formatDateTime(dispatch.sent_at, timeZone)}.
            </p>
          ) : null}
        </Step>

        {/* ── Místo ───────────────────────────────────────────── */}
        <Step icon={<MapPin className="h-5 w-5" aria-hidden="true" />} title="Místo">
          {point ? (
            <>
              <Facts
                items={[
                  ["Zóna", orDash(zone?.name)],
                  ["Šířka", point.latitude.toFixed(5)],
                  ["Délka", point.longitude.toFixed(5)],
                ]}
              />
              <a
                href={mapUrl(point.latitude, point.longitude)}
                target="_blank"
                rel="noreferrer noopener"
                className="mt-3 inline-flex items-center gap-1.5 text-sm text-[var(--accent)] hover:underline"
              >
                Otevřít v mapě
                <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
              </a>
            </>
          ) : (
            <p className="text-sm text-[var(--text-muted)]">
              Zóna nemá zadané souřadnice, takže dron nemá kam letět.
            </p>
          )}
        </Step>

        {/* ── Let a záznam — zatím prázdné místo v ose ─────────── */}
        <Step
          icon={<Plane className="h-5 w-5" aria-hidden="true" />}
          title="Let a záznam"
          muted
          last
        >
          <p className="text-sm text-[var(--text-muted)]">
            Trasa letu, doba a pořízené snímky se doplní, až se budou tahat
            data z DJI FlightHub.
          </p>
          <p className="mt-2 inline-flex items-center gap-1.5 text-xs text-[var(--text-muted)]">
            <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
            Připravovaný krok
          </p>
        </Step>
      </ol>
    </>
  );
}

function BackLink() {
  return (
    <Link
      href="/zasahy"
      className="mb-4 inline-flex items-center gap-1.5 text-sm text-[var(--text-muted)] transition hover:text-[var(--text)]"
    >
      <ArrowLeft className="h-4 w-4" aria-hidden="true" />
      Zpět na zásahy
    </Link>
  );
}

/** Jeden krok svislé časové osy. */
function Step({
  icon,
  title,
  time,
  muted,
  last,
  children,
}: {
  icon: ReactNode;
  title: string;
  time?: string | null;
  muted?: boolean;
  last?: boolean;
  children: ReactNode;
}) {
  return (
    <li className="relative flex gap-4 pb-6 last:pb-0">
      {/* Svislice mezi kroky. U posledního se nekreslí, aby osa
          nekončila čárou do prázdna. */}
      {!last ? (
        <span
          aria-hidden="true"
          className="absolute left-5 top-10 bottom-0 w-px bg-[var(--border)]"
        />
      ) : null}

      <div className={muted ? "opacity-50" : undefined}>
        <IconBadge tone="accent">{icon}</IconBadge>
      </div>

      <Card className={`min-w-0 flex-1 p-4 ${muted ? "opacity-60" : ""}`}>
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <h2 className="text-sm font-medium">{title}</h2>
          {time ? (
            <span className="text-xs tabular-nums text-[var(--text-muted)]">
              {time}
            </span>
          ) : null}
        </div>
        <div className="mt-3">{children}</div>
      </Card>
    </li>
  );
}

/** Dvojice popisek–hodnota, na mobilu pod sebou. */
function Facts({ items }: { items: [string, ReactNode][] }) {
  return (
    <dl className="space-y-1.5 text-sm">
      {items.map(([label, value]) => (
        <div key={label} className="flex items-start justify-between gap-4">
          <dt className="shrink-0 text-[var(--text-muted)]">{label}</dt>
          <dd className="min-w-0 text-right">{value}</dd>
        </div>
      ))}
    </dl>
  );
}
