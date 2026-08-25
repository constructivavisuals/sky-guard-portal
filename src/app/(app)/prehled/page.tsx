import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
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

import { AreaMap } from "@/components/area-map.tsx";
import { DispatchOutcomeShortBadge, ObjectClassBadge } from "@/components/badges.tsx";
import { Card, EmptyState, PageHeader } from "@/components/ui.tsx";
import {
  cameraWarnings,
  dockWarnings,
  formatUntil,
  patrolWarnings,
  type PatrolHealth,
  type Warning,
} from "@/lib/dashboard.ts";
import { boundsAspectRatio } from "@/lib/area-map.ts";
import { loadAreaMap, siteBounds } from "@/lib/area-map-data.ts";
import { getDockStateCached } from "@/lib/dispatch/dock-cache.ts";
import {
  formatDateTime,
  formatRainfall,
  formatTemperature,
  formatWindSpeed,
  orDash,
} from "@/lib/format.ts";
import { zonedTimeToUtc } from "@/lib/patrols/schedule.ts";
import { getSiteSelection, type SiteRow } from "@/lib/selected-site.ts";
import { nextArmedTransition } from "@/lib/site-status.ts";
import { createClient } from "@/lib/supabase/server.ts";
import {
  isSiteArmed,
  type DetectionObjectClass,
  type DispatchOutcome,
} from "@/types/database.ts";

export const metadata: Metadata = { title: "Přehled" };

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
  const { selectedRow: site } = await getSiteSelection();
  const now = new Date();

  if (!site) {
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

  let patrols: PatrolRow[] = [];
  let lastPatrolFlightAt: Date | null = null;
  const patrolLastByid = new Map<string, Date>();
  let counts = { detections: 0, dispatches: 0, suppressed: 0, flights: 0 };
  let cameras = { total: 0, withoutZone: 0 };
  let events: EventRow[] = [];
  let failed = false;

  // Lokalita už přišla se seznamem v layoutu, včetně okna střežení
  // a sloupců podkladu — druhý dotaz na sites ani volání site_is_armed()
  // tady nejsou potřeba. Odznak v liště počítá totéž ze stejných dat.
  const armed = isSiteArmed(site, now);

  try {
    const supabase = await createClient();

    {
      const since = startOfLocalDay(site.timezone, now).toISOString();

      const [detections, dispatches, suppressed, flights, patrolRows, cameraRows, patrolFlights, lastDetections, lastDispatches] =
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
          // Kamer je na lokalitě řád jednotek, takže je levnější přivézt
          // si zone_id a spočítat obojí tady, než posílat dva dotazy
          // s count=exact.
          supabase.from("cameras").select("id, zone_id")
            .eq("site_id", site.id).neq("status", "decommissioned")
            .returns<{ id: string; zone_id: string | null }[]>(),
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
      const cameraList = cameraRows.data ?? [];
      cameras = {
        total: cameraList.length,
        withoutZone: cameraList.filter((camera) => camera.zone_id === null).length,
      };

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
  } catch {
    failed = true;
  }

  if (failed) {
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

  // Podklad se kreslí, jen když ho lokalita má. Data pro něj se
  // dotahují až ve streamované části, tady stačí vědět, že bude.
  const hasMap = Boolean(site.map_image_url);

  const transition = nextArmedTransition(site, now, { currentlyArmed: armed });
  const until = transition ? formatUntil(transition.at, now) : null;

  const health: PatrolHealth[] = patrols.map((patrol) => ({
    name: patrol.name,
    interval_minutes: patrol.interval_minutes,
    lastFlightAt: patrolLastByid.get(patrol.id) ?? null,
    since: new Date(patrol.created_at),
  }));

  // Varování z databáze se vypíšou hned; ta ze stavu doku dorazí
  // streamovaně, protože na ně se čeká na FlightHub.
  const rychlaVarovani: Warning[] = [
    // Kamery bez zóny první — je to tichý výpadek celé lokality,
    // ne provozní drobnost jako plné úložiště.
    ...cameraWarnings(cameras),
    ...patrolWarnings(health, now),
  ];

  return (
    <>
      <PageHeader title="Přehled" description={site.name} />

      {/* Dva sloupce až od lg. Bez podkladu by pravý sloupec zůstal
          prázdný, tak se mřížka v tom případě vůbec nezakládá.
          min-w-0: položky mřížky mají výchozí min-width auto, takže by
          je široký obsah roztáhl nad šířku sloupce. */}
      <div
        className={
          hasMap
            ? "grid items-start gap-4 lg:grid-cols-2"
            : ""
        }
      >
        <div className="min-w-0 space-y-4">
          <StatusBar
            site={site}
            armed={armed}
            until={until}
            becomes={transition?.becomes ?? null}
            lastPatrolFlightAt={lastPatrolFlightAt}
            dockFacts={
              <Suspense fallback={<DockFactsSkeleton hasDock={Boolean(site.dock_sn)} />}>
                <DockFacts dockSn={site.dock_sn} />
              </Suspense>
            }
          />

          {/* Fallback ukazuje varování z databáze hned; až dorazí stav
              doku, seznam se doplní. Čekat s celým blokem na FlightHub
              by znamenalo, že kamera bez zóny svítí o vteřinu později
              než všechno ostatní. */}
          <Suspense
            fallback={
              rychlaVarovani.length > 0 ? <Warnings items={rychlaVarovani} /> : null
            }
          >
            <WarningsWithDock base={rychlaVarovani} dockSn={site.dock_sn} />
          </Suspense>

          <Numbers counts={counts} />

          <Timeline events={events} timeZone={site.timezone} />
        </div>

        {hasMap ? (
          // Timeline vlevo může být dlouhá; mapa při rolování zůstane.
          <div className="min-w-0 lg:sticky lg:top-6">
            <Card className="p-4">
              <h2 className="mb-3 text-sm font-medium text-[var(--text-muted)]">
                Areál
              </h2>
              {/* Bod doku se tahá z FlightHubu, takže mapa dorazí až
                  po zbytku stránky. Rámeček drží místo, aby se pod ním
                  nic neposunulo. */}
              <Suspense fallback={<AreaMapSkeleton site={site} />}>
                <AreaMapCard site={site} />
              </Suspense>
            </Card>
          </div>
        ) : null}
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
  lastPatrolFlightAt,
  dockFacts,
}: {
  site: SiteRow;
  armed: boolean;
  until: string | null;
  becomes: "armed" | "disarmed" | null;
  lastPatrolFlightAt: Date | null;
  dockFacts: ReactNode;
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
      className={`p-4 ${armed ? "border-[var(--success)]/40" : ""}`}
    >
      <div className="flex items-start gap-2.5">
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

          <dl className="mt-3 grid gap-y-1.5">
            {dockFacts}
            <Fact icon={<Plane className="h-4 w-4" aria-hidden="true" />} label="Poslední hlídka">
              {lastPatrolFlightAt
                ? formatDateTime(lastPatrolFlightAt.toISOString(), site.timezone)
                : "Zatím žádná"}
            </Fact>
          </dl>
        </div>
      </div>
    </Card>
  );
}

// ── Stav doku ────────────────────────────────────────────────────
//
// Vlastní komponenta, protože jako jediná na téhle stránce sahá mimo
// databázi — do FlightHubu, kde má volání timeout 5 s. Ve společné
// vlně by o ten čas zdržela celý render; takhle dorazí zvlášť
// a zbytek přehledu je vidět hned.

async function DockFacts({ dockSn }: { dockSn: string | null }) {
  if (!dockSn) return <DockFactsSkeleton hasDock={false} />;

  const cached = await getDockStateCached(dockSn);
  const dock = cached.result.ok ? cached.result.state : null;
  const chyba = cached.result.ok ? null : cached.result.message;

  return (
    <>
      <Fact icon={<ShieldCheck className="h-4 w-4" aria-hidden="true" />} label="Dron">
        {dock ? (dock.droneInDock ? "V doku" : "Mimo dok") : "Stav neznámý"}
      </Fact>
      <Fact icon={<BatteryMedium className="h-4 w-4" aria-hidden="true" />} label="Baterie">
        {typeof dock?.batteryPercent === "number"
          ? `${Math.round(dock.batteryPercent)} %`
          : "—"}
      </Fact>
      <Fact icon={<HardDrive className="h-4 w-4" aria-hidden="true" />} label="Úložiště">
        {typeof dock?.storageUsedPercent === "number"
          ? `zaplněno ${Math.round(dock.storageUsedPercent)} %`
          : "—"}
      </Fact>
      <Fact icon={<CloudSun className="h-4 w-4" aria-hidden="true" />} label="Počasí">
        {dock?.conditions
          ? `${formatWindSpeed(dock.conditions.wind_speed)} · ${formatRainfall(dock.conditions.rainfall)} · ${formatTemperature(dock.conditions.environment_temperature)}`
          : "—"}
      </Fact>
      {chyba ? (
        <p className="text-xs text-[var(--text-muted)]">
          Stav doku se nepodařilo načíst: {chyba}
        </p>
      ) : cached.ageMs > 5_000 ? (
        <p className="text-xs text-[var(--text-muted)]">
          Stav doku odečtený před {Math.round(cached.ageMs / 1000)} s.
        </p>
      ) : null}
    </>
  );
}

/** Místo pro údaje z doku, dokud nedorazí. */
function DockFactsSkeleton({ hasDock }: { hasDock: boolean }) {
  const zatim = hasDock ? "Načítá se" : "Lokalita nemá dok";
  return (
    <>
      <Fact icon={<ShieldCheck className="h-4 w-4" aria-hidden="true" />} label="Dron">
        <span className="text-[var(--text-muted)]">{zatim}</span>
      </Fact>
      <Fact icon={<BatteryMedium className="h-4 w-4" aria-hidden="true" />} label="Baterie">
        <span className="text-[var(--text-muted)]">—</span>
      </Fact>
      <Fact icon={<HardDrive className="h-4 w-4" aria-hidden="true" />} label="Úložiště">
        <span className="text-[var(--text-muted)]">—</span>
      </Fact>
      <Fact icon={<CloudSun className="h-4 w-4" aria-hidden="true" />} label="Počasí">
        <span className="text-[var(--text-muted)]">—</span>
      </Fact>
    </>
  );
}

/** Varování z databáze doplněná o ta ze stavu doku. */
async function WarningsWithDock({
  base,
  dockSn,
}: {
  base: Warning[];
  dockSn: string | null;
}) {
  let items = base;
  if (dockSn) {
    const cached = await getDockStateCached(dockSn);
    if (cached.result.ok) {
      // Dok až za varováními z databáze: kamera bez zóny je horší zpráva
      // než plné úložiště.
      items = [...base, ...dockWarnings(cached.result.state)];
    }
  }
  return items.length > 0 ? <Warnings items={items} /> : null;
}

/** Podklad areálu i s body. Čeká na souřadnice doku z FlightHubu. */
async function AreaMapCard({ site }: { site: SiteRow }) {
  const supabase = await createClient();
  const map = await loadAreaMap(supabase, site);
  return (
    <AreaMap
      imageUrl={map.imageUrl}
      bounds={map.bounds}
      points={map.points}
      siteName={site.name}
    />
  );
}

/** Rámeček ve správném poměru stran, aby stránka po doplnění mapy neposkočila. */
function AreaMapSkeleton({ site }: { site: SiteRow }) {
  const bounds = siteBounds(site);
  return (
    <div
      className="animate-pulse rounded-[var(--radius-card)] border border-[var(--border)] bg-[var(--surface-2)]"
      style={{ aspectRatio: bounds ? String(boundsAspectRatio(bounds)) : "16 / 10" }}
      aria-hidden="true"
    />
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
      className="rounded-[var(--radius-card)] border border-[var(--warning)]/40 bg-[var(--warning)]/10 p-3.5"
    >
      <div className="flex items-center gap-2 text-[var(--warning)]">
        <AlertTriangle className="h-4 w-4" aria-hidden="true" />
        <h2 className="text-sm font-medium">Vyžaduje pozornost</h2>
      </div>
      <ul className="mt-1.5 space-y-1 text-sm text-[var(--warning)]">
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
    <Card className="p-4">
      <h2 className="text-sm font-medium text-[var(--text-muted)]">Dnes</h2>
      <dl className="mt-2 flex flex-wrap gap-x-6 gap-y-2">
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
    <Card className="p-4">
      <h2 className="text-sm font-medium text-[var(--text-muted)]">Poslední události</h2>
      {events.length === 0 ? (
        <p className="mt-2 text-sm text-[var(--text-muted)]">
          Na téhle lokalitě se zatím nic nestalo. Detekce a zásahy se objeví,
          jakmile začne ingest posílat data.
        </p>
      ) : (
        <ol className="mt-3 space-y-0">
          {events.map((event, index) => (
            <li key={event.id} className="relative flex gap-3 pb-3 last:pb-0">
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
