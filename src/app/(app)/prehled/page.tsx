import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import {
  BatteryMedium,
  ChevronRight,
  CloudSun,
  Film,
  HardDrive,
  History,
  LayoutDashboard,
  Plane,
  ScanEye,
  ShieldCheck,
  Video,
} from "lucide-react";
import type { ReactNode } from "react";

import { AreaMap } from "@/components/area-map.tsx";

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
  formatUntil,
} from "@/lib/dashboard.ts";
import { boundsAspectRatio } from "@/lib/area-map.ts";
import { localDateISO } from "@/lib/arrivals/rules.ts";

import { loadAreaMap, siteBounds } from "@/lib/area-map-data.ts";
import { getDockStateCached } from "@/lib/dispatch/dock-cache.ts";
import {
  formatDateTime,
  formatRainfall,
  formatTemperature,
  formatWindSpeed,
} from "@/lib/format.ts";
import { zonedTimeToUtc } from "@/lib/patrols/schedule.ts";

import {
  getSiteSelection,
  siteCapabilities,
  type SiteCapabilities,
  type SiteRow,
} from "@/lib/selected-site.ts";
import { PLAYBACK_REACH_DAYS } from "@/lib/live/stream.ts";
import { isSiteAlwaysArmed, nextArmedTransition } from "@/lib/site-status.ts";
import { visibleNavItems } from "@/lib/nav.ts";
import { createClient } from "@/lib/supabase/server.ts";

import { isSiteArmed } from "@/types/database.ts";

export const metadata: Metadata = { title: "Přehled" };

interface PassageWarningRow {
  plate: string | null;
  confidence: number | null;
  list_match: string | null;
  passed_at: string;
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
  const { selectedRow: site, rows } = await getSiteSelection();
  const now = new Date();
  const capabilities = siteCapabilities(rows, site);

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
  /** Pro varování o kamerách přes relay bez adresy v síti. */
  let kamery = {
    pocet: 0,
    klipu: 0,
    posledniDetekceAt: null as string | null,
    posledniDetekceKamera: null as string | null,
  };
  let failed = false;

  // Lokalita už přišla se seznamem v layoutu, včetně okna střežení
  // a sloupců podkladu — druhý dotaz na sites ani volání site_is_armed()
  // tady nejsou potřeba. Odznak v liště počítá totéž ze stejných dat.
  const armed = isSiteArmed(site, now);

  try {
    const supabase = await createClient();

    {
      const since = startOfLocalDay(site.timezone, now).toISOString();

      const [detections, dispatches, suppressed, flights, passageCount, announcedCount, passageRows, patrolFlights, cameraCount, posledniDetekce, klipCount] =
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
          supabase.from("vehicle_passages").select("id", { count: "exact", head: true })
            .eq("site_id", site.id).gte("passed_at", since),
          // Ohlášení na dnešek. Kalendářní datum, ne časové razítko —
          // arrival_date je DATE a „dnešek“ je ten místní.
          supabase.from("announced_arrivals").select("id", { count: "exact", head: true })
            .eq("site_id", site.id)
            .eq("arrival_date", localDateISO(site.timezone, now))
            .is("cancelled_at", null),
          // Vjezdy s neznámou nebo nepřečtenou značkou. Ostrý režim se
          // vyhodnocuje až v paměti — SQL na to funkci nemá.
          supabase.from("vehicle_passages")
            .select("plate, confidence, list_match, passed_at")
            .eq("site_id", site.id).gte("passed_at", since)
            .is("list_match", null)
            .returns<PassageWarningRow[]>(),
          // Poslední lety hlídek: jedním dotazem, nejnovější první.
          supabase.from("flights").select("patrol_id, started_at")
            .eq("site_id", site.id).eq("kind", "patrol")
            .not("started_at", "is", null)
            .order("started_at", { ascending: false }).limit(50)
            .returns<{ patrol_id: string | null; started_at: string }[]>(),
          // ── Pro blok o kamerách ───────────────────────────────
          // Kolik kamer lokalita má. `head: true` — jde jen o číslo.
          supabase.from("cameras").select("id", { count: "exact", head: true })
            .eq("site_id", site.id).neq("status", "decommissioned"),
          // Poslední detekce, ať je vidět, kdy se naposled něco hnulo.
          // Ne dnešní: na klidné stavbě je zajímavější „předevčírem
          // v 6:12" než dnešní nula.
          supabase.from("detections")
            .select("detected_at, cameras(name)")
            .eq("site_id", site.id)
            .order("detected_at", { ascending: false }).limit(1)
            .returns<{ detected_at: string; cameras: { name: string } | null }[]>(),
          // Uložené klipy: kolik důkazů v úložišti opravdu leží.
          supabase.from("camera_recordings")
            .select("id, cameras!inner(site_id)", { count: "exact", head: true })
            .eq("cameras.site_id", site.id)
            .not("storage_path", "is", null)
            .is("video_expired_at", null),
        ]);

      counts = {
        detections: detections.count ?? 0,
        dispatches: dispatches.count ?? 0,
        suppressed: suppressed.count ?? 0,
        flights: flights.count ?? 0,
        passages: passageCount.count ?? 0,
        // Chybějící tabulka (nenasazená migrace) dá nulu, ne pád.
        announced: announcedCount.error ? 0 : (announcedCount.count ?? 0),
        // Nejistá značka se se seznamem nepárovala; do čísla se počítá
        // jen to, co přišlo v ostrém režimu.
        unknownPlates: (passageRows.data ?? []).filter((row) =>
          isSiteArmed(site, new Date(row.passed_at)),
        ).length,
      };

      kamery = {
        pocet: cameraCount.count ?? 0,
        // Chybějící tabulka (nenasazená migrace) dá null, ne pád.
        klipu: klipCount.error ? 0 : (klipCount.count ?? 0),
        posledniDetekceAt: (posledniDetekce.data ?? [])[0]?.detected_at ?? null,
        posledniDetekceKamera:
          (posledniDetekce.data ?? [])[0]?.cameras?.name ?? null,
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

  return (
    <>
      {/* Na telefonu skrytý: „Přehled" je vidět ve spodní liště jako
          aktivní položka a lokalita v horní. Nadpis tedy neříká nic
          navíc a zabírá výšku, kvůli které se poslední dlaždice
          nevešly na obrazovku. */}
      <div className="hidden sm:block">
        <PageHeader title="Přehled" description={site.name} />
      </div>

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
            hasDrone={capabilities.drone}
            dockFacts={
              // Stavba bez dronu dok nemá a nikdy mít nebude —
              // prázdné dlaždice by tvrdily, že se něco nenačetlo.
              capabilities.drone ? (
                <Suspense fallback={<DockFactsSkeleton hasDock={Boolean(site.dock_sn)} />}>
                  <DockFacts dockSn={site.dock_sn} />
                </Suspense>
              ) : null
            }
          />

          {/* ═══ Varování a poslední události tu bývaly ═══════════
              Obojí zmizelo na přání: přehled má odpovídat na „jak to
              tam vypadá", ne být druhý seznam detekcí a sloupec
              hlášek, které se stejně řeší jinde. Detekce mají vlastní
              sekci, kamery taky. */}

          {capabilities.cameras ? (
            <>
              <NaKamery pocet={kamery.pocet} />
              <KameryABlok
                kamery={kamery}
                timeZone={site.timezone}
                dosahDni={PLAYBACK_REACH_DAYS}
              />
            </>
          ) : null}

          <Numbers counts={counts} capabilities={capabilities} />
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
  hasDrone,
}: {
  site: SiteRow;
  armed: boolean;
  until: string | null;
  becomes: "armed" | "disarmed" | null;
  lastPatrolFlightAt: Date | null;
  dockFacts: ReactNode;
  hasDrone: boolean;
}) {
  // Nepřetržité střežení se hlásí rovnou a bez dovětku: okno 00:00 až
  // 23:59 sice formálně jednu minutu denně nestřeží, ale „střežení se
  // vypne ve 23:59“ by o stavu areálu tvrdilo něco, co není pravda.
  const nepretrzite = isSiteAlwaysArmed(site);
  const sentence = nepretrzite
    ? "Areál je střežený nepřetržitě."
    : armed
      ? "Areál je právě střežený."
      : "Areál právě nestřeží.";
  const switchNote =
    !nepretrzite && until && becomes
      ? becomes === "armed"
        ? `Střežení se zapne ${until}.`
        : `Střežení se vypne ${until}.`
      : null;

  return (
    <>
      <Section className="relative py-3 sm:py-6">
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
        <p className="mt-2 text-[16px] font-normal leading-snug tracking-tight sm:mt-3 sm:text-2xl">
          {sentence}
          {switchNote ? (
            <span className="text-[var(--text-muted)]"> {switchNote}</span>
          ) : null}
        </p>
      </Section>

      {/* Hlídky lítá dron. Stavba bez něj nemá co ukazovat a „Zatím
          žádná" tam tvrdilo, že se něco nestalo — přitom se to stát
          nemůže. Bez dronu tedy mřížka nevzniká vůbec. */}
      {hasDrone ? (
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
      ) : null}
    </>
  );
}

/**
 * Proklik na kamery.
 *
 * Z přehledu se nejčastěji pokračuje k obrazu — „něco se tam děje,
 * ukaž mi to“. Bez odkazu to znamenalo cestu přes menu, což je na
 * telefonu dvě klepnutí navíc a na přehledu, který má být rozcestník,
 * zbytečně.
 */
function NaKamery({ pocet }: { pocet: number }) {
  return (
    <Link
      href="/kamery"
      className="flex items-center gap-3 border-b border-[var(--line)] px-5 py-3 transition hover:bg-[var(--surface-2)] sm:px-6 sm:py-4"
    >
      <Video
        className="h-4 w-4 shrink-0 text-[var(--accent-bright)]"
        aria-hidden="true"
      />
      <span className="flex-1 text-sm text-[var(--text)]">
        Kamery
        {pocet > 0 ? (
          <span className="ml-2 text-xs text-[var(--text-muted)]">{pocet}</span>
        ) : null}
      </span>
      <span className="hidden text-xs text-[var(--text-muted)] sm:inline">
        obraz, záznam, události
      </span>
      <ChevronRight
        className="h-4 w-4 shrink-0 text-[var(--text-muted)]"
        aria-hidden="true"
      />
    </Link>
  );
}

/**
 * Co je o kamerách vidět bez proklikávání.
 *
 * ═══ Proč zrovna tyhle čtyři údaje ═════════════════════════════════
 * Blok „Dnes“ nad tím počítá dnešek, což na klidné stavbě znamená
 * čtyři nuly a prázdnou obrazovku. Tyhle údaje naopak nemají jak být
 * prázdné a každý odpovídá na otázku, kterou si klient klade:
 *
 *   Kamer               kolik jich vlastně mám
 *   Poslední detekce    kdy se naposled něco hnulo (i když to bylo
 *                       předevčírem — dnešní nula o tom nic neříká)
 *   Záznam zpětně       jak daleko se můžu podívat
 *   Uložených klipů     kolik důkazů v úložišti opravdu leží
 */
function KameryABlok({
  kamery,
  timeZone,
  dosahDni,
}: {
  kamery: {
    pocet: number;
    klipu: number;
    posledniDetekceAt: string | null;
    posledniDetekceKamera: string | null;
  };
  timeZone: string;
  dosahDni: number;
}) {
  return (
    <>
      <Section className="py-3 pb-0 sm:py-6 sm:pb-0">
        <BlockTitle className="mb-0">Kamery</BlockTitle>
      </Section>
      <div className="hairline-grid grid-cols-2 sm:grid-cols-4">
        <Metric
          label="Kamer"
          icon={<Video className="h-3.5 w-3.5" aria-hidden="true" />}
        >
          {kamery.pocet}
        </Metric>

        <Metric
          label="Poslední detekce"
          icon={<ScanEye className="h-3.5 w-3.5" aria-hidden="true" />}
        >
          {kamery.posledniDetekceAt ? (
            <span className="block">
              <span className="block text-[15px] leading-snug sm:text-base">
                {formatDateTime(kamery.posledniDetekceAt, timeZone)}
              </span>
              {kamery.posledniDetekceKamera ? (
                <span className="mt-0.5 block text-xs font-normal text-[var(--text-muted)]">
                  {kamery.posledniDetekceKamera}
                </span>
              ) : null}
            </span>
          ) : (
            "Zatím žádná"
          )}
        </Metric>

        <Metric
          label="Záznam zpětně"
          icon={<History className="h-3.5 w-3.5" aria-hidden="true" />}
        >
          {dosahDni} dní
        </Metric>

        <Metric
          label="Uložených klipů"
          icon={<Film className="h-3.5 w-3.5" aria-hidden="true" />}
        >
          {kamery.klipu}
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

/** Čísla za dnešek jako mřížka buněk, ne dlaždice s mezerami. */
function Numbers({
  counts,
  capabilities,
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
  capabilities: SiteCapabilities;
}) {
  // `needs` má týž význam jako v navigaci: nula u čísla, které pro
  // lokalitu nedává smysl, není informace — je to matoucí. Stavba bez
  // dronu nemá zásahy ani lety, areál bez kamer nemá vjezdy.
  const cells = visibleNavItems(
    [
      { label: "Detekcí", value: counts.detections, muted: false, needs: null },
      { label: "Vjezdů", value: counts.passages, muted: false, needs: "cameras" },
      { label: "Zásahů", value: counts.dispatches, muted: false, needs: "drone" },
      { label: "Potlačených", value: counts.suppressed, muted: true, needs: "drone" },
      { label: "Letů", value: counts.flights, muted: false, needs: "drone" },
      // Po přidání vjezdů je to první číslo, na které se člověk podívá:
      // kolik aut projelo, aniž by je někdo znal.
      { label: "Neznámých značek", value: counts.unknownPlates, muted: false, needs: "cameras" },
      // Druhá strana téže mince: co se čekalo a co doopravdy přijelo.
      { label: "Ohlášeno na dnešek", value: counts.announced, muted: true, needs: "cameras" },
    ] as const,
    capabilities,
  );

  return (
    <>
      <Section className="py-3 pb-0 sm:py-6 sm:pb-0">
        <BlockTitle className="mb-0">Dnes</BlockTitle>
      </Section>
      <div className="hairline-grid grid-cols-2">
        {cells.map((cell) => (
          <div key={cell.label} className="px-5 py-3 sm:px-6 sm:py-5">
            <div className="text-[11px] font-medium uppercase tracking-[0.12em] text-[var(--text-muted)]">
              {cell.label}
            </div>
            <div
              className={`mt-1 text-2xl font-normal tabular-nums tracking-tight sm:mt-2 sm:text-3xl ${
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

