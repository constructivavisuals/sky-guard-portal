import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  ArrowLeft,
  ArrowRight,
  Crosshair,
  ExternalLink,
  MapPin,
  Plane,
  ScanEye,
  Send,
} from "lucide-react";
import type { ReactNode } from "react";

import { DispatchOutcomeBadge, LevelBadge, ObjectClassBadge } from "@/components/badges.tsx";
import {
  MEDIA_COLUMNS,
  MediaGallery,
  signMedia,
  type MediaRow,
  type SignedMedia,
} from "@/components/media-gallery.tsx";
import { ThreatCallout } from "@/components/threat.tsx";
import {
  EmptyState,
  IconBadge,
  PageHeader,
} from "@/components/ui.tsx";
import { getCurrentProfile } from "@/lib/current-profile.ts";
import {
  conditionsFromReason,
  explainLevel,
  explainOutcome,
  levelFromReason,
  mapUrl,
} from "@/lib/dispatch/explain.ts";
import { ARRIVAL_RADIUS_M, arrivalAt, trajectoryPoints } from "@/lib/flights/trajectory.ts";
import {
  durationBetween,
  formatArmedDays,
  formatArmedWindow,
  formatConfidence,
  formatDateTime,
  formatDuration,
  orDash,
} from "@/lib/format.ts";
import { parsePointEwkbHex } from "@/lib/geo.ts";
import { isOperator } from "@/lib/profile.ts";
import { createClient } from "@/lib/supabase/server.ts";
import {
  FLIGHT_STATUS_LABELS,
  isDispatchSuppressed,
  type DecisionReason,
  type DetectionObjectClass,
  type DispatchOutcome,
  type FlightStatus,
  type IsoWeekday,
  type Json,
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
  decision_reason: DecisionReason | null;
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

interface DispatchFlight {
  id: string;
  started_at: string | null;
  ended_at: string | null;
  duration_s: number | null;
  status: FlightStatus;
  trajectory: Json;
  threat_confirmed: boolean | null;
  threat_note: string | null;
  threat_checked_at: string | null;
}

/**
 * Kolik náhledů se v ose zásahu ukáže.
 *
 * Osa je přehled, ne archiv — celá galerie patří do detailu letu
 * a odkaz na ni je hned vedle.
 */
const MEDIA_NAHLEDU = 3;

const FLIGHT_BASE =
  "id, started_at, ended_at, duration_s, status, trajectory";
/** Sloupce kontroly snímků přidává migrace 20260903120000. */
const FLIGHT_THREAT = "threat_confirmed, threat_note, threat_checked_at";

export default async function Page({ params }: PageProps<"/zasahy/[id]">) {
  const { id } = await params;

  const [profile] = await Promise.all([getCurrentProfile()]);
  const showDiagnostics = isOperator(profile);

  let dispatch: DispatchDetail | null = null;
  /** Kdo poslal ruční zásah. null, když ho nepodepsal nikdo čitelný. */
  let actor: string | null = null;
  let flight: DispatchFlight | null = null;
  let media: SignedMedia[] = [];
  let failed = false;

  try {
    const supabase = await createClient();
    const { data, error } = await supabase
      .from("dispatches")
      .select(
        "id, sent_at, level_sent, outcome, fh_incident_uuid, http_status, response, decision_reason, " +
          "sites(name, timezone, armed_from, armed_to, armed_days, cooldown_seconds), " +
          "zones(name, location), " +
          "detections!dispatches_triggered_by_detection_fkey(id, detected_at, object_class, confidence, cameras(name), zones(name))",
      )
      .eq("id", id)
      .maybeSingle<DispatchDetail>();

    if (error) failed = true;
    else dispatch = data;

    if (dispatch) {
      // Let se dohledává zvlášť, ne vnořeným výběrem: sloupce kontroly
      // snímků přidává nenasazená migrace a PostgREST odmítne celý
      // dotaz, když jediný chybí. Takhle přijde o obsah jen tenhle krok
      // osy, ne celá stránka.
      const sKontrolou = await supabase
        .from("flights")
        .select(`${FLIGHT_BASE}, ${FLIGHT_THREAT}`)
        .eq("dispatch_id", id)
        .order("started_at", { ascending: true, nullsFirst: false })
        .limit(1)
        .maybeSingle<DispatchFlight>();

      if (sKontrolou.error) {
        const bez = await supabase
          .from("flights")
          .select(FLIGHT_BASE)
          .eq("dispatch_id", id)
          .order("started_at", { ascending: true, nullsFirst: false })
          .limit(1)
          .maybeSingle<DispatchFlight>();
        flight = bez.data
          ? {
              ...bez.data,
              threat_confirmed: null,
              threat_note: null,
              threat_checked_at: null,
            }
          : null;
      } else {
        flight = sKontrolou.data;
      }

      // Autor ručního zásahu. Zásah zapisuje service_role, takže
      // v audit_log u něj nikdo není — jediná stopa po tom, kdo dron
      // poslal, je v uloženém důvodu.
      const actorId = dispatch.decision_reason?.manual?.actor_id ?? null;
      if (actorId) {
        // Pod session uživatele: kdo na cizí profily nevidí, dostane
        // prázdno a jméno se prostě neukáže. Že šlo o ruční zásah, to
        // nemění.
        const { data: profil } = await supabase
          .from("profiles")
          .select("full_name, email")
          .eq("id", actorId)
          .maybeSingle<{ full_name: string | null; email: string | null }>();
        actor = profil?.full_name?.trim() || profil?.email?.trim() || null;
      }

      if (flight) {
        const { data: rows } = await supabase
          .from("media")
          .select(MEDIA_COLUMNS)
          .eq("flight_id", flight.id)
          .order("captured_at", { ascending: true, nullsFirst: false })
          .limit(MEDIA_NAHLEDU)
          .returns<MediaRow[]>();
        media = await signMedia(supabase, rows ?? []);
      }
    }
  } catch {
    failed = true;
  }

  if (failed) {
    return (
      <>
        <BackLink href="/zasahy" label="Zásahy" />
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

  // Zapsaný důvod má přednost. Rekonstrukce ze současných pravidel je
  // jen náhrada pro zásahy z doby před migrací 20260825120000 — a musí
  // to u sebe říct, protože pravidla se od té doby mohla změnit.
  const reason = dispatch.decision_reason;
  const level = reason
    ? levelFromReason(reason)
    : explainLevel(detection?.object_class ?? null, dispatch.level_sent);
  const conditions = reason ? conditionsFromReason(reason) : null;
  const suppressed = isDispatchSuppressed(dispatch);
  const outcome = explainOutcome(dispatch.outcome, {
    armedWindow: site ? formatArmedWindow(site.armed_from, site.armed_to) : undefined,
    armedDays: site ? formatArmedDays(site.armed_days) : undefined,
    cooldownSeconds: site?.cooldown_seconds,
  });

  return (
    <>
      <BackLink href="/zasahy" label="Zásahy" />
      <PageHeader
        title="Detail zásahu"
        description={`${orDash(site?.name)} · ${orDash(zone?.name)}`}
        action={<DispatchOutcomeBadge outcome={dispatch.outcome} />}
      />

      <ol className="space-y-0">
        {/* ── Detekce ─────────────────────────────────────────── */}
        <Step
          icon={<ScanEye className="h-5 w-5" aria-hidden="true" />}
          title={reason?.manual ? "Ruční zásah" : "Detekce"}
          time={
            detection
              ? formatDateTime(detection.detected_at, timeZone)
              : reason?.manual
                ? formatDateTime(reason.decided_at, timeZone)
                : null
          }
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
          ) : reason?.manual ? (
            <Facts
              items={[
                ["Podnět", "Tlačítko v portálu"],
                // Bez jména aspoň to, že v důvodu nikdo podepsaný není
                // — mlčet by vypadalo, jako by se autor nezapisoval.
                ["Poslal", actor ?? "Neznámý uživatel"],
                ["Zóna", orDash(zone?.name)],
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

          {conditions ? (
            <ul className="mt-3 space-y-1 text-sm text-[var(--text-muted)]">
              {conditions.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          ) : null}

          {/* Výsledek nese odznak vpravo nahoře, tady by byl podruhé.
              Vysvětlující věta má smysl jen u rekonstrukce — se
              zapsaným důvodem totéž říkají podmínky výš. */}
          {reason ? null : (
            <p className="mt-3 text-sm text-[var(--text-muted)]">
              {outcome.text}
            </p>
          )}

          {reason ? (
            <p className="mt-3 text-xs text-[var(--text-muted)]">
              Zaznamenáno při rozhodování {formatDateTime(reason.decided_at, timeZone)}.
            </p>
          ) : (
            <p className="mt-3 border border-[var(--warning)]/40 bg-[var(--warning)]/[0.08] px-3 py-2 text-xs text-[var(--warning)]">
              Rekonstrukce. Tenhle zásah vznikl dřív, než se důvod začal
              ukládat, takže je dopočítaný z dnešních pravidel — pokud se
              mezitím změnila, nemusí odpovídat tomu, co se tehdy stalo.
            </p>
          )}
        </Step>

        {/* ── Odeslání ────────────────────────────────────────── */}
        <Step
          icon={<Send className="h-5 w-5" aria-hidden="true" />}
          title="Odeslání do FlightHubu"
          time={formatDateTime(dispatch.sent_at, timeZone)}
        >
          {/* U potlačeného zásahu se nic neodesílalo, takže incident ani
              HTTP status neexistují — pomlčky by vypadaly, jako by se
              odeslání nezdařilo. */}
          {suppressed ? (
            <p className="text-sm text-[var(--text-muted)]">
              {dispatch.outcome === "suppressed_unknown"
                ? // Ne „potlačen“: portál nic nerozhodl, jen se nedostal
                  // k údajům, podle kterých rozhoduje.
                  "Neodesláno — rozhodnutí se nedalo vyhodnotit."
                : "Neodesláno — zásah byl potlačen."}
            </p>
          ) : null}

          {!suppressed && showDiagnostics ? (
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
              <pre className="mt-2 max-w-full overflow-x-auto border border-[var(--line)] bg-[var(--bg)] p-3 font-mono text-xs leading-relaxed text-[var(--text-muted)]">
                {JSON.stringify(dispatch.response, null, 2)}
              </pre>
            </details>
          ) : null}

          {!suppressed && !showDiagnostics ? (
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

        {/* ── Let a záznam ────────────────────────────────────── */}
        <Step
          icon={<Plane className="h-5 w-5" aria-hidden="true" />}
          title="Let a záznam"
          time={flight ? formatDateTime(flight.started_at, timeZone) : null}
          muted={!flight}
          last
        >
          {!flight ? (
            <p className="text-sm text-[var(--text-muted)]">
              {suppressed
                ? "Zásah byl potlačen, takže se nikam neletělo."
                : "K tomuhle zásahu zatím není let. Objeví se, až ho dotáhne synchronizace s FlightHubem."}
            </p>
          ) : (
            <>
              <Facts
                items={[
                  ["Vzlet", formatDateTime(flight.started_at, timeZone)],
                  [
                    "Dolet na místo",
                    <Arrival
                      key="a"
                      flight={flight}
                      target={point}
                      timeZone={timeZone}
                    />,
                  ],
                  [
                    "Trvání",
                    formatDuration(
                      flight.duration_s ??
                        durationBetween(flight.started_at, flight.ended_at),
                    ),
                  ],
                  ["Stav", FLIGHT_STATUS_LABELS[flight.status]],
                ]}
              />

              <div className="mt-4">
                <ThreatCallout state={flight} />
              </div>

              <div className="mt-4">
                <MediaGallery
                  items={media}
                  timeZone={timeZone}
                  columns={3}
                  emptyText="Z letu zatím nejsou žádné snímky."
                />
              </div>

              <Link
                href={`/lety/${flight.id}`}
                className="mt-4 inline-flex items-center gap-1.5 text-sm text-[var(--accent)] hover:underline"
              >
                Otevřít detail letu
                <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
              </Link>
            </>
          )}
        </Step>
      </ol>
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
          className="absolute bottom-0 left-5 top-10 w-px bg-[var(--line)]"
        />
      ) : null}

      <div className={muted ? "opacity-50" : undefined}>
        <IconBadge tone="accent">{icon}</IconBadge>
      </div>

      <div className={`min-w-0 flex-1 border border-[var(--line)] bg-[var(--surface)] p-4 ${muted ? "opacity-60" : ""}`}>
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <h2 className="text-sm font-medium">{title}</h2>
          {time ? (
            <span className="text-xs tabular-nums text-[var(--text-muted)]">
              {time}
            </span>
          ) : null}
        </div>
        <div className="mt-3">{children}</div>
      </div>
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

/**
 * Kdy dron doletěl nad zónu.
 *
 * Počítá se z trajektorie, ne z hlášení DJI — to skutečný čas doletu
 * nedává. Bere se první bod do padesáti metrů od zóny; když jich je
 * míň, nechá se pomlčka, protože „nedoletěl" a „nevíme, kudy letěl"
 * není totéž a rozliší je věta pod tím.
 */
function Arrival({
  flight,
  target,
  timeZone,
}: {
  flight: DispatchFlight;
  target: { latitude: number; longitude: number } | null;
  timeZone: string | undefined;
}) {
  if (!target) {
    return <span className="text-[var(--text-muted)]">Zóna nemá souřadnice</span>;
  }

  const points = trajectoryPoints(flight.trajectory);
  if (points.length === 0) {
    return (
      <span className="text-[var(--text-muted)]">
        {flight.ended_at ? "Trasa nedorazila" : "Let ještě běží"}
      </span>
    );
  }

  const arrival = arrivalAt(points, target);
  if (!arrival) {
    return (
      <span className="text-[var(--warning)]" title={`Ani jeden bod trasy nebyl blíž než ${ARRIVAL_RADIUS_M} m`}>
        Nedoletěl k zóně
      </span>
    );
  }

  return <>{formatDateTime(arrival.toISOString(), timeZone)}</>;
}
