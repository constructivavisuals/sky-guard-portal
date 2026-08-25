import type { Metadata } from "next";
import Link from "next/link";
import {
  AlertTriangle,
  BatteryMedium,
  CloudSun,
  HardDrive,
  LayoutDashboard,
  Plane,
  ScanEye,
  Send,
  ShieldCheck,
} from "lucide-react";
import type { ReactNode } from "react";

import { DispatchOutcomeShortBadge, ObjectClassBadge } from "@/components/badges.tsx";
import { Card, EmptyState, PageHeader } from "@/components/ui.tsx";
import {
  dockWarnings,
  formatUntil,
  patrolWarnings,
  type PatrolHealth,
  type Warning,
} from "@/lib/dashboard.ts";
import { getDockStateCached } from "@/lib/dispatch/dock-cache.ts";
import type { DockState } from "@/lib/dispatch/flighthub.ts";
import {
  formatDateTime,
  formatRainfall,
  formatTemperature,
  formatWindSpeed,
  orDash,
} from "@/lib/format.ts";
import { zonedTimeToUtc } from "@/lib/patrols/schedule.ts";
import { getSiteSelection } from "@/lib/selected-site.ts";
import { nextArmedTransition } from "@/lib/site-status.ts";
import { createClient } from "@/lib/supabase/server.ts";
import {
  type DetectionObjectClass,
  type DispatchOutcome,
  type IsoWeekday,
} from "@/types/database.ts";

export const metadata: Metadata = { title: "Přehled" };

interface SiteRow {
  id: string;
  name: string;
  timezone: string;
  dock_sn: string | null;
  armed_from: string;
  armed_to: string;
  armed_days: IsoWeekday[];
}

interface PatrolRow {
  id: string;
  name: string;
  interval_minutes: number;
  created_at: string;
}

interface EventRow {
  id: string;
  at: string;
  kind: "detection" | "dispatch";
  label: ReactNode;
  href: string;
}

/** Půlnoc lokality v UTC — od kdy se počítá „dnes“. */
function startOfLocalDay(timeZone: string, now: Date): Date {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value);
  return zonedTimeToUtc(value("year"), value("month"), value("day"), 0, 0, timeZone);
}

export default async function Page() {
  const { selected } = await getSiteSelection();
  const now = new Date();

  if (!selected) {
    return (
      <>
        <PageHeader title="Přehled" description="Stav střežení lokality." />
        <EmptyState
          icon={<LayoutDashboard className="h-5 w-5" aria-hidden="true" />}
          title="Vyberte lokalitu"
          description="Přehled je o jednom areálu — stav střežení, dok a hlídky se napříč lokalitami sečíst nedají."
        />
      </>
    );
  }

  let site: SiteRow | null = null;
  let dock: DockState | null = null;
  let dockError: string | null = null;
  let dockAgeMs = 0;
  let patrols: PatrolRow[] = [];
  let lastPatrolFlightAt: Date | null = null;
  const patrolLastByid = new Map<string, Date>();
  let armed = false;
  let counts = { detections: 0, dispatches: 0, suppressed: 0, flights: 0 };
  let events: EventRow[] = [];
  let failed = false;

  try {
    const supabase = await createClient();

    const { data: siteRow, error: siteError } = await supabase
      .from("sites")
      .select("id, name, timezone, dock_sn, armed_from, armed_to, armed_days")
      .eq("id", selected.id)
      .maybeSingle<SiteRow>();

    if (siteError || !siteRow) failed = true;
    else site = siteRow;

    if (site) {
      const since = startOfLocalDay(site.timezone, now).toISOString();

      // Ostrý režim počítá databáze, stejně jako pro odznak v horní
      // liště. Kdyby si ho přehled počítal sám v TypeScriptu, mohly by
      // se ta dvě místa na jedné obrazovce rozejít.
      const { data: armedNow } = await supabase.rpc("site_is_armed", {
        p_site_id: site.id,
      });
      armed = armedNow === true;

      const [detections, dispatches, suppressed, flights, patrolRows, patrolFlights, lastDetections, lastDispatches] =
        await Promise.all([
          supabase.from("detections").select("id", { count: "exact", head: true })
            .eq("site_id", site.id).gte("detected_at", since),
          supabase.from("dispatches").select("id", { count: "exact", head: true })
            .eq("site_id", site.id).gte("sent_at", since),
          supabase.from("dispatches").select("id", { count: "exact", head: true })
            .eq("site_id", site.id).gte("sent_at", since)
            .in("outcome", ["suppressed_disarmed", "suppressed_cooldown"]),
          supabase.from("flights").select("id", { count: "exact", head: true })
            .eq("site_id", site.id).gte("started_at", since),
          supabase.from("patrols").select("id, name, interval_minutes, created_at")
            .eq("site_id", site.id).eq("enabled", true)
            .returns<PatrolRow[]>(),
          // Poslední lety hlídek: jedním dotazem, nejnovější první.
          // Z nich se v paměti vybere poslední let ke každé hlídce.
          supabase.from("flights").select("patrol_id, started_at")
            .eq("site_id", site.id).eq("kind", "patrol")
            .not("started_at", "is", null)
            .order("started_at", { ascending: false }).limit(50)
            .returns<{ patrol_id: string | null; started_at: string }[]>(),
          supabase.from("detections")
            .select("id, detected_at, object_class, dispatches!dispatches_triggered_by_detection_fkey(id)")
            .eq("site_id", site.id)
            .order("detected_at", { ascending: false }).limit(5)
            .returns<{ id: string; detected_at: string; object_class: DetectionObjectClass; dispatches: { id: string }[] }[]>(),
          supabase.from("dispatches")
            .select("id, sent_at, outcome, zones(name)")
            .eq("site_id", site.id)
            .order("sent_at", { ascending: false }).limit(5)
            .returns<{ id: string; sent_at: string; outcome: DispatchOutcome; zones: { name: string } | null }[]>(),
        ]);

      counts = {
        detections: detections.count ?? 0,
        dispatches: dispatches.count ?? 0,
        suppressed: suppressed.count ?? 0,
        flights: flights.count ?? 0,
      };
      patrols = patrolRows.data ?? [];

      for (const flight of patrolFlights.data ?? []) {
        if (!flight.patrol_id) continue;
        if (!patrolLastByid.has(flight.patrol_id)) {
          patrolLastByid.set(flight.patrol_id, new Date(flight.started_at));
        }
      }
      lastPatrolFlightAt = (patrolFlights.data ?? [])[0]
        ? new Date((patrolFlights.data ?? [])[0].started_at)
        : null;

      events = [
        ...(lastDetections.data ?? []).map((row) => ({
          id: `d-${row.id}`,
          at: row.detected_at,
          kind: "detection" as const,
          label: <ObjectClassBadge objectClass={row.object_class} />,
          // Detekce vlastní detail nemá; nejblíž je zásah, který
          // spustila, jinak seznam. Kontroluje se id, ne jen existence
          // objektu — jinak by z prázdné vazby vznikl odkaz na
          // /zasahy/undefined.
          href:
            typeof row.dispatches[0]?.id === "string" && row.dispatches[0].id
              ? `/zasahy/${row.dispatches[0].id}`
              : "/detekce",
        })),
        ...(lastDispatches.data ?? []).map((row) => ({
          id: `p-${row.id}`,
          at: row.sent_at,
          kind: "dispatch" as const,
          label: (
            <span className="flex items-center gap-2">
              <DispatchOutcomeShortBadge outcome={row.outcome} />
              <span className="text-[var(--text-muted)]">{orDash(row.zones?.name)}</span>
            </span>
          ),
          href: `/zasahy/${row.id}`,
        })),
      ]
        .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
        .slice(0, 5);
    }

    if (site?.dock_sn) {
      const cached = await getDockStateCached(site.dock_sn);
      dockAgeMs = cached.ageMs;
      if (cached.result.ok) dock = cached.result.state;
      else dockError = cached.result.message;
    }
  } catch {
    failed = true;
  }

  if (failed || !site) {
    return (
      <>
        <PageHeader title="Přehled" />
        <EmptyState
          icon={<LayoutDashboard className="h-5 w-5" aria-hidden="true" />}
          title="Přehled se nepodařilo načíst"
          description="Zkuste to za chvíli znovu. Pokud potíž trvá, zkontrolujte připojení k databázi."
        />
      </>
    );
  }

  // Čas do přepnutí se dopočítává v TypeScriptu — SQL na to funkci
  // nemá. Obě implementace pravidla se shodují, což hlídá paritní test
  // v supabase/tests/run-local.sh.
  const transition = nextArmedTransition(site, now, { currentlyArmed: armed });
  const until = transition ? formatUntil(transition.at, now) : null;

  const health: PatrolHealth[] = patrols.map((patrol) => ({
    name: patrol.name,
    interval_minutes: patrol.interval_minutes,
    lastFlightAt: patrolLastByid.get(patrol.id) ?? null,
    since: new Date(patrol.created_at),
  }));

  const warnings: Warning[] = [
    ...(dock ? dockWarnings(dock) : []),
    ...patrolWarnings(health, now),
  ];

  return (
    <>
      <PageHeader title="Přehled" description={site.name} />

      <div className="space-y-6">
        <StatusBar
          site={site}
          armed={armed}
          until={until}
          becomes={transition?.becomes ?? null}
          dock={dock}
          dockError={dockError}
          dockAgeMs={dockAgeMs}
          lastPatrolFlightAt={lastPatrolFlightAt}
        />

        {warnings.length > 0 ? <Warnings items={warnings} /> : null}

        <Numbers counts={counts} />

        <Timeline events={events} timeZone={site.timezone} />
      </div>
    </>
  );
}

/** Jedna věta o tom, jestli systém právě hlídá. */
function StatusBar({
  site,
  armed,
  until,
  becomes,
  dock,
  dockError,
  dockAgeMs,
  lastPatrolFlightAt,
}: {
  site: SiteRow;
  armed: boolean;
  until: string | null;
  becomes: "armed" | "disarmed" | null;
  dock: DockState | null;
  dockError: string | null;
  dockAgeMs: number;
  lastPatrolFlightAt: Date | null;
}) {
  const sentence = armed
    ? "Areál je právě střežený."
    : "Areál právě nestřeží.";
  const switchNote =
    until && becomes
      ? becomes === "armed"
        ? `Střežení se zapne ${until}.`
        : `Střežení se vypne ${until}.`
      : null;

  return (
    <Card
      className={`p-5 ${armed ? "border-[var(--success)]/40" : ""}`}
    >
      <div className="flex items-start gap-3">
        <span
          className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${
            armed ? "bg-[var(--success)]" : "bg-[var(--text-muted)]"
          }`}
          aria-hidden="true"
        />
        <div className="min-w-0">
          <p className="text-base font-medium">
            {sentence}{" "}
            {switchNote ? (
              <span className="text-[var(--text-muted)]">{switchNote}</span>
            ) : null}
          </p>

          <dl className="mt-4 grid gap-x-8 gap-y-2 sm:grid-cols-2">
            <Fact icon={<ShieldCheck className="h-4 w-4" aria-hidden="true" />} label="Dron">
              {dock
                ? dock.droneInDock
                  ? "V doku"
                  : "Mimo dok"
                : dockError
                  ? "Stav neznámý"
                  : site.dock_sn
                    ? "Načítá se"
                    : "Lokalita nemá dok"}
            </Fact>
            <Fact icon={<BatteryMedium className="h-4 w-4" aria-hidden="true" />} label="Baterie">
              {dock?.batteryPercent !== null && dock?.batteryPercent !== undefined
                ? `${Math.round(dock.batteryPercent)} %`
                : "—"}
            </Fact>
            <Fact icon={<HardDrive className="h-4 w-4" aria-hidden="true" />} label="Úložiště">
              {dock?.storageUsedPercent !== null && dock?.storageUsedPercent !== undefined
                ? `zaplněno ${Math.round(dock.storageUsedPercent)} %`
                : "—"}
            </Fact>
            <Fact icon={<CloudSun className="h-4 w-4" aria-hidden="true" />} label="Počasí">
              {dock?.conditions
                ? `${formatWindSpeed(dock.conditions.wind_speed)} · ${formatRainfall(dock.conditions.rainfall)} · ${formatTemperature(dock.conditions.environment_temperature)}`
                : "—"}
            </Fact>
            <Fact icon={<Plane className="h-4 w-4" aria-hidden="true" />} label="Poslední hlídka">
              {lastPatrolFlightAt
                ? formatDateTime(lastPatrolFlightAt.toISOString(), site.timezone)
                : "Zatím žádná"}
            </Fact>
          </dl>

          {dockError ? (
            <p className="mt-3 text-xs text-[var(--text-muted)]">
              Stav doku se nepodařilo načíst: {dockError}
            </p>
          ) : dock && dockAgeMs > 5_000 ? (
            <p className="mt-3 text-xs text-[var(--text-muted)]">
              Stav doku odečtený před {Math.round(dockAgeMs / 1000)} s.
            </p>
          ) : null}
        </div>
      </div>
    </Card>
  );
}

function Fact({
  icon,
  label,
  children,
}: {
  icon: ReactNode;
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="flex items-baseline gap-2 text-sm">
      <span className="text-[var(--text-muted)]" aria-hidden="true">
        {icon}
      </span>
      <dt className="text-[var(--text-muted)]">{label}</dt>
      <dd className="min-w-0 truncate">{children}</dd>
    </div>
  );
}

function Warnings({ items }: { items: Warning[] }) {
  return (
    <div
      role="alert"
      className="rounded-[var(--radius-card)] border border-[var(--warning)]/40 bg-[var(--warning)]/10 p-4"
    >
      <div className="flex items-center gap-2 text-[var(--warning)]">
        <AlertTriangle className="h-4 w-4" aria-hidden="true" />
        <h2 className="text-sm font-medium">Vyžaduje pozornost</h2>
      </div>
      <ul className="mt-2 space-y-1 text-sm text-[var(--warning)]">
        {items.map((item) => (
          <li key={item.key}>{item.text}</li>
        ))}
      </ul>
    </div>
  );
}

/** Čísla za dnešek. Vedle sebe, ne dlaždice. */
function Numbers({
  counts,
}: {
  counts: { detections: number; dispatches: number; suppressed: number; flights: number };
}) {
  return (
    <Card className="p-5">
      <h2 className="text-sm font-medium text-[var(--text-muted)]">Dnes</h2>
      <dl className="mt-3 flex flex-wrap gap-x-8 gap-y-3">
        <Stat label="detekcí" value={counts.detections} />
        <Stat label="zásahů" value={counts.dispatches} />
        <Stat label="z toho potlačených" value={counts.suppressed} muted />
        <Stat label="letů" value={counts.flights} />
      </dl>
    </Card>
  );
}

/** Jedno číslo s popiskem. Nesmí se jmenovat Number — zastínilo by
 * globální Number(), který výš převádí složky data. */
function Stat({
  label,
  value,
  muted,
}: {
  label: string;
  value: number;
  muted?: boolean;
}) {
  return (
    <div className="flex items-baseline gap-2">
      <dd
        className={`text-xl font-semibold tabular-nums ${muted ? "text-[var(--text-muted)]" : ""}`}
      >
        {value}
      </dd>
      <dt className="text-sm text-[var(--text-muted)]">{label}</dt>
    </div>
  );
}

function Timeline({ events, timeZone }: { events: EventRow[]; timeZone: string }) {
  return (
    <Card className="p-5">
      <h2 className="text-sm font-medium text-[var(--text-muted)]">Poslední události</h2>
      {events.length === 0 ? (
        <p className="mt-3 text-sm text-[var(--text-muted)]">
          Na téhle lokalitě se zatím nic nestalo. Detekce a zásahy se objeví,
          jakmile začne ingest posílat data.
        </p>
      ) : (
        <ol className="mt-4 space-y-0">
          {events.map((event, index) => (
            <li key={event.id} className="relative flex gap-3 pb-4 last:pb-0">
              {index < events.length - 1 ? (
                <span
                  aria-hidden="true"
                  className="absolute left-[15px] top-8 bottom-0 w-px bg-[var(--border)]"
                />
              ) : null}
              <span className="mt-1 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-[var(--border)] bg-[var(--surface-2)] text-[var(--text-muted)]">
                {event.kind === "detection" ? (
                  <ScanEye className="h-4 w-4" aria-hidden="true" />
                ) : (
                  <Send className="h-4 w-4" aria-hidden="true" />
                )}
              </span>
              <Link
                href={event.href}
                className="min-w-0 flex-1 rounded-lg px-2 py-1 -mx-2 transition hover:bg-[var(--surface-2)]"
              >
                <span className="flex flex-wrap items-center gap-2 text-sm">
                  {event.label}
                </span>
                <span className="mt-0.5 block text-xs text-[var(--text-muted)]">
                  {formatDateTime(event.at, timeZone)}
                </span>
              </Link>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}
