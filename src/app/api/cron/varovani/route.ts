import { timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";

import { recordCronRun } from "@/lib/cron/record.ts";
import {
  CAMERA_SILENT_MINUTES,
  STORAGE_WARNING_PERCENT,
  PLATE_READ_STUCK_MINUTES,
  STUCK_GRACE_MINUTES,
  STUCK_WINDOW_HOURS,
  silentCameras,
  stuckWorkWarnings,
} from "@/lib/dashboard.ts";
import { checkDockReadiness } from "@/lib/dispatch/dock-readiness.ts";
import { getDockState } from "@/lib/dispatch/flighthub.ts";
import { warningCooldownElapsed } from "@/lib/push/rules.ts";
import { quotaMessage, quotaState } from "@/lib/recordings/quota.ts";
import { notify } from "@/lib/push/send.ts";
import { supabaseAdmin } from "@/lib/supabase-admin.ts";
import { isSiteArmed, type IsoWeekday } from "@/types/database.ts";

// GET /api/cron/varovani
//
// Projde lokality a pošle notifikaci o tom, co se samo neozve: mlčící
// kamera a dok, ze kterého se nedá vzlétnout. Volá se zvenčí cronem,
// stejně jako hlídky a synchronizace — viz README.
//
// ═══ Proč odstup ═══════════════════════════════════════════════════
// Zásah je událost: stane se jednou a jednou se ohlásí. Mlčící kamera
// je STAV — mlčí i za čtvrt hodiny. Bez evidence odstupů by cron
// posílal totéž při každém běhu a uživatel by si notifikace vypnul,
// čímž by přišel i o zásahy. Kdy co naposledy odešlo, drží
// notification_log; odstup je WARNING_COOLDOWN_HOURS.
// ═══════════════════════════════════════════════════════════════════

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface SiteRow {
  id: string;
  name: string;
  dock_sn: string | null;
  /** Strop na objem videa. Migrace 20260918120000. */
  recording_quota_bytes: number | null;
  /** Kvůli vyhodnocení ostrého režimu u detekcí bez zásahu. */
  timezone: string;
  armed_from: string;
  armed_to: string;
  armed_days: IsoWeekday[];
}

interface CameraRow {
  id: string;
  name: string;
  status: string;
  last_seen_at: string | null;
}

interface LogRow {
  kind: string;
  target: string;
  last_sent_at: string;
}

function authorized(request: NextRequest): boolean {
  const expected = process.env.CRON_SECRET;
  // Bez nastaveného tajemství se endpoint nespustí vůbec.
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

  const db = supabaseAdmin();
  const now = new Date();

  const { data: sites, error } = await db
    .from("sites")
    .select(
      "id, name, dock_sn, recording_quota_bytes, timezone, armed_from, " +
        "armed_to, armed_days",
    )
    .returns<SiteRow[]>();

  if (error) {
    console.error("Načtení lokalit selhalo", { message: error.message });
    await recordCronRun("warnings", { error: "sites_query_failed" }, false);
    return Response.json({ error: "sites_query_failed" }, { status: 500 });
  }

  const report = {
    sites: sites?.length ?? 0,
    cameraWarnings: 0,
    dockWarnings: 0,
    /** Detekce bez zásahu a vjezdy bez přečtené značky. */
    stuckWarnings: 0,
    /** Objem záznamů u stropu nebo přes něj. */
    quotaWarnings: 0,
    /** Nalezeno, ale neposláno kvůli odstupu od minula. */
    withinCooldown: 0,
    failed: 0,
  };

  for (const site of sites ?? []) {
    try {
      // Log odstupů pro celou lokalitu jedním dotazem — na lokalitě je
      // řád jednotek událostí, tak je levnější je přivézt všechny.
      const { data: logRows } = await db
        .from("notification_log")
        .select("kind, target, last_sent_at")
        .eq("site_id", site.id)
        .returns<LogRow[]>();

      const posledni = new Map<string, string>();
      for (const row of logRows ?? []) {
        posledni.set(`${row.kind}:${row.target}`, row.last_sent_at);
      }

      /** Poslat, jen když od minula uplynul odstup. */
      const poslat = async (
        kind: "camera_silent" | "dock_problem" | "processing_stuck" | "storage_quota",
        target: string,
        zprava: { title: string; body: string; url: string },
      ) => {
        if (!warningCooldownElapsed(posledni.get(`${kind}:${target}`), now)) {
          report.withinCooldown += 1;
          return false;
        }

        const result = await notify({
          siteId: site.id,
          kind,
          title: zprava.title,
          body: zprava.body,
          url: zprava.url,
          // Vlastní tag na kameru: dvě mlčící kamery se nemají přepsat.
          tag: `${kind}-${target}`,
          at: now,
        });

        // Razítko se zapisuje i tehdy, když všem adresátům notifikace
        // odpadla předvolbami. Jinak by se stav vyhodnocoval znovu
        // v každém běhu a jediný nově přihlášený uživatel by dostal
        // varování staré tři dny.
        const { error: logError } = await db.from("notification_log").upsert(
          {
            site_id: site.id,
            kind,
            target,
            last_sent_at: now.toISOString(),
          },
          { onConflict: "site_id,kind,target" },
        );
        if (logError) {
          console.error("Zápis odstupu varování selhal", {
            site_id: site.id,
            kind,
            message: logError.message,
          });
        }

        return result.sent > 0 || result.skipped > 0;
      };

      // ── Mlčící kamery ──────────────────────────────────────────
      const { data: cameras } = await db
        .from("cameras")
        .select("id, name, status, last_seen_at")
        .eq("site_id", site.id)
        .neq("status", "decommissioned")
        .returns<CameraRow[]>();

      const ticho = silentCameras(
        (cameras ?? []).map((camera) => ({
          ...camera,
          online: camera.status === "online",
          lastSeenAt: camera.last_seen_at ? new Date(camera.last_seen_at) : null,
        })),
        now,
      );

      for (const camera of ticho) {
        const posláno = await poslat("camera_silent", camera.id, {
          title: `Kamera „${camera.name}“ mlčí`,
          body: `Neozvala se déle než ${CAMERA_SILENT_MINUTES} min, přestože je vedená jako online. ${site.name}.`,
          url: `/arealy/${site.id}/kamery`,
        });
        if (posláno) report.cameraWarnings += 1;
      }

      // ── Nedokončené zpracování ─────────────────────────────────
      // Zásah i čtení značky běží v after(), tedy po odeslání
      // odpovědi. Když Vercel instanci ukončí dřív, práce se ztratí
      // a nikde po ní nezůstane stopa — vypadá to stejně jako
      // „kamera nemá zónu“ nebo „značka nešla přečíst“.
      const od = new Date(now.getTime() - STUCK_WINDOW_HOURS * 3_600_000).toISOString();
      const doKdy = new Date(now.getTime() - STUCK_GRACE_MINUTES * 60_000).toISOString();

      const [detekce, vjezdy] = await Promise.all([
        db
          .from("detections")
          .select("id, detected_at, dispatches!dispatches_triggered_by_detection_fkey(id)")
          .eq("site_id", site.id)
          .gte("detected_at", od)
          .lte("detected_at", doKdy)
          .returns<{ id: string; detected_at: string; dispatches: { id: string }[] }[]>(),
        db
          .from("vehicle_passages")
          .select("id")
          .eq("site_id", site.id)
          .gte("passed_at", od)
          .lte(
            "passed_at",
            new Date(now.getTime() - PLATE_READ_STUCK_MINUTES * 60_000).toISOString(),
          )
          .is("plate_read_at", null)
          // Bez snímku není z čeho číst a prázdný sloupec je v pořádku.
          .not("storage_path", "is", null)
          .returns<{ id: string }[]>(),
      ]);

      const bezZasahu = (detekce.data ?? []).filter(
        (row) =>
          row.dispatches.length === 0 &&
          // Mimo ostrý režim se zásah nezakládá schválně.
          isSiteArmed(site, new Date(row.detected_at)),
      );

      for (const varovani of stuckWorkWarnings({
        detectionsWithoutDispatch: bezZasahu.length,
        passagesWithoutRead: (vjezdy.data ?? []).length,
      })) {
        const posláno = await poslat("processing_stuck", varovani.key, {
          title: `Zpracování nedoběhlo — ${site.name}`,
          body: varovani.text,
          url: "/prehled",
        });
        if (posláno) report.stuckWarnings += 1;
      }

      // ── Strop na objem záznamů ─────────────────────────────────
      //
      // Hetzner tvrdý limit nenabízí, takže je tohle jediné místo, kde
      // se člověk o blížícím se stropu dozví dřív, než portál přestane
      // přijímat. Při 300 GB denně je mezi „85 %“ a „plno“ jen pár dní.
      //
      // Odstup se drží na jednom cíli, ne na procentech: jinak by každý
      // běh po překročení další desítky poslal novou notifikaci.
      const { data: objem, error: objemError } = await db.rpc(
        "site_recording_bytes",
        { p_site_id: site.id },
      );

      if (objemError) {
        // Migrace ještě neběžela. Není to důvod shodit ostatní varování.
        console.warn("Objem záznamů se nepodařilo zjistit", {
          site_id: site.id,
          message: objemError.message,
        });
      } else {
        const stav = quotaState(Number(objem ?? 0), site.recording_quota_bytes);
        if (stav.exceeded || stav.warning) {
          const posláno = await poslat("storage_quota", "recordings", {
            title: stav.exceeded
              ? `Úložiště záznamů je plné — ${site.name}`
              : `Úložiště záznamů se plní — ${site.name}`,
            body: quotaMessage(site.name, stav),
            url: `/arealy/${site.id}`,
          });
          if (posláno) report.quotaWarnings += 1;
        }
      }

      // ── Dok ────────────────────────────────────────────────────
      if (!site.dock_sn) continue;

      const dock = await getDockState(site.dock_sn);
      if (!dock.ok) {
        const posláno = await poslat("dock_problem", "dock", {
          title: `Dok na lokalitě ${site.name} neodpovídá`,
          body: "Stav doku se nepodařilo zjistit, takže nevíme, jestli je dron připravený.",
          url: "/prehled",
        });
        if (posláno) report.dockWarnings += 1;
        continue;
      }

      // Zaplněné úložiště je varování, ne překážka: dron vzlétne
      // i s plnou kartou, jen se nemusí uložit záznam. Hlásí se proto
      // zvlášť a jinou větou — „zásah neodletí“ by tu byla nepravda.
      const uloziste = dock.state.storageUsedPercent;
      if (uloziste !== null && uloziste > STORAGE_WARNING_PERCENT) {
        const posláno = await poslat("dock_problem", "storage", {
          title: `Dok na lokalitě ${site.name} má skoro plné úložiště`,
          body: `Zaplněné na ${Math.round(uloziste)} %. Dron létá dál, ale záznamy z letů se nemusí uložit.`,
          url: "/prehled",
        });
        if (posláno) report.dockWarnings += 1;
      }

      const readiness = checkDockReadiness(dock.state);
      if (readiness.ok) continue;

      const popis: Record<typeof readiness.reason, string> = {
        drone_not_in_dock: "Dron není v doku, takže nemá odkud odstartovat.",
        low_battery:
          dock.state.batteryPercent === null
            ? "Dron nemá dost nabito."
            : `Dron má ${Math.round(dock.state.batteryPercent)} % baterie, pod hranicí pro vzlet.`,
      };

      const posláno = await poslat("dock_problem", "dock", {
        title: `Dok na lokalitě ${site.name} není připravený`,
        body: `${popis[readiness.reason]} Zásah odtud teď neodletí.`,
        url: "/prehled",
      });
      if (posláno) report.dockWarnings += 1;
    } catch (caught) {
      // Selhání jedné lokality nesmí shodit ostatní.
      report.failed += 1;
      console.error("Varování lokality selhala", {
        site_id: site.id,
        message: caught instanceof Error ? caught.message : String(caught),
      });
    }
  }

  // Nenulové failed musí být vidět ve stavu — cron volá někdo zvenčí
  // přes `curl -f` a ten upozorní jen na chybový stav.
  await recordCronRun("warnings", report, report.failed === 0);
  return Response.json(report, { status: report.failed > 0 ? 500 : 200 });
}
