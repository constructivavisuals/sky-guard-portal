import webpush from "web-push";

import { pushConfigured, vapidConfig } from "../env.ts";
import { supabaseAdmin } from "../supabase-admin.ts";
import type { NotificationKind, PushSubscription } from "../../types/database.ts";

import { effectivePrefs, shouldDeliver, type EffectivePrefs } from "./rules.ts";

// Odesílání push notifikací.
//
// ═══ Proč web-push a ne ruční podpis ═══════════════════════════════
// Ověřeno, ne odhadnuto: balíček je čistě JavaScriptový. Závisí jen na
// vestavěných modulech Node (crypto, https, url, util), nemá jediný
// .node soubor, binding.gyp ani install skript. Na Vercelu tedy běží
// v Node runtime bez dalšího zařizování; ruční podpis přes Web Crypto
// by byl řádově víc kódu bez jediné výhody.
//
// Jediná drobnost: posílá přes node:https, ne přes fetch, a endpoint
// musí být https. Skutečné push služby jiné adresy nedávají.
// ═══════════════════════════════════════════════════════════════════
//
// Běží pod service_role, protože se volá z after() a z cronu — žádná
// session tu není. Rozhodování o tom, komu poslat, proto NESMÍ
// spoléhat na RLS a musí si viditelnost lokality odvodit samo.

/** Co se ukáže v notifikaci. Tvar musí znát i service worker. */
export interface PushPayload {
  title: string;
  body: string;
  /** Kam vede klik. Vždy cesta v portálu, ne celá adresa. */
  url: string;
  /** Notifikace se stejným tagem se v systému přepisují, ne hromadí. */
  tag: string;
  kind: NotificationKind;
}

export interface NotifyResult {
  sent: number;
  /** Neposláno kvůli předvolbám nebo tichým hodinám. */
  skipped: number;
  /** Mrtvé odběry smazané cestou. */
  removed: number;
  failed: number;
}

const EMPTY: NotifyResult = { sent: 0, skipped: 0, removed: 0, failed: 0 };

/** Jak dlouho má push služba držet nedoručenou notifikaci. */
const TTL_SECONDS = 3600;

let configured = false;

function ensureVapid(): boolean {
  if (configured) return true;
  if (!pushConfigured()) return false;
  const config = vapidConfig();
  webpush.setVapidDetails(config.subject, config.publicKey, config.privateKey);
  configured = true;
  return true;
}

interface SiteRow {
  id: string;
  name: string;
  timezone: string;
}

/**
 * Komu se událost na lokalitě týká.
 *
 * Kopie logiky site_is_visible() pro service_role: admin vidí všechno,
 * ostatní jen to, na co mají grant. Ta duplicita je vědomá a je tu
 * proto, že service_role RLS obchází — kdyby se tahle funkce ptala
 * „koho by pustila politika“, neptala by se nikoho.
 */
async function recipientProfileIds(siteId: string): Promise<string[]> {
  const db = supabaseAdmin();

  const [admins, grants] = await Promise.all([
    db.from("profiles").select("id").eq("role", "admin").returns<{ id: string }[]>(),
    db
      .from("site_grants")
      .select("profile_id")
      .eq("site_id", siteId)
      .returns<{ profile_id: string }[]>(),
  ]);

  const ids = new Set<string>();
  for (const row of admins.data ?? []) ids.add(row.id);
  for (const row of grants.data ?? []) ids.add(row.profile_id);
  return [...ids];
}

/**
 * Pošle událost všem, koho se týká a kdo o ni stojí.
 *
 * Nikdy nevyhazuje: notifikace je doplněk, ne děj. Selhání odeslání
 * nesmí shodit zásah, synchronizaci ani cron, ve kterých běží.
 */
export async function notify(options: {
  siteId: string;
  kind: NotificationKind;
  title: string;
  body: string;
  url: string;
  /** Klíč pro slučování; výchozí je druh události. */
  tag?: string;
  at?: Date;
}): Promise<NotifyResult> {
  try {
    if (!ensureVapid()) {
      // Chybějící klíče nejsou chyba běhu, ale nenastavení. Zaloguje
      // se a jede se dál — jinak by první nasazení bez VAPID shodilo
      // každý zásah.
      console.warn("VAPID klíče chybí — notifikace se neposílají", {
        kind: options.kind,
      });
      return EMPTY;
    }

    const db = supabaseAdmin();
    const at = options.at ?? new Date();

    const { data: site } = await db
      .from("sites")
      .select("id, name, timezone")
      .eq("id", options.siteId)
      .maybeSingle<SiteRow>();

    if (!site) {
      console.warn("Notifikace bez lokality — neposílám", { site_id: options.siteId });
      return EMPTY;
    }

    const profileIds = await recipientProfileIds(site.id);
    if (profileIds.length === 0) return EMPTY;

    const { data: prefRows } = await db
      .from("notification_prefs")
      .select("*")
      .eq("site_id", site.id)
      .in("profile_id", profileIds)
      .returns<(EffectivePrefs & { profile_id: string })[]>();

    const prefsByProfile = new Map<string, EffectivePrefs>();
    for (const row of prefRows ?? []) prefsByProfile.set(row.profile_id, row);

    const result: NotifyResult = { ...EMPTY };
    const adresati: string[] = [];

    for (const profileId of profileIds) {
      const decision = shouldDeliver({
        kind: options.kind,
        prefs: effectivePrefs(prefsByProfile.get(profileId)),
        timezone: site.timezone,
        at,
      });
      if (decision.send) adresati.push(profileId);
      else result.skipped += 1;
    }

    if (adresati.length === 0) return result;

    const { data: subscriptions } = await db
      .from("push_subscriptions")
      .select("id, endpoint, p256dh, auth")
      .in("profile_id", adresati)
      .returns<Pick<PushSubscription, "id" | "endpoint" | "p256dh" | "auth">[]>();

    if (!subscriptions || subscriptions.length === 0) return result;

    const payload: PushPayload = {
      title: options.title,
      body: options.body,
      url: options.url,
      tag: options.tag ?? options.kind,
      kind: options.kind,
    };

    // Souběžně: zařízení může být deset a každé je jedno kolo po síti.
    const vysledky = await Promise.all(
      subscriptions.map((subscription) => sendOne(subscription, payload)),
    );

    for (const stav of vysledky) {
      if (stav === "sent") result.sent += 1;
      else if (stav === "removed") result.removed += 1;
      else result.failed += 1;
    }

    return result;
  } catch (error) {
    console.error("Odeslání notifikací selhalo", {
      kind: options.kind,
      message: error instanceof Error ? error.message : String(error),
    });
    return EMPTY;
  }
}

type SendOutcome = "sent" | "removed" | "failed";

/**
 * Jedno zařízení.
 *
 * 404 a 410 znamenají, že odběr už neexistuje — uživatel odinstaloval
 * aplikaci, smazal data prohlížeče nebo mu vypršel. Takový řádek se
 * maže hned: jinak se hromadí a každý stojí jedno volání po síti při
 * každé další notifikaci.
 */
async function sendOne(
  subscription: Pick<PushSubscription, "id" | "endpoint" | "p256dh" | "auth">,
  payload: PushPayload,
): Promise<SendOutcome> {
  const db = supabaseAdmin();

  try {
    await webpush.sendNotification(
      {
        endpoint: subscription.endpoint,
        keys: { p256dh: subscription.p256dh, auth: subscription.auth },
      },
      JSON.stringify(payload),
      { TTL: TTL_SECONDS },
    );

    await db
      .from("push_subscriptions")
      .update({ last_used_at: new Date().toISOString() })
      .eq("id", subscription.id);

    return "sent";
  } catch (error) {
    const status = (error as { statusCode?: number }).statusCode;

    if (status === 404 || status === 410) {
      await db.from("push_subscriptions").delete().eq("id", subscription.id);
      return "removed";
    }

    // Endpoint se neloguje celý — je to adresa konkrétního zařízení.
    console.warn("Notifikaci se nepodařilo doručit", {
      subscription_id: subscription.id,
      status: status ?? null,
    });
    return "failed";
  }
}
