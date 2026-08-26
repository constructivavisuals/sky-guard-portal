import { supabaseAdmin } from "../supabase-admin.ts";
import {
  type DetectionObjectClass,
  type DecisionReason,
  type DispatchInsert,
  type DispatchOutcome,
  type FlightConditions,
} from "../../types/database.ts";

import {
  BASE_LEVEL_BY_CLASS,
  PERSON_ESCALATION_WINDOW_SECONDS,
  decideDispatch,
  resolveDispatchLevel,
} from "./decision.ts";
import { checkDockReadiness } from "./dock-readiness.ts";
import {
  createFlightTask,
  getDockState,
  type DockStateResult,
  type FlightTaskInput,
  type FlightTaskResult,
} from "./flighthub.ts";

// Orchestrace zásahu: obstará vstupy pro rozhodovací funkce, zavolá
// FlightHub a uloží řádek do dispatches. Běží až PO odeslání odpovědi
// (next/server `after`), takže se sem nesmí dostat nic, co by muselo
// stihnout 1s limit endpointu.
//
// ═══ Zásah letí jako PLÁNOVANÁ ÚLOHA ═══════════════════════════════
// Ne přes workflow trigger — ten čeká na ruční potvrzení v Message
// Centru a bez kliknutí nevzlétne (viz flighthub.ts). Zásah tedy jede
// touž cestou jako hlídka: POST /flight-task, task_type 'timed',
// začátek za minutu.
//
// Z toho plyne, co všechno musí být připravené, než se dá letět:
//
//   * zóna musí mít TRASU — plánovaná úloha nechce souřadnice, chce
//     wayline_uuid. Zóna bez trasy zásah neodešle.
//   * lokalita musí mít sériové číslo DOKU (ne dronu).
//   * dok musí být ve stavu, ze kterého se dá vzlétnout — táž
//     kritéria jako u hlídek, sdílená v dock-readiness.ts.
//
// Souřadnice zóny se do FlightHubu už neposílají. Zůstávají kvůli
// mapě a detailu zásahu, ale kudy dron letí, určuje trasa — zóna bez
// souřadnic proto zásah nezastaví.
// ═══════════════════════════════════════════════════════════════════

/**
 * Za jak dlouho od rozhodnutí má úloha začít.
 *
 * Minuta je tam proto, že FlightHub odmítá úlohy s časem v minulosti
 * a mezi rozhodnutím a přijetím požadavku uteče kus vteřiny.
 * `latest_begin_at` je stejný: u zásahu nemá smysl start odkládat —
 * dron, který vyrazí o pět minut později, přiletí k prázdné zóně.
 */
export const DISPATCH_LEAD_SECONDS = 60;

export interface DispatchContext {
  detectionId: string;
  siteId: string;
  zoneId: string | null;
  zoneName: string | null;
  zoneEnabled: boolean;
  zoneLocation: string | null;
  siteCooldownSeconds: number;
  /** Časové pásmo lokality; jde do plánované úlohy. */
  siteTimezone: string;
  /** Sériové číslo DOKU, ne dronu. Bez něj není odkud vzlétnout. */
  siteDockSn: string | null;
  /** Trasa zóny ve FlightHubu. Bez ní se úloha nedá založit. */
  zoneWaylineUuid: string | null;
  objectClass: DetectionObjectClass;
  /** Čas hlášený kamerou. Ukládá se, ale nic se podle něj nerozhoduje. */
  detectedAt: Date;
  /**
   * Kdy detekce dorazila na server. Podle tohohle času se vyhodnocuje
   * ostrý režim — detected_at si určuje odesílatel a šlo by jím zásah
   * potlačit tvrzením, že se to stalo mimo hlídané okno.
   */
  receivedAt: Date;
}

/** Kontext poté, co je jisté, že kamera má zónu. */
export type ResolvedDispatchContext = DispatchContext & { zoneId: string };

export type DispatchRow = DispatchInsert & {
  site_id: string;
  zone_id: string;
  outcome: DispatchOutcome;
};

export type DispatchRunResult =
  | { status: "skipped"; reason: string }
  | { status: "recorded"; outcome: DispatchOutcome; dispatchId: string | null }
  // Zápis samotný selhal — v dispatches nezůstalo nic. Nastane jen když
  // je nedostupná i databáze, tedy když stopu není kam uložit.
  | { status: "unrecorded"; reason: string };

/**
 * Vstupy, které runDispatch potřebuje zvenčí. Výchozí implementace níž
 * sahá do databáze a na FlightHub; testy si podstrčí vlastní, takže jde
 * ověřit i chování při výjimce, aniž by běžela DB.
 */
export interface DispatchDeps {
  isSiteArmed(context: ResolvedDispatchContext): Promise<boolean>;
  lastSentDispatchAt(context: ResolvedDispatchContext): Promise<Date | null>;
  hasRecentPersonInOtherZone(
    context: ResolvedDispatchContext,
  ): Promise<boolean>;
  getDockState(dockSn: string): Promise<DockStateResult>;
  createFlightTask(input: FlightTaskInput): Promise<FlightTaskResult>;
  insertDispatch(row: DispatchRow): Promise<string | null>;
  insertFlight(plan: FlightPlan): Promise<void>;
}

/**
 * Let, který se má založit po zapsání zásahu.
 *
 * Zakládá se až po něm, protože potřebuje dispatch_id — a bez řádku
 * ve flights by synchronizace o úloze nevěděla a trasa ani snímky by
 * se nikdy nedotáhly.
 */
export interface FlightPlan {
  siteId: string;
  dispatchId: string;
  fhTaskUuid: string;
  beginAt: Date;
  conditions: FlightConditions | null;
}

/** Byla v posledních 60 s osoba v jiné zóně téhož areálu? */
async function hasRecentPersonInOtherZone(
  context: ResolvedDispatchContext,
): Promise<boolean> {
  const since = new Date(
    context.detectedAt.getTime() - PERSON_ESCALATION_WINDOW_SECONDS * 1_000,
  ).toISOString();

  // Detekce nedrží site_id, tak se filtruje přes kamery daného areálu.
  const { data: cameras, error: camerasError } = await supabaseAdmin()
    .from("cameras")
    .select("id")
    .eq("site_id", context.siteId);

  if (camerasError || !cameras || cameras.length === 0) return false;

  let query = supabaseAdmin()
    .from("detections")
    .select("id")
    .in(
      "camera_id",
      cameras.map((camera) => camera.id),
    )
    .eq("object_class", "person")
    .gte("detected_at", since)
    .lte("detected_at", context.detectedAt.toISOString())
    // Vlastní detekce se nepočítá — eskaluje jen pohyb JINDE.
    .neq("id", context.detectionId)
    .limit(1);

  query = context.zoneId
    ? query.neq("zone_id", context.zoneId)
    : // Detekce bez zóny nemá co vylučovat; bere se každá jiná zóna.
      query.not("zone_id", "is", null);

  const { data, error } = await query;
  if (error) return false;
  return (data?.length ?? 0) > 0;
}

/** Čas posledního skutečně odeslaného zásahu na lokalitě. */
async function lastSentDispatchAt(
  context: ResolvedDispatchContext,
): Promise<Date | null> {
  const { data, error } = await supabaseAdmin()
    .from("dispatches")
    .select("sent_at")
    .eq("site_id", context.siteId)
    .eq("outcome", "sent")
    // Čas přijetí, ne hlášený: cooldown je pravidlo o tom, jak často
    // smí dron vzlétnout, a to se řídí skutečností, ne tím, co kamera
    // o sobě tvrdí.
    .lte("sent_at", context.receivedAt.toISOString())
    .order("sent_at", { ascending: false })
    .limit(1);

  if (error || !data || data.length === 0) return null;
  return new Date(data[0].sent_at);
}

async function isSiteArmedInDb(context: ResolvedDispatchContext): Promise<boolean> {
  const { data, error } = await supabaseAdmin().rpc("site_is_armed", {
    p_site_id: context.siteId,
    // Čas přijetí, ne hlášený čas z těla požadavku.
    p_at: context.receivedAt.toISOString(),
  });

  // Když se stav nedá zjistit, zásah neposíláme — planý let stojí víc
  // než zmeškaný, a v dispatches zůstane stopa proč.
  if (error) return false;
  return data === true;
}

/** Text výjimky pro uložení — bez hodnot proměnných, viz flighthub.ts. */
function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 500);
}

interface PreparedDispatch {
  row: DispatchRow;
  /** null, když se neletí. */
  flight: Omit<FlightPlan, "dispatchId"> | null;
}

/**
 * Sestaví řádek do dispatches: obstará vstupy, rozhodne a případně
 * naplánuje úlohu. Nic nezapisuje — zápis dělá runDispatch, aby i
 * výjimka odsud skončila zapsaným pokusem.
 */
async function prepareDispatchRow(
  context: ResolvedDispatchContext,
  deps: DispatchDeps,
): Promise<PreparedDispatch> {
  const [armed, lastSentAt, recentPerson] = await Promise.all([
    // Vypnutá zóna se chová jako mimo ostrý režim.
    context.zoneEnabled ? deps.isSiteArmed(context) : Promise.resolve(false),
    deps.lastSentDispatchAt(context),
    deps.hasRecentPersonInOtherZone(context),
  ]);

  const level = resolveDispatchLevel(context.objectClass, recentPerson);
  const decision = decideDispatch({
    armed,
    cooldownSeconds: context.siteCooldownSeconds,
    lastSentAt,
    // Rovněž čas přijetí. S hlášeným časem by šlo cooldown obejít
    // detekcí datovanou o pět minut zpět.
    at: context.receivedAt,
  });

  // Důvod se ukládá spolu se zásahem. Databáze si dřív pamatovala jen
  // výsledek, takže detail zásahu musel rozhodnutí rekonstruovat — a po
  // každé změně pravidel by staré zásahy vyprávěly novou verzi.
  const elapsedSeconds = lastSentAt
    ? (context.receivedAt.getTime() - lastSentAt.getTime()) / 1000
    : null;

  const reason: DecisionReason = {
    object_class: context.objectClass,
    base_level: BASE_LEVEL_BY_CLASS[context.objectClass],
    level_sent: level,
    escalated: recentPerson,
    escalation: recentPerson
      ? {
          reason: "person_in_other_zone",
          window_seconds: PERSON_ESCALATION_WINDOW_SECONDS,
        }
      : null,
    armed,
    zone_enabled: context.zoneEnabled,
    cooldown_seconds: context.siteCooldownSeconds,
    seconds_since_last_sent: elapsedSeconds === null ? null : Math.round(elapsedSeconds),
    cooldown_remaining_seconds:
      elapsedSeconds === null
        ? null
        : Math.max(0, Math.round(context.siteCooldownSeconds - elapsedSeconds)),
    zone_has_wayline: Boolean(context.zoneWaylineUuid),
    dock: null,
    decided_at: new Date().toISOString(),
  };

  const base = {
    site_id: context.siteId,
    zone_id: context.zoneId,
    triggered_by_detection: context.detectionId,
    level_sent: level,
    decision_reason: reason,
  };

  /** Zkratka pro „neletí se“ — pořád se zapisuje, jen bez úlohy. */
  const bezLetu = (
    outcome: DispatchOutcome,
    response: Record<string, unknown>,
  ): PreparedDispatch => ({
    row: {
      ...base,
      outcome,
      fh_incident_uuid: null,
      fh_task_uuid: null,
      http_status: null,
      response: response as DispatchRow["response"],
    },
    flight: null,
  });

  if (!decision.send) return bezLetu(decision.outcome, {});

  // ── Co musí být připravené, než se dá letět ────────────────────
  // Konfigurace první: pozná se bez volání po síti a je to chyba,
  // kterou má někdo opravit, ne provozní stav, co sám přejde.

  if (!context.zoneWaylineUuid) {
    // Bez trasy se plánovaná úloha nedá založit. Loguje se, protože
    // jinak je tenhle stav nerozeznatelný od klidné noci — a přehled
    // na něj upozorňuje varováním „zóna bez trasy“.
    console.warn("Zóna bez trasy — zásah neodejde", {
      detection_id: context.detectionId,
      zone_id: context.zoneId,
      site_id: context.siteId,
    });
    return bezLetu("failed", {
      error: "zone_without_wayline",
      zone_id: context.zoneId,
    });
  }

  if (!context.siteDockSn) {
    console.warn("Lokalita bez sériového čísla doku — zásah neodejde", {
      detection_id: context.detectionId,
      site_id: context.siteId,
    });
    return bezLetu("failed", { error: "site_without_dock_sn" });
  }

  // ── Stav doku ──────────────────────────────────────────────────
  // Táž kritéria jako u hlídek. Nevyhovující dok NENÍ chyba: dron
  // mimo dok nebo vybitá baterie jsou provozní stavy, na které se dá
  // reagovat — proto suppressed_dock, ne failed.

  const dock = await deps.getDockState(context.siteDockSn);

  if (!dock.ok) {
    reason.dock = {
      ok: false,
      reason: "unreachable",
      drone_in_dock: null,
      battery_percent: null,
      storage_used_percent: null,
    };
    console.warn("Stav doku se nepodařilo zjistit — zásah neodejde", {
      detection_id: context.detectionId,
      dock_sn: context.siteDockSn,
      message: dock.message,
    });
    return bezLetu("suppressed_dock", {
      error: "dock_unreachable",
      message: dock.message,
    });
  }

  const state = dock.state;
  const readiness = checkDockReadiness(state);
  reason.dock = {
    ok: readiness.ok,
    reason: readiness.reason,
    drone_in_dock: state.droneInDock,
    battery_percent: state.batteryPercent,
    storage_used_percent:
      state.storageUsedPercent === null
        ? null
        : Math.round(state.storageUsedPercent * 10) / 10,
  };

  if (!readiness.ok) {
    console.warn("Dok není připravený — zásah neodejde", {
      detection_id: context.detectionId,
      dock_sn: context.siteDockSn,
      duvod: readiness.reason,
      battery_percent: state.batteryPercent,
      storage_used_percent: state.storageUsedPercent,
      drone_status: state.droneStatus,
    });
    return bezLetu("suppressed_dock", {
      error: "dock_not_ready",
      reason: readiness.reason,
    });
  }

  // ── Plánovaná úloha ────────────────────────────────────────────

  const beginAt = new Date(Date.now() + DISPATCH_LEAD_SECONDS * 1_000);
  const zoneLabel = context.zoneName ?? "neznámá zóna";

  const result = await deps.createFlightTask({
    // Stupeň jde do názvu: plánovaná úloha pole pro úroveň nemá,
    // takže jinak by v DJI nebylo poznat, jak vážný zásah to byl.
    name: `Zásah ${level} — ${zoneLabel}`,
    dockSn: context.siteDockSn,
    waylineUuid: context.zoneWaylineUuid,
    timeZone: context.siteTimezone,
    beginAt,
    latestBeginAt: beginAt,
  });

  return {
    row: {
      ...base,
      outcome: result.ok ? "sent" : "failed",
      fh_incident_uuid: null,
      fh_task_uuid: result.taskUuid,
      http_status: result.httpStatus,
      response: result.response,
    },
    flight:
      result.ok && result.taskUuid
        ? {
            siteId: context.siteId,
            fhTaskUuid: result.taskUuid,
            beginAt,
            conditions: state.conditions,
          }
        : null,
  };
}

export async function runDispatch(
  context: DispatchContext,
  deps: DispatchDeps = databaseDeps,
): Promise<DispatchRunResult> {
  // Bez zóny není kam letět a schéma dispatches ani zónu nepovoluje NULL.
  //
  // Loguje se, protože jinak je tenhle stav nerozeznatelný od klidné
  // noci: detekce se zapíše, v dispatches nezůstane nic a nikdo se
  // nedozví, že kamera hlídá naprázdno. Přehled na to navíc upozorňuje
  // varováním „kamery bez zóny“.
  if (!context.zoneId) {
    console.warn("Detekce bez zóny — zásah nevznikne", {
      detection_id: context.detectionId,
      site_id: context.siteId,
    });
    return { status: "skipped", reason: "camera_without_zone" };
  }

  const resolved: ResolvedDispatchContext = { ...context, zoneId: context.zoneId };

  let prepared: PreparedDispatch;
  try {
    prepared = await prepareDispatchRow(resolved, deps);
  } catch (error) {
    // Cokoli neočekávaného — chybějící proměnná prostředí, rozbité
    // spojení, chyba v dotazu — skončí zapsaným pokusem. Pokus o zásah
    // nesmí zmizet jen do logu.
    console.error("Příprava zásahu selhala", {
      detection_id: context.detectionId,
      message: safeErrorMessage(error),
    });
    prepared = {
      row: {
        site_id: resolved.siteId,
        zone_id: resolved.zoneId,
        triggered_by_detection: resolved.detectionId,
        // Bez dat o okolních zónách se eskalace nedá posoudit, bere se
        // základní stupeň podle toho, co kamera viděla.
        level_sent: resolveDispatchLevel(resolved.objectClass, false),
        outcome: "failed",
        fh_incident_uuid: null,
        fh_task_uuid: null,
        http_status: null,
        response: { error: "dispatch_error", message: safeErrorMessage(error) },
      },
      flight: null,
    };
  }

  const { row, flight } = prepared;

  try {
    const dispatchId = await deps.insertDispatch(row);

    // Let se zakládá až po zásahu, protože potřebuje jeho id. Bez
    // řádku ve flights by synchronizace o úloze nevěděla a trasa ani
    // snímky by se nikdy nedotáhly — dron by letěl, ale v portálu by
    // po něm nezůstalo nic.
    if (flight && dispatchId) {
      try {
        await deps.insertFlight({ ...flight, dispatchId });
      } catch (error) {
        // Úloha je ve FlightHubu založená, dron poletí. Zásah je
        // zapsaný a nese fh_task_uuid, takže se let dá dohledat ručně;
        // shodit kvůli tomu celý výsledek by bylo horší.
        console.error("Zápis letu k zásahu selhal", {
          dispatch_id: dispatchId,
          fh_task_uuid: flight.fhTaskUuid,
          message: safeErrorMessage(error),
        });
      }
    } else if (flight && !dispatchId) {
      // Zápis zásahu neprošel, takže na co let navěsit není. Úloha ale
      // ve FlightHubu je — musí to být vidět v logu, jinak vzlétne dron
      // bez jediné stopy v portálu.
      console.error("Úloha založena, ale zásah se nezapsal", {
        detection_id: context.detectionId,
        fh_task_uuid: flight.fhTaskUuid,
      });
    }

    return { status: "recorded", outcome: row.outcome, dispatchId };
  } catch (error) {
    // Poslední instance: nefunguje ani zápis, stopu není kam uložit.
    console.error("Zápis dispatche vyhodil výjimku", {
      detection_id: context.detectionId,
      message: safeErrorMessage(error),
    });
    return { status: "unrecorded", reason: safeErrorMessage(error) };
  }
}

async function insertDispatch(row: DispatchRow): Promise<string | null> {
  const { data, error } = await supabaseAdmin()
    .from("dispatches")
    .insert(row)
    .select("id")
    .single();

  if (error) {
    console.error("Zápis dispatche selhal", {
      site_id: row.site_id,
      outcome: row.outcome,
      message: error.message,
    });
    return null;
  }

  return (data as { id: string }).id;
}

/**
 * Založí let k zásahu, aby ho synchronizace dotáhla.
 *
 * kind 'dispatch' a dispatch_id ho odliší od hlídkových; started_at je
 * plánovaný začátek, který si sync později přepíše skutečným časem
 * z trajektorie.
 */
async function insertFlight(plan: FlightPlan): Promise<void> {
  const { error } = await supabaseAdmin().from("flights").insert({
    kind: "dispatch",
    site_id: plan.siteId,
    dispatch_id: plan.dispatchId,
    fh_task_uuid: plan.fhTaskUuid,
    started_at: plan.beginAt.toISOString(),
    status: "pending",
    // Počasí v okamžiku plánování; u přerušeného letu je to první věc,
    // na kterou se člověk ptá.
    conditions: plan.conditions,
  });

  if (error) throw new Error(error.message);
}

/** Výchozí závislosti — databáze a skutečný FlightHub. */
export const databaseDeps: DispatchDeps = {
  isSiteArmed: isSiteArmedInDb,
  lastSentDispatchAt,
  hasRecentPersonInOtherZone,
  getDockState,
  createFlightTask,
  insertDispatch,
  insertFlight,
};
