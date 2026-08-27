import { supabaseAdmin } from "../supabase-admin.ts";
import {
  DETECTION_OBJECT_CLASS_LABELS,
  DISPATCH_OUTCOME_LABELS,
  type DetectionObjectClass,
  type DecisionReason,
  type DispatchInsert,
  type DispatchLevel,
  type DispatchOutcome,
  type FlightConditions,
} from "../../types/database.ts";

import {
  BASE_LEVEL_BY_CLASS,
  PERSON_ESCALATION_WINDOW_SECONDS,
  applyZoneFloor,
  decideDispatch,
  resolveDispatchLevel,
  type LastDispatch,
} from "./decision.ts";
import { notify, type NotifyResult } from "../push/send.ts";
import { checkDockReadiness } from "./dock-readiness.ts";
import {
  DEFAULT_RTH_ALTITUDE,
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
// ═══ Zásah letí OKAMŽITĚ ═══════════════════════════════════════════
// Ne přes workflow trigger — ten čeká na ruční potvrzení v Message
// Centru a bez kliknutí nevzlétne (viz flighthub.ts). Zásah jde tedy
// přes POST /flight-task, ale s task_type 'immediate': startuje hned
// a funguje i na vypnutý dron. Ověřeno naostro — 20 s od příkazu do
// vzletu, minuta na místo.
//
// Časy se neposílají vůbec. Dřív se úloha zakládala jako 'timed'
// s minutovým odkladem, protože se věřilo, že jinak uspaný dron
// nevzlétne; ta minuta byla ve skutečnosti jen minuta, po kterou dron
// nebyl nad zónou. Hlídky zůstávají 'timed' — tam je plánování dopředu
// záměr, ne omezení.
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
 * Stupeň ručního zásahu.
 *
 * Nejvyšší, a to bez eskalace: tlačítko nemačká detektor, ale operátor,
 * který se na obraz díval. Odvozovat stupeň z třídy objektu tu nejde —
 * žádná detekce v tom není.
 */
export const MANUAL_DISPATCH_LEVEL: DispatchLevel = 5;

export interface DispatchContext {
  /**
   * Detekce, na kterou se reaguje.
   *
   * NULL u ručního zásahu z portálu — schéma dispatches to má takhle
   * popsané od první migrace („NULL = ruční výjezd z portálu“), jen ta
   * cesta dosud neexistovala. Vyrábět kvůli tlačítku falešnou detekci
   * by znamenalo zapsat do důkazní tabulky událost, kterou nikdo
   * neviděl.
   */
  detectionId: string | null;
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
  /**
   * Výška návratu domů v metrech (`sites.rth_altitude`). NULL =
   * nezjištěno, použije se DEFAULT_RTH_ALTITUDE.
   *
   * Nad stropem projektu ve FlightHubu se mise nespustí, takže tohle
   * není kosmetika — je to rozdíl mezi „dron letí“ a „nic se nestalo
   * a nikdo neví proč“.
   */
  siteRthAltitude: number | null;
  /** Trasa zóny ve FlightHubu. Bez ní se úloha nedá založit. */
  zoneWaylineUuid: string | null;
  /**
   * `zones.default_level` — spodní hranice stupně pro tuhle zónu.
   * NULL = nezjištěno; stupeň pak vyjde jen z toho, co se vidělo.
   */
  zoneDefaultLevel: number | null;
  /**
   * Ohlášený příjezd, kterému vjezd odpovídal. Když je vyplněný,
   * rozhodování se dál neřeší: zásah se nepošle a důvod se zapíše.
   * Migrace 20260906120000.
   */
  announcedArrival?: NonNullable<DecisionReason["announced_arrival"]>;
  /**
   * Ruční zásah z portálu: kdo na tlačítko sáhl. Nevynechává žádnou
   * kontrolu — ostrý režim, cooldown i stav doku platí stejně jako
   * u detekce. Mění jen to, co se zapíše do důvodu: rozhodl člověk,
   * ne třída objektu.
   */
  manual?: { actorId: string | null };
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
  /** null = stav se nepodařilo zjistit. */
  isSiteArmed(context: ResolvedDispatchContext): Promise<boolean | null>;
  lastSentDispatchAt(context: ResolvedDispatchContext): Promise<LastDispatch>;
  /** null = nepodařilo se zjistit; zásah to nezastaví, jen nezvedne. */
  hasRecentPersonInOtherZone(
    context: ResolvedDispatchContext,
  ): Promise<boolean | null>;
  getDockState(dockSn: string): Promise<DockStateResult>;
  createFlightTask(input: FlightTaskInput): Promise<FlightTaskResult>;
  insertDispatch(row: DispatchRow): Promise<string | null>;
  insertFlight(plan: FlightPlan): Promise<void>;
  notifyDispatch(input: DispatchNotification): Promise<NotifyResult>;
}

/** Co se pošle do notifikace o zásahu. */
export interface DispatchNotification {
  dispatchId: string;
  siteId: string;
  zoneName: string | null;
  outcome: DispatchOutcome;
  level: DispatchLevel;
  objectClass: DetectionObjectClass;
  /** Ruční zásah z portálu — v textu se nesmí tvářit jako detekce. */
  manual?: boolean;
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

/**
 * Byla v posledních 60 s osoba v jiné zóně téhož areálu?
 *
 * Vrací null, když se to nepodařilo zjistit. Dřív se v tom případě
 * vracelo `false` — eskalace se tím tiše vypnula a nikde po tom
 * nezůstala stopa. Volající to bere jako fail-open: poletí se na
 * základním stupni, protože nižší stupeň je pořád zásah.
 */
async function hasRecentPersonInOtherZone(
  context: ResolvedDispatchContext,
): Promise<boolean | null> {
  const since = new Date(
    context.detectedAt.getTime() - PERSON_ESCALATION_WINDOW_SECONDS * 1_000,
  ).toISOString();

  // Detekce nedrží site_id, tak se filtruje přes kamery daného areálu.
  const { data: cameras, error: camerasError } = await supabaseAdmin()
    .from("cameras")
    .select("id")
    .eq("site_id", context.siteId);

  if (camerasError) {
    console.error("Dotaz na kamery lokality selhal — eskalace se neposoudí", {
      detection_id: context.detectionId,
      site_id: context.siteId,
      message: camerasError.message,
    });
    return null;
  }

  // Lokalita bez kamer není chyba: není kde se pohybovat, tedy není co
  // eskalovat. To je odpověď, ne neznalost.
  if (!cameras || cameras.length === 0) return false;

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
    .limit(1);

  // Vlastní detekce se nepočítá — eskaluje jen pohyb JINDE. U ručního
  // zásahu není co vylučovat, žádná detekce mu nepředcházela.
  if (context.detectionId) query = query.neq("id", context.detectionId);

  query = context.zoneId
    ? query.neq("zone_id", context.zoneId)
    : // Detekce bez zóny nemá co vylučovat; bere se každá jiná zóna.
      query.not("zone_id", "is", null);

  const { data, error } = await query;
  if (error) {
    console.error("Dotaz na sousední zóny selhal — eskalace se neposoudí", {
      detection_id: context.detectionId,
      site_id: context.siteId,
      message: error.message,
    });
    return null;
  }
  return (data?.length ?? 0) > 0;
}

/**
 * Čas posledního skutečně odeslaného zásahu na lokalitě.
 *
 * Rozlišuje „žádný zásah zatím nebyl“ od „nepodařilo se zjistit“.
 * Dřív z obojího vycházelo `null` a cooldown se tím tiše vypnul —
 * po nedostupném dotazu mohl odletět druhý dron na totéž.
 */
async function lastSentDispatchAt(
  context: ResolvedDispatchContext,
): Promise<LastDispatch> {
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

  if (error) {
    console.error("Dotaz na poslední zásah selhal — cooldown se neposoudí", {
      detection_id: context.detectionId,
      site_id: context.siteId,
      message: error.message,
    });
    return { known: false, at: null };
  }

  if (!data || data.length === 0) return { known: true, at: null };
  return { known: true, at: new Date(data[0].sent_at) };
}

/**
 * Střeží lokalita v okamžiku přijetí?
 *
 * Vrací null, když se to nepodařilo zjistit. Dřív se vracelo `false`
 * a v dispatches zůstalo `suppressed_disarmed` — detail zásahu pak
 * tvrdil „lokalita v tu chvíli nestřežila“, což je tvrzení o areálu,
 * ne o nedostupné databázi. Zásah se neposílá v obou případech, ale
 * záznam o tom musí říkat pravdu.
 */
async function isSiteArmedInDb(
  context: ResolvedDispatchContext,
): Promise<boolean | null> {
  const { data, error } = await supabaseAdmin().rpc("site_is_armed", {
    p_site_id: context.siteId,
    // Čas přijetí, ne hlášený čas z těla požadavku.
    p_at: context.receivedAt.toISOString(),
  });

  if (error) {
    console.error("Zjištění režimu střežení selhalo — zásah se neposílá", {
      detection_id: context.detectionId,
      site_id: context.siteId,
      message: error.message,
    });
    return null;
  }

  // Cokoli jiného než true je „nestřeží“; funkce vrací boolean.
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
  const [armed, lastSent, recentPerson] = await Promise.all([
    // Vypnutá zóna se chová jako mimo ostrý režim. To je rozhodnutí,
    // ne neznalost — proto false, ne null.
    context.zoneEnabled ? deps.isSiteArmed(context) : Promise.resolve(false),
    deps.lastSentDispatchAt(context),
    // Ruční zásah jede rovnou na nejvyšší stupeň, takže není co
    // eskalovat — a dotaz, jehož výsledek nikdo nepoužije, by se jen
    // mohl nepovést a zbytečně zapsat do neznámých vstupů.
    context.manual ? Promise.resolve(false) : deps.hasRecentPersonInOtherZone(context),
  ]);

  // Co se nepodařilo zjistit. Ukládá se do důvodu, ne jen do logu:
  // za měsíc se nikdo nedozví z logu, proč zrovna tenhle zásah
  // neodešel, ale z detailu ano.
  const neznamé: NonNullable<DecisionReason["unknown_inputs"]> = [];
  if (armed === null) neznamé.push("armed");
  if (!lastSent.known) neznamé.push("cooldown");
  if (recentPerson === null) neznamé.push("escalation");

  if (neznamé.length > 0) {
    console.warn("Zásah se rozhoduje s neúplnými vstupy", {
      detection_id: context.detectionId,
      site_id: context.siteId,
      neznamé,
    });
  }

  const spocteny = context.manual
    ? MANUAL_DISPATCH_LEVEL
    : resolveDispatchLevel(context.objectClass, recentPerson);
  // Spodní hranice zóny stupeň jen zvedá. Exponované místo se nemá
  // řešit jako okraj pozemku, i když detektor viděl v obou případech
  // totéž.
  const level = applyZoneFloor(spocteny, context.zoneDefaultLevel);
  const decision = decideDispatch({
    armed,
    cooldownSeconds: context.siteCooldownSeconds,
    lastSent,
    // Rovněž čas přijetí. S hlášeným časem by šlo cooldown obejít
    // detekcí datovanou o pět minut zpět.
    at: context.receivedAt,
  });

  // Důvod se ukládá spolu se zásahem. Databáze si dřív pamatovala jen
  // výsledek, takže detail zásahu musel rozhodnutí rekonstruovat — a po
  // každé změně pravidel by staré zásahy vyprávěly novou verzi.
  const elapsedSeconds =
    lastSent.known && lastSent.at
      ? (context.receivedAt.getTime() - lastSent.at.getTime()) / 1000
      : null;

  const reason: DecisionReason = {
    // Ruční zásah nemá třídu objektu. Zapsat sem „neurčeno“ by z něj
    // v detailu udělalo detekci, která se nezdařila přečíst.
    object_class: context.manual ? null : context.objectClass,
    base_level: context.manual
      ? MANUAL_DISPATCH_LEVEL
      : BASE_LEVEL_BY_CLASS[context.objectClass],
    level_sent: level,
    escalated: recentPerson === true,
    escalation:
      recentPerson === true
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
    // Hranice zóny se ukládá vždycky, i když nic nezvedla — jinak by
    // z detailu nešlo poznat, jestli stupeň vyšel z detekce, nebo
    // z nastavení zóny.
    zone_default_level: context.zoneDefaultLevel,
    zone_floor_applied: level > spocteny,
    dock: null,
    ...(context.manual ? { manual: { actor_id: context.manual.actorId } } : {}),
    ...(neznamé.length > 0 ? { unknown_inputs: neznamé } : {}),
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

  // Ohlášený příjezd přebíjí i rozhodnutí o odeslání. Až za výpočtem
  // důvodu, aby v něm zůstalo vidět, jak by to dopadlo bez ohlášení —
  // jinak by z evidence nešlo poznat, jestli ohlášení něco zachránilo,
  // nebo se stejně neletělo.
  if (context.announcedArrival) {
    reason.announced_arrival = context.announcedArrival;
    return bezLetu("suppressed_announced", {
      error: "announced_arrival",
      arrival_id: context.announcedArrival.id,
    });
  }

  if (!decision.send) {
    return bezLetu(decision.outcome, { cause: decision.cause });
  }

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

  const zoneLabel = context.zoneName ?? "neznámá zóna";
  const rthAltitude = context.siteRthAltitude ?? DEFAULT_RTH_ALTITUDE;
  reason.rth_altitude_m = rthAltitude;

  // Okamžik odeslání. U immediate úlohy není co plánovat, ale řádek
  // letu potřebuje čas, od kterého se počítá — a sync si ho stejně
  // přepíše skutečným začátkem z trajektorie.
  const beginAt = new Date();

  const result = await deps.createFlightTask({
    taskType: "immediate",
    rthAltitude,
    // Stupeň jde do názvu: plánovaná úloha pole pro úroveň nemá,
    // takže jinak by v DJI nebylo poznat, jak vážný zásah to byl.
    name: context.manual
      ? `Ruční zásah — ${zoneLabel}`
      : `Zásah ${level} — ${zoneLabel}`,
    dockSn: context.siteDockSn,
    waylineUuid: context.zoneWaylineUuid,
    timeZone: context.siteTimezone,
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
        level_sent: applyZoneFloor(
          resolveDispatchLevel(resolved.objectClass, null),
          resolved.zoneDefaultLevel,
        ),
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

    // Notifikace až nakonec a nikdy jako podmínka výsledku: je to
    // doplněk k zapsanému zásahu, ne jeho součást. Selhání odeslání
    // nesmí z odeslaného zásahu udělat neodeslaný.
    if (dispatchId) {
      try {
        await deps.notifyDispatch({
          dispatchId,
          siteId: resolved.siteId,
          zoneName: resolved.zoneName,
          outcome: row.outcome,
          level: row.level_sent,
          objectClass: resolved.objectClass,
          manual: Boolean(resolved.manual),
        });
      } catch (error) {
        console.error("Notifikace o zásahu selhala", {
          dispatch_id: dispatchId,
          message: safeErrorMessage(error),
        });
      }
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

/**
 * Notifikace o zásahu.
 *
 * Odeslaný a neodeslaný zásah jsou pro uživatele dvě různé zprávy,
 * takže i dva druhy odběru. `failed` spadá pod „zásah potlačen“
 * schválně: z pohledu člověka u telefonu je podstatné, že dron
 * nevzlétl, a čím to bylo, řekne text.
 */
async function notifyDispatch(input: DispatchNotification): Promise<NotifyResult> {
  const zona = input.zoneName ?? "neznámá zóna";
  // U ručního zásahu žádná detekce není; „(neurčeno)“ by v notifikaci
  // vypadalo jako selhaný detektor.
  const podnet = input.manual
    ? "na ruční pokyn"
    : `k detekci (${DETECTION_OBJECT_CLASS_LABELS[input.objectClass].toLowerCase()})`;
  const zapsano = input.manual
    ? "Ruční zásah zapsaný"
    : `Detekce (${DETECTION_OBJECT_CLASS_LABELS[input.objectClass].toLowerCase()}) zapsaná`;

  if (input.outcome === "sent") {
    return notify({
      siteId: input.siteId,
      kind: "dispatch_sent",
      title: `Zásah odeslán — ${zona}`,
      body: `Dron letí ${podnet}, stupeň ${input.level}.`,
      url: `/zasahy/${input.dispatchId}`,
      // Vlastní tag na zásah: dva zásahy za sebou se nemají přepsat.
      tag: `dispatch-${input.dispatchId}`,
    });
  }

  const duvod =
    input.outcome === "failed"
      ? "Odeslání do FlightHubu selhalo."
      : `${DISPATCH_OUTCOME_LABELS[input.outcome]}.`;

  return notify({
    siteId: input.siteId,
    kind: "dispatch_suppressed",
    title: `Zásah neodešel — ${zona}`,
    body: `${zapsano}, dron nevzlétl. ${duvod}`,
    url: `/zasahy/${input.dispatchId}`,
    tag: `dispatch-${input.dispatchId}`,
  });
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
  notifyDispatch,
};
