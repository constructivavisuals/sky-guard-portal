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
import {
  BlockTitle,
  EmptyState,
  Metric,
  PageHeader,
  Section,
} from "@/components/ui.tsx";
import {
  BATTERY_WARNING_PERCENT,
  STORAGE_WARNING_PERCENT,
  cameraSilenceWarnings,
  cameraWarnings,
  dockWarnings,
  formatUntil,
  patrolWarnings,
  unknownPlateWarnings,
  zoneWarnings,
  type PatrolHealth,
  type Warning,
} from "@/lib/dashboard.ts";
import { boundsAspectRatio } from "@/lib/area-map.ts";
import { localDateISO } from "@/lib/arrivals/rules.ts";
import { CRON_JOBS, cronWarnings, type CronRunSummary } from "@/lib/cron/runs.ts";
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
import { isPlateReliable } from "@/lib/plates.ts";
import {
  isSiteArmed,
  type DetectionObjectClass,
  type DispatchOutcome,
} from "@/types/database.ts";

export const metadata: Metadata = { title: "Přehled" };

interface PassageWarningRow {
  plate: string | null;
  confidence: number | null;
  list_match: string | null;
  passed_at: string;
}

interface CameraRow {
  id: string;
  name: string;
  zone_id: string | null;
  status: string;
  last_seen_at: string | null;
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
  let counts = {
    detections: 0,
    dispatches: 0,
    suppressed: 0,
    flights: 0,
    passages: 0,
    unknownPlates: 0,
    announced: 0,
  };
  let unknownPlates: { plate: string | null; armed: boolean }[] = [];
  let cameras = { total: 0, withoutZone: 0 };
  let zones = { total: 0, withoutWayline: 0 };
  // null = nepodařilo se zjistit (migrace 20260905120000 neběžela).
  // Varovat na základě neexistující tabulky by bylo totéž tiché
  // selhání, jaké tahle evidence řeší, jen obráceně.
  let cronRuns: CronRunSummary[] | null = null;
  let silence: { name: string; lastSeenAt: Date | null; online: boolean }[] = [];
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

      const [detections, dispatches, suppressed, flights, patrolRows, cameraRows, zoneRows, cronRows, passageCount, announcedCount, passageRows, patrolFlights, lastDetections, lastDispatches] =
        await Promise.all([
          supabase.from("detections").select("id", { count: "exact", head: true })
            .eq("site_id", site.id).gte("detected_at", since),
          supabase.from("dispatches").select("id", { count: "exact", head: true })
            .eq("site_id", site.id).gte("sent_at", since),
          supabase.from("dispatches").select("id", { count: "exact", head: true })
            .eq("site_id", site.id).gte("sent_at", since)
            .in("outcome", ["suppressed_disarmed", "suppressed_cooldown", "suppressed_dock"]),
          supabase.from("flights").select("id", { count: "exact", head: true })
            .eq("site_id", site.id).gte("started_at", since),
          supabase.from("patrols").select("id, name, interval_minutes, created_at")
            .eq("site_id", site.id).eq("enabled", true)
            .returns<PatrolRow[]>(),
          // Kamer je na lokalitě řád jednotek, takže je levnější přivézt
          // si zone_id a spočítat obojí tady, než posílat dva dotazy
          // s count=exact.
          supabase.from("cameras").select("id, name, zone_id, status, last_seen_at")
            .eq("site_id", site.id).neq("status", "decommissioned")
            .returns<CameraRow[]>(),
          // Zóna bez trasy je tichý výpadek stejného druhu jako kamera
          // bez zóny: detekce se zapíše, dron nikam neletí.
          supabase.from("zones").select("id, wayline_uuid")
            .eq("site_id", site.id).eq("enabled", true)
            .returns<{ id: string; wayline_uuid: string | null }[]>(),
          // Poslední běh každého cronu zvlášť: jeden dotaz seřazený
          // přes všechny by při různých periodách nemusel na tu
          // nejřidší vůbec dosáhnout.
          Promise.all(
            CRON_JOBS.map((job) =>
              supabase.from("cron_runs").select("name, ran_at")
                .eq("name", job.name)
                .order("ran_at", { ascending: false }).limit(1)
                .returns<{ name: string; ran_at: string }[]>(),
            ),
          ),
          supabase.from("vehicle_passages").select("id", { count: "exact", head: true })
            .eq("site_id", site.id).gte("passed_at", since),
          // Ohlášení na dnešek. Kalendářní datum, ne časové razítko —
          // arrival_date je DATE a „dnešek“ je ten místní.
          supabase.from("announced_arrivals").select("id", { count: "exact", head: true })
            .eq("site_id", site.id)
            .eq("arrival_date", localDateISO(site.timezone, now))
            .is("cancelled_at", null),
          // Vjezdy s neznámou nebo nepřečtenou značkou. Ostrý režim se
          // vyhodnocuje až v paměti — SQL na to funkci nemá a dotaz
          // s podmínkou na okno střežení by ji opisoval potřetí.
          supabase.from("vehicle_passages")
            .select("plate, confidence, list_match, passed_at")
            .eq("site_id", site.id).gte("passed_at", since)
            .is("list_match", null)
            .returns<PassageWarningRow[]>(),
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
        passages: passageCount.count ?? 0,
        // Chybějící tabulka (nenasazená migrace) dá nulu, ne pád.
        announced: announcedCount.error ? 0 : (announcedCount.count ?? 0),
        // Doplní se níž, až se vjezdy profiltrují ostrým režimem.
        unknownPlates: 0,
      };

      unknownPlates = (passageRows.data ?? [])
        .filter((row) => isSiteArmed(site, new Date(row.passed_at)))
        .map((row) => ({
          // Nejistá značka se se seznamem nepárovala, takže se do
          // varování hlásí jako nepřečtená, ne jako neznámá.
          plate: isPlateReliable(row.plate, row.confidence) ? row.plate : null,
          armed: true,
        }));
      counts.unknownPlates = unknownPlates.length;
      patrols = patrolRows.data ?? [];
      const cameraList = cameraRows.data ?? [];
      cameras = {
        total: cameraList.length,
        withoutZone: cameraList.filter((camera) => camera.zone_id === null).length,
      };
      // Chybějící sloupec (migrace 20260903180000 ještě neběžela)
      // znamená „nevíme“, ne „nemá trasu“ — strašit varováním na
      // základě neexistujícího sloupce by bylo horší než mlčet.
      // Chybějící tabulka znamená „nevíme“, ne „neběží“.
      if (cronRows.every((row) => !row.error)) {
        cronRuns = CRON_JOBS.map((job, index) => {
          const radek = cronRows[index].data?.[0];
          return {
            name: job.name,
            lastRunAt: radek ? new Date(radek.ran_at) : null,
          };
        });
      }

      if (!zoneRows.error) {
        const zoneList = zoneRows.data ?? [];
        zones = {
          total: zoneList.length,
          withoutWayline: zoneList.filter((zone) => !zone.wayline_uuid).length,
        };
      }

      silence = cameraList.map((camera) => ({
        name: camera.name,
        lastSeenAt: camera.last_seen_at ? new Date(camera.last_seen_at) : null,
        online: camera.status === "online",
      }));

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
    // Nefungující cron první: zaseknuté plánování znamená, že nelétá
    // vůbec nic, což přebíjí každou jednotlivou zónu nebo kameru.
    ...(cronRuns ? cronWarnings(cronRuns, now) : []),
    ...cameraWarnings(cameras),
    ...zoneWarnings(zones),
    ...unknownPlateWarnings(unknownPlates),
    ...cameraSilenceWarnings(silence, now),
    ...patrolWarnings(health, now),
  ];

  return (
    <>
      <PageHeader title="Přehled" description={site.name} />

      {/* Dva sloupce až od lg, dělené svislou vlasovou linkou, která
          jde od horní hrany bloku k dolní — bez mezery, aby navázala
          na linky nad ní i pod ní. Bez podkladu by pravý sloupec zůstal
          prázdný, tak se mřížka v tom případě vůbec nezakládá. */}
      <div className={hasMap ? "lg:grid lg:grid-cols-2" : ""}>
        <div className={hasMap ? "min-w-0 lg:border-r lg:border-[var(--line)]" : "min-w-0"}>
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
          <div className="flex min-w-0 flex-col">
            {/* Časová osa vlevo může být dlouhá; mapa při rolování
                zůstane na místě. */}
            <Section flush className="p-5 sm:p-6 lg:sticky lg:top-0">
              <BlockTitle>Areál</BlockTitle>
              {/* Bod doku se tahá z FlightHubu, takže mapa dorazí až
                  po zbytku stránky. Rámeček drží místo, aby se pod ním
                  nic neposunulo. */}
              <Suspense fallback={<AreaMapSkeleton site={site} />}>
                <AreaMapCard site={site} />
              </Suspense>
            </Section>

            {/* Pod mapou pokračuje mřížka dál, ať plocha nekončí
                v prázdnu. */}
            <div
              aria-hidden="true"
              className="hidden flex-1 rule-field lg:block"
              style={{ "--col": "50%" } as React.CSSProperties}
            />
          </div>
        ) : null}
      </div>
    </>
  );
}

/**
 * Věta o tom, jestli systém právě hlídá, a pod ní mřížka údajů.
 *
 * Věta je jediné velké písmo na stránce — je to hlavní sdělení
 * přehledu. Údaje pod ní jsou mřížka buněk dělených vlasovou linkou,
 * stejný rytmus jako mřížka výhod na sky-guard.cz.
 */
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
  const sentence = armed ? "Areál je právě střežený." : "Areál právě nestřeží.";
  const switchNote =
    until && becomes
      ? becomes === "armed"
        ? `Střežení se zapne ${until}.`
        : `Střežení se vypne ${until}.`
      : null;

  return (
    <>
      <Section className="relative">
        {/* Svislý pruh v barvě stavu. Nahrazuje obarvený rámeček karty:
            rámeček by přerušil linku, pruh do mřížky zapadne. */}
        <span
          aria-hidden="true"
          className={`absolute inset-y-0 left-0 w-[3px] ${
            armed ? "bg-[var(--success)]" : "bg-[var(--line-strong)]"
          }`}
        />
        <div className="flex items-center gap-3">
          <span
            className={`h-2 w-2 shrink-0 rounded-full ${
              armed
                ? "bg-[var(--success)] shadow-[var(--glow-success)]"
                : "bg-[var(--text-muted)]"
            }`}
            aria-hidden="true"
          />
          <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--text-muted)]">
            Stav střežení
          </p>
        </div>
        <p className="mt-2.5 text-[17px] font-normal leading-snug tracking-tight sm:mt-3 sm:text-2xl">
          {sentence}
          {switchNote ? (
            <span className="text-[var(--text-muted)]"> {switchNote}</span>
          ) : null}
        </p>
      </Section>

      <div className="hairline-grid grid-cols-2">
        {dockFacts}
        {/* Přes celou šířku, aby v mřížce nezůstala prázdná buňka —
            ta by se prokreslila jako světlý obdélník bez obsahu. */}
        <Metric
          className="col-span-2"
          label="Poslední hlídka"
          icon={<Plane className="h-3.5 w-3.5" aria-hidden="true" />}
        >
          {lastPatrolFlightAt
            ? formatDateTime(lastPatrolFlightAt.toISOString(), site.timezone)
            : "Zatím žádná"}
        </Metric>
      </div>
    </>
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

  const baterie = dock?.batteryPercent;
  const uloziste = dock?.storageUsedPercent;

  return (
    <>
      <Metric
        label="Dron"
        icon={<ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />}
        tone={dock?.droneInDock === false ? "warning" : undefined}
      >
        {dock ? (dock.droneInDock ? "V doku" : "Mimo dok") : "Stav neznámý"}
      </Metric>

      <Metric
        label="Baterie"
        icon={<BatteryMedium className="h-3.5 w-3.5" aria-hidden="true" />}
        tone={
          typeof baterie === "number" && baterie < BATTERY_WARNING_PERCENT
            ? "warning"
            : undefined
        }
      >
        {typeof baterie === "number" ? `${Math.round(baterie)} %` : "—"}
      </Metric>

      <Metric
        label="Úložiště"
        icon={<HardDrive className="h-3.5 w-3.5" aria-hidden="true" />}
        tone={
          typeof uloziste === "number" && uloziste > STORAGE_WARNING_PERCENT
            ? "warning"
            : undefined
        }
      >
        {typeof uloziste === "number" ? `${Math.round(uloziste)} %` : "—"}
      </Metric>

      <Metric
        label="Počasí"
        icon={<CloudSun className="h-3.5 w-3.5" aria-hidden="true" />}
      >
        {dock?.conditions
          ? `${formatWindSpeed(dock.conditions.wind_speed)} · ${formatRainfall(dock.conditions.rainfall)} · ${formatTemperature(dock.conditions.environment_temperature)}`
          : "—"}
      </Metric>

      {chyba ? (
        <div className="col-span-2 px-5 py-3 text-xs text-[var(--warning)] sm:px-6">
          Stav doku se nepodařilo načíst: {chyba}
        </div>
      ) : cached.ageMs > 5_000 ? (
        <div className="col-span-2 px-5 py-3 text-xs text-[var(--text-muted)] sm:px-6">
          Odečteno před {Math.round(cached.ageMs / 1000)} s.
        </div>
      ) : null}
    </>
  );
}

/** Místo pro údaje z doku, dokud nedorazí. */
function DockFactsSkeleton({ hasDock }: { hasDock: boolean }) {
  const zatim = hasDock ? "Načítá se" : "Bez doku";
  return (
    <>
      <Metric
        label="Dron"
        icon={<ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />}
      >
        <span className="text-[var(--text-muted)]">{zatim}</span>
      </Metric>
      <Metric
        label="Baterie"
        icon={<BatteryMedium className="h-3.5 w-3.5" aria-hidden="true" />}
      >
        <span className="text-[var(--text-muted)]">—</span>
      </Metric>
      <Metric
        label="Úložiště"
        icon={<HardDrive className="h-3.5 w-3.5" aria-hidden="true" />}
      >
        <span className="text-[var(--text-muted)]">—</span>
      </Metric>
      <Metric
        label="Počasí"
        icon={<CloudSun className="h-3.5 w-3.5" aria-hidden="true" />}
      >
        <span className="text-[var(--text-muted)]">—</span>
      </Metric>
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
      className="animate-pulse border border-[var(--line)] bg-[var(--surface-2)]"
      style={{ aspectRatio: bounds ? String(boundsAspectRatio(bounds)) : "16 / 10" }}
      aria-hidden="true"
    />
  );
}

/**
 * Varování. Oranžová je táž jako Sky Construction na webu — v portálu
 * má jediný význam: vyžaduje pozornost.
 */
function Warnings({ items }: { items: Warning[] }) {
  return (
    <Section role="alert" className="relative bg-[var(--warning)]/[0.05]">
      <span
        aria-hidden="true"
        className="absolute inset-y-0 left-0 w-[3px] bg-[var(--warning)]"
      />
      <div className="flex items-center gap-2 text-[var(--warning)]">
        <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
        <h2 className="text-[11px] font-medium uppercase tracking-[0.14em]">
          Vyžaduje pozornost
        </h2>
      </div>
      <ul className="mt-3 space-y-2 text-sm leading-relaxed text-[var(--text-dim)]">
        {items.map((item) => (
          <li key={item.key} className="flex gap-2.5">
            <span
              aria-hidden="true"
              className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-[var(--warning)]"
            />
            {item.text}
          </li>
        ))}
      </ul>
    </Section>
  );
}

/** Čísla za dnešek jako mřížka buněk, ne dlaždice s mezerami. */
function Numbers({
  counts,
}: {
  counts: {
    detections: number;
    dispatches: number;
    suppressed: number;
    flights: number;
    passages: number;
    unknownPlates: number;
    announced: number;
  };
}) {
  const cells = [
    { label: "Detekcí", value: counts.detections, muted: false },
    { label: "Vjezdů", value: counts.passages, muted: false },
    { label: "Zásahů", value: counts.dispatches, muted: false },
    { label: "Potlačených", value: counts.suppressed, muted: true },
    { label: "Letů", value: counts.flights, muted: false },
    // Šestý údaj tu není na dorovnání mřížky, ale proto, že po
    // přidání vjezdů je to první číslo, na které se člověk podívá:
    // kolik aut projelo, aniž by je někdo znal.
    { label: "Neznámých značek", value: counts.unknownPlates, muted: false },
    // Kolik aut je na dnešek ohlášených. Vedle „vjezdů“ to dává smysl
    // jako druhá strana téže mince: co se čekalo a co doopravdy přijelo.
    { label: "Ohlášeno na dnešek", value: counts.announced, muted: true },
  ];

  return (
    <>
      <Section className="pb-0 sm:pb-0">
        <BlockTitle className="mb-0">Dnes</BlockTitle>
      </Section>
      <div className="hairline-grid grid-cols-2">
        {cells.map((cell) => (
          <div key={cell.label} className="px-5 py-5 sm:px-6">
            <div className="text-[11px] font-medium uppercase tracking-[0.12em] text-[var(--text-muted)]">
              {cell.label}
            </div>
            <div
              className={`mt-2 text-3xl font-normal tabular-nums tracking-tight ${
                cell.muted ? "text-[var(--text-muted)]" : "text-[var(--text)]"
              }`}
            >
              {cell.value}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

/**
 * Poslední události jako seznam řádků dělených vlasovou linkou —
 * stejný vzor jako seznam otázek na webu. Svislá spojnice mezi
 * ikonami tu byla dřív; v mřížce by konkurovala linkám, které nesou
 * strukturu, takže zmizela.
 */
function Timeline({ events, timeZone }: { events: EventRow[]; timeZone: string }) {
  return (
    <>
      <Section className="pb-0 sm:pb-0">
        <BlockTitle className="mb-0">Poslední události</BlockTitle>
      </Section>

      {events.length === 0 ? (
        <Section>
          <p className="text-sm leading-relaxed text-[var(--text-muted)]">
            Na téhle lokalitě se zatím nic nestalo. Detekce a zásahy se objeví,
            jakmile začne ingest posílat data.
          </p>
        </Section>
      ) : (
        <ol className="border-b border-[var(--line)]">
          {events.map((event) => (
            <li key={event.id} className="border-t border-[var(--line)]">
              <Link
                href={event.href}
                className="flex items-center gap-4 px-5 py-4 transition hover:bg-[var(--surface-2)] sm:px-8"
              >
                <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-[var(--line-strong)] text-[var(--text-muted)]">
                  {event.kind === "detection" ? (
                    <ScanEye className="h-4 w-4" aria-hidden="true" />
                  ) : (
                    <Send className="h-4 w-4" aria-hidden="true" />
                  )}
                </span>
                <span className="flex min-w-0 flex-1 flex-wrap items-center gap-2 text-sm">
                  {event.label}
                </span>
                <span className="shrink-0 text-xs tabular-nums text-[var(--text-muted)]">
                  {formatDateTime(event.at, timeZone)}
                </span>
              </Link>
            </li>
          ))}
        </ol>
      )}
    </>
  );
}
