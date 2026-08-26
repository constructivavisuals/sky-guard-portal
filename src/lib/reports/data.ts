import type { SupabaseClient } from "@supabase/supabase-js";

import { zonedTimeToUtc } from "../patrols/schedule.ts";
import { isPlateReliable } from "../plates.ts";
import { CRON_JOBS } from "../cron/runs.ts";
import type { DecisionReason, DispatchOutcome } from "../../types/database.ts";

// Sběr dat pro měsíční report.
//
// Jeden zdroj pro náhled na obrazovce i pro PDF. Kdyby si každý sahal
// pro čísla sám, lišila by se — a report, ve kterém stojí jiné číslo
// než na stránce, ze které se stáhl, je horší než žádný.
//
// Čte se KLIENTEM PŘIHLÁŠENÉHO UŽIVATELE, ne přes service_role: rozsah
// tím určuje RLS. Klient dostane svou lokalitu, admin kteroukoli,
// a nikde se to nemusí kontrolovat podruhé.

export interface ReportPeriod {
  /** `YYYY-MM`. */
  month: string;
  /** Začátek a konec v UTC, spočítané v pásmu lokality. */
  from: Date;
  to: Date;
  /** Kolik dní měsíc má. */
  days: number;
  label: string;
}

const MESICE = [
  "leden", "únor", "březen", "duben", "květen", "červen",
  "červenec", "srpen", "září", "říjen", "listopad", "prosinec",
];

/** Je `YYYY-MM` v rozumném rozsahu? */
export function parseMonth(value: string | null | undefined): string | null {
  if (!value || !/^\d{4}-\d{2}$/.test(value)) return null;
  const [year, month] = value.split("-").map(Number);
  if (month < 1 || month > 12) return null;
  if (year < 2020 || year > 2100) return null;
  return value;
}

/** Měsíc, ve kterém `at` v pásmu lokality leží. */
export function currentMonth(timeZone: string, at: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
  }).formatToParts(at);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}`;
}

/**
 * Hranice měsíce.
 *
 * Počítá se v pásmu lokality: „srpen“ začíná o půlnoci v areálu, ne
 * v UTC. U letního času je to rozdíl dvou hodin na obou koncích, což
 * u nočních detekcí posune celý den.
 */
export function monthPeriod(month: string, timeZone: string): ReportPeriod {
  const [year, mon] = month.split("-").map(Number);
  const from = zonedTimeToUtc(year, mon, 1, 0, 0, timeZone);
  const to =
    mon === 12
      ? zonedTimeToUtc(year + 1, 1, 1, 0, 0, timeZone)
      : zonedTimeToUtc(year, mon + 1, 1, 0, 0, timeZone);

  return {
    month,
    from,
    to,
    days: new Date(Date.UTC(year, mon, 0)).getUTCDate(),
    label: `${MESICE[mon - 1]} ${year}`,
  };
}

export interface ThreatRow {
  flightId: string;
  at: string | null;
  zoneName: string | null;
  note: string | null;
  /** Cesta prvního snímku z letu; podepisuje se až při vykreslení. */
  storagePath: string | null;
}

export interface MonthlyReport {
  site: { id: string; name: string; timezone: string };
  client: { companyName: string | null; logoPath: string | null };
  period: ReportPeriod;
  summary: {
    detections: number;
    dispatches: number;
    flights: number;
    /** Nalétané minuty, součet duration_s. */
    flightMinutes: number;
    threats: number;
  };
  /** Detekce po dnech, index 0 = první den měsíce. */
  detectionsByDay: number[];
  /** Zásahy podle výsledku, jen nenulové. */
  dispatchOutcomes: { outcome: DispatchOutcome; count: number }[];
  threats: ThreatRow[];
  passages: { total: number; announced: number; unknownPlates: number };
  /** Jen pro admina; u ostatních null. */
  operations: {
    /** Podíl skutečných běhů cronu k očekávaným, 0–1. Null = neměřeno. */
    availability: number | null;
    cronRuns: { name: string; label: string; runs: number; expected: number }[];
    skippedPatrols: number;
    /** Důvody přeskočení podle cronu. Prázdné u starších měsíců. */
    skipReasons: { reason: string; count: number }[];
  } | null;
}

/** České popisky důvodů, proč se hlídka nenaplánovala. */
export const SKIP_REASON_LABELS: Record<string, string> = {
  drone_not_in_dock: "Dron nebyl v doku",
  low_battery: "Nízká baterie",
  storage_full: "Plné úložiště doku",
  dock_unreachable: "Dok neodpověděl",
  no_dock_sn: "Lokalita bez sériového čísla doku",
  already_scheduled: "Let už byl naplánovaný",
};

export async function loadMonthlyReport(
  supabase: SupabaseClient,
  options: {
    site: { id: string; name: string; timezone: string };
    month: string;
    includeOperations: boolean;
  },
): Promise<MonthlyReport> {
  const { site, month, includeOperations } = options;
  const period = monthPeriod(month, site.timezone);
  const fromIso = period.from.toISOString();
  const toIso = period.to.toISOString();

  const [
    detections,
    dispatches,
    flights,
    passages,
    threats,
    client,
    cronRows,
  ] = await Promise.all([
    supabase
      .from("detections")
      .select("detected_at")
      .eq("site_id", site.id)
      .gte("detected_at", fromIso)
      .lt("detected_at", toIso)
      .returns<{ detected_at: string }[]>(),
    supabase
      .from("dispatches")
      .select("outcome, decision_reason")
      .eq("site_id", site.id)
      .gte("sent_at", fromIso)
      .lt("sent_at", toIso)
      .returns<{ outcome: DispatchOutcome; decision_reason: DecisionReason | null }[]>(),
    supabase
      .from("flights")
      .select("id, started_at, duration_s")
      .eq("site_id", site.id)
      .gte("started_at", fromIso)
      .lt("started_at", toIso)
      .returns<{ id: string; started_at: string | null; duration_s: number | null }[]>(),
    supabase
      .from("vehicle_passages")
      .select("plate, confidence, list_match, announced_arrival_id")
      .eq("site_id", site.id)
      .gte("passed_at", fromIso)
      .lt("passed_at", toIso)
      .returns<
        {
          plate: string | null;
          confidence: number | null;
          list_match: string | null;
          announced_arrival_id: string | null;
        }[]
      >(),
    // Potvrzené nálezy: let, na jehož snímcích model našel člověka nebo
    // vozidlo. Zóna se bere přes zásah, ze kterého let vzešel.
    supabase
      .from("flights")
      .select(
        "id, started_at, threat_note, dispatches(zones(name)), media(storage_path, kind, captured_at)",
      )
      .eq("site_id", site.id)
      .eq("threat_confirmed", true)
      .gte("started_at", fromIso)
      .lt("started_at", toIso)
      .order("started_at", { ascending: true })
      .returns<
        {
          id: string;
          started_at: string | null;
          threat_note: string | null;
          dispatches: { zones: { name: string } | null } | null;
          media: { storage_path: string; kind: string; captured_at: string | null }[];
        }[]
      >(),
    // Logo a firma klienta. Bere se z profilu, ne z lokality — logo
    // patří firmě, která si areál platí.
    supabase
      .from("profiles")
      .select("company_name, logo_path")
      .not("company_name", "is", null)
      .limit(1)
      .maybeSingle<{ company_name: string | null; logo_path: string | null }>(),
    includeOperations
      ? supabase
          .from("cron_runs")
          .select("name, result")
          .gte("ran_at", fromIso)
          .lt("ran_at", toIso)
          .returns<{ name: string; result: Record<string, unknown> }[]>()
      : Promise.resolve({ data: [], error: null }),
  ]);

  // ── Detekce po dnech ────────────────────────────────────────────
  const detectionsByDay = new Array<number>(period.days).fill(0);
  const denFormat = new Intl.DateTimeFormat("en-CA", {
    timeZone: site.timezone,
    day: "2-digit",
  });
  for (const row of detections.data ?? []) {
    const den = Number(denFormat.format(new Date(row.detected_at)));
    if (Number.isFinite(den) && den >= 1 && den <= period.days) {
      detectionsByDay[den - 1] += 1;
    }
  }

  // ── Zásahy podle výsledku ───────────────────────────────────────
  const podleVysledku = new Map<DispatchOutcome, number>();
  for (const row of dispatches.data ?? []) {
    podleVysledku.set(row.outcome, (podleVysledku.get(row.outcome) ?? 0) + 1);
  }

  // ── Vjezdy ──────────────────────────────────────────────────────
  const passageRows = passages.data ?? [];
  const unknownPlates = passageRows.filter(
    (row) => isPlateReliable(row.plate, row.confidence) && row.list_match === null,
  ).length;

  // ── Provoz ──────────────────────────────────────────────────────
  let operations: MonthlyReport["operations"] = null;
  if (includeOperations) {
    const runs = cronRows.data ?? [];
    const minuty = (period.to.getTime() - period.from.getTime()) / 60_000;

    const podleJmena = CRON_JOBS.map((job) => ({
      name: job.name,
      label: job.label,
      runs: runs.filter((row) => row.name === job.name).length,
      expected: Math.max(1, Math.round(minuty / job.intervalMinutes)),
    }));

    // Dostupnost bereme z plánování hlídek: je to nejčastější úloha
    // a zároveň ta, bez které portál nic nedělá.
    const hlidky = podleJmena.find((job) => job.name === "patrols");
    const availability =
      hlidky && hlidky.expected > 0
        ? Math.min(1, hlidky.runs / hlidky.expected)
        : null;

    let skipped = 0;
    const duvody = new Map<string, number>();
    for (const row of runs) {
      if (row.name !== "patrols") continue;
      const value = Number(row.result?.skipped);
      if (Number.isFinite(value)) skipped += value;

      const reasons = row.result?.skipReasons;
      if (reasons && typeof reasons === "object") {
        for (const [key, count] of Object.entries(reasons as Record<string, unknown>)) {
          const n = Number(count);
          if (Number.isFinite(n)) duvody.set(key, (duvody.get(key) ?? 0) + n);
        }
      }
    }

    operations = {
      availability,
      cronRuns: podleJmena,
      skippedPatrols: skipped,
      skipReasons: [...duvody.entries()]
        .map(([reason, count]) => ({ reason, count }))
        .sort((a, b) => b.count - a.count),
    };
  }

  const flightRows = flights.data ?? [];

  return {
    site,
    client: {
      companyName: client.data?.company_name ?? null,
      logoPath: client.data?.logo_path ?? null,
    },
    period,
    summary: {
      detections: (detections.data ?? []).length,
      dispatches: (dispatches.data ?? []).length,
      flights: flightRows.length,
      flightMinutes: Math.round(
        flightRows.reduce((sum, row) => sum + (row.duration_s ?? 0), 0) / 60,
      ),
      threats: (threats.data ?? []).length,
    },
    detectionsByDay,
    dispatchOutcomes: [...podleVysledku.entries()]
      .map(([outcome, count]) => ({ outcome, count }))
      .sort((a, b) => b.count - a.count),
    threats: (threats.data ?? []).map((row) => ({
      flightId: row.id,
      at: row.started_at,
      zoneName: row.dispatches?.zones?.name ?? null,
      note: row.threat_note,
      // První fotka z letu. Videa se do reportu nevkládají.
      storagePath:
        row.media
          ?.filter((media) => media.kind === "photo")
          .sort((a, b) => (a.captured_at ?? "").localeCompare(b.captured_at ?? ""))[0]
          ?.storage_path ?? null,
    })),
    passages: {
      total: passageRows.length,
      announced: passageRows.filter((row) => row.announced_arrival_id !== null).length,
      unknownPlates,
    },
    operations,
  };
}
