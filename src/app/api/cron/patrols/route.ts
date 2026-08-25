import { timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";

import { createFlightTask } from "@/lib/dispatch/flighthub.ts";
import { patrolRunsBetween } from "@/lib/patrols/schedule.ts";
import { supabaseAdmin } from "@/lib/supabase-admin.ts";
import type { IsoWeekday } from "@/types/database.ts";

// GET /api/cron/patrols
//
// Vercel cron, každých 5 minut. Pro každou zapnutou hlídku spočítá,
// jestli má v příštích 10 minutách odstartovat let, a pokud ještě není
// naplánovaný, založí ho ve FlightHubu.
//
// Okno je delší než perioda schválně: kdyby jeden běh vypadl, další ho
// dožene. Dvojímu naplánování brání unikátní index na
// (patrol_id, started_at) — cron se o to nespoléhá jen na dotaz.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Jak daleko dopředu se plánuje. */
const HORIZON_MINUTES = 10;

/** Kolik smí FlightHub start odložit, než ho zahodí. */
const LATEST_BEGIN_SLACK_MINUTES = 5;

interface PatrolRow {
  id: string;
  name: string;
  wayline_uuid: string;
  window_from: string;
  window_to: string;
  days: IsoWeekday[];
  interval_minutes: number;
  sites: { name: string; timezone: string; dock_sn: string | null } | null;
}

function authorized(request: NextRequest): boolean {
  const expected = process.env.CRON_SECRET;
  // Bez nastaveného tajemství se endpoint nespustí vůbec — otevřený
  // cron by dovolil komukoli zakládat lety.
  if (!expected) return false;

  const header = request.headers.get("authorization") ?? "";
  const provided = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
}

export async function GET(request: NextRequest): Promise<Response> {
  if (!authorized(request)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const now = new Date();
  const until = new Date(now.getTime() + HORIZON_MINUTES * 60_000);
  const db = supabaseAdmin();

  const { data: patrols, error } = await db
    .from("patrols")
    .select(
      "id, name, wayline_uuid, window_from, window_to, days, interval_minutes, sites(name, timezone, dock_sn)",
    )
    .eq("enabled", true)
    .returns<PatrolRow[]>();

  if (error) {
    console.error("Načtení hlídek selhalo", { message: error.message });
    return Response.json({ error: "patrols_query_failed" }, { status: 500 });
  }

  const report = {
    checked: patrols?.length ?? 0,
    scheduled: 0,
    skipped: 0,
    failed: 0,
  };

  for (const patrol of patrols ?? []) {
    const site = patrol.sites;
    if (!site) {
      report.skipped += 1;
      continue;
    }

    // Bez sériového čísla docku není kam let poslat. Portál to hlásí
    // u lokality; tady se hlídka jen přeskočí, ať cron nespadne.
    if (!site.dock_sn) {
      console.warn("Hlídka bez sériového čísla docku", {
        patrol_id: patrol.id,
        site: site.name,
      });
      report.skipped += 1;
      continue;
    }

    const runs = patrolRunsBetween(
      {
        window_from: patrol.window_from,
        window_to: patrol.window_to,
        days: patrol.days,
        interval_minutes: patrol.interval_minutes,
        timezone: site.timezone,
      },
      now,
      until,
    );

    for (const beginAt of runs) {
      const iso = beginAt.toISOString();

      // Nejdřív dotaz, aby se zbytečně nevolal FlightHub. Skutečnou
      // zárukou je ale unikátní index — mezi dotazem a zápisem může
      // proběhnout jiný běh cronu.
      const { data: existing } = await db
        .from("flights")
        .select("id")
        .eq("patrol_id", patrol.id)
        .eq("started_at", iso)
        .limit(1);

      if (existing && existing.length > 0) {
        report.skipped += 1;
        continue;
      }

      const label = new Intl.DateTimeFormat("cs-CZ", {
        timeZone: site.timezone,
        hourCycle: "h23",
        day: "numeric",
        month: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      }).format(beginAt);

      const task = await createFlightTask({
        name: `${patrol.name} ${label}`,
        dockSn: site.dock_sn,
        waylineUuid: patrol.wayline_uuid,
        timeZone: site.timezone,
        beginAt,
        latestBeginAt: new Date(
          beginAt.getTime() + LATEST_BEGIN_SLACK_MINUTES * 60_000,
        ),
      });

      if (!task.ok || !task.taskUuid) {
        console.error("Naplánování hlídky selhalo", {
          patrol_id: patrol.id,
          begin_at: iso,
          http_status: task.httpStatus,
          response: task.response,
        });
        report.failed += 1;
        continue;
      }

      const { error: insertError } = await db.from("flights").insert({
        kind: "patrol",
        patrol_id: patrol.id,
        fh_task_uuid: task.taskUuid,
        started_at: iso,
        status: "pending",
      });

      if (insertError) {
        // 23505 znamená, že slot mezitím založil jiný běh — není to
        // chyba, jen souběh.
        if (insertError.code === "23505") {
          report.skipped += 1;
        } else {
          console.error("Zápis letu hlídky selhal", {
            patrol_id: patrol.id,
            begin_at: iso,
            message: insertError.message,
          });
          report.failed += 1;
        }
        continue;
      }

      report.scheduled += 1;
    }
  }

  return Response.json(report, { status: 200 });
}
