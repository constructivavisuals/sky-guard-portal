"use server";

import { revalidatePath } from "next/cache";

import { getCurrentProfile } from "@/lib/current-profile.ts";
import { createClient } from "@/lib/supabase/server.ts";
import {
  NOTIFICATION_KINDS,
  NOTIFICATION_KIND_COLUMNS,
  type Database,
} from "@/types/database.ts";

type NotificationPrefsInsert =
  Database["public"]["Tables"]["notification_prefs"]["Insert"];

// Server akce pro notifikace.
//
// Všechno běží pod session přihlášeného uživatele, ne pod service_role.
// Vlastnictví odběru i předvoleb tedy hlídá RLS (profile_id =
// auth.uid()), ne tenhle kód — kontrola profilu tu je jen proto, aby
// chyba byla srozumitelná, a aby se do řádku dalo co zapsat.

export interface PushActionResult {
  ok: boolean;
  message?: string;
}

const NEPRIHLASEN: PushActionResult = {
  ok: false,
  message: "Nejste přihlášeni.",
};

/** Co posílá prohlížeč po PushManager.subscribe(). */
export interface SubscriptionInput {
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent?: string | null;
}

/**
 * Uloží nebo obnoví odběr zařízení.
 *
 * Klíč je endpoint: tentýž prohlížeč vrací tutéž adresu, takže
 * opakované povolení má řádek přepsat, ne založit druhý — jinak by
 * jedno zařízení dostávalo notifikaci dvakrát. Klíče se přitom
 * přepisují schválně: prohlížeč je při obnovení odběru mění.
 */
export async function ulozitOdber(
  input: SubscriptionInput,
): Promise<PushActionResult> {
  const profile = await getCurrentProfile();
  if (!profile) return NEPRIHLASEN;

  if (
    !input.endpoint.startsWith("https://") ||
    !input.p256dh ||
    !input.auth
  ) {
    return { ok: false, message: "Odběr od prohlížeče je neúplný." };
  }

  const supabase = await createClient();
  const { error } = await supabase.from("push_subscriptions").upsert(
    {
      profile_id: profile.id,
      endpoint: input.endpoint,
      p256dh: input.p256dh,
      auth: input.auth,
      // Ať uživatel v seznamu pozná, které zařízení je které.
      user_agent: input.userAgent?.slice(0, 300) ?? null,
    },
    { onConflict: "endpoint" },
  );

  if (error) {
    console.error("Zápis odběru selhal", { message: error.message });
    return { ok: false, message: "Odběr se nepodařilo uložit." };
  }

  revalidatePath("/nastaveni");
  return { ok: true };
}

/**
 * Odhlásí zařízení.
 *
 * RLS pustí jen vlastní řádek, takže cizí id nic nesmaže — a odpověď
 * je schválně stejná, aby z ní nešlo zjistit, jestli takový odběr
 * existuje.
 */
export async function zrusitOdber(id: string): Promise<PushActionResult> {
  const profile = await getCurrentProfile();
  if (!profile) return NEPRIHLASEN;

  const supabase = await createClient();
  const { error } = await supabase.from("push_subscriptions").delete().eq("id", id);

  if (error) {
    console.error("Smazání odběru selhalo", { message: error.message });
    return { ok: false, message: "Zařízení se nepodařilo odhlásit." };
  }

  revalidatePath("/nastaveni");
  return { ok: true };
}

/** `HH:MM` z formuláře na `HH:MM:00` pro sloupec TIME. */
function cas(raw: FormDataEntryValue | null): string | null {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!/^\d{2}:\d{2}$/.test(value)) return null;
  return `${value}:00`;
}

/**
 * Uloží předvolby pro jednu lokalitu.
 *
 * Formulář se odesílá celý, takže nezaškrtnutý přepínač se v FormData
 * vůbec neobjeví — proto se hodnoty čtou přes `has`, ne přes `get`.
 */
export async function ulozitPredvolby(
  _prev: PushActionResult,
  data: FormData,
): Promise<PushActionResult> {
  const profile = await getCurrentProfile();
  if (!profile) return NEPRIHLASEN;

  const siteId = String(data.get("site_id") ?? "");
  if (!siteId) return { ok: false, message: "Chybí lokalita." };

  const quietFrom = cas(data.get("quiet_from"));
  const quietTo = cas(data.get("quiet_to"));

  // Databáze má na obojí CHECK; tady se to chytá dřív, aby uživatel
  // dostal větu místo hlášky z Postgresu.
  if ((quietFrom === null) !== (quietTo === null)) {
    return { ok: false, message: "Vyplňte začátek i konec tichých hodin, nebo ani jedno." };
  }
  if (quietFrom !== null && quietFrom === quietTo) {
    return { ok: false, message: "Začátek a konec tichých hodin se nesmí shodovat." };
  }

  const prepinace: Record<string, boolean> = {};
  for (const kind of NOTIFICATION_KINDS) {
    prepinace[NOTIFICATION_KIND_COLUMNS[kind]] = data.has(
      NOTIFICATION_KIND_COLUMNS[kind],
    );
  }

  const row = {
    profile_id: profile.id,
    site_id: siteId,
    quiet_from: quietFrom,
    quiet_to: quietTo,
    ...prepinace,
  } as NotificationPrefsInsert;

  const supabase = await createClient();
  const ulozit = (radek: NotificationPrefsInsert) =>
    supabase.from("notification_prefs").upsert(radek, { onConflict: "profile_id,site_id" });

  let { error } = await ulozit(row);

  // Sloupec on_processing_stuck přidává migrace 20260912120000, kterou
  // pouští člověk ručně. Dokud neproběhne, PostgREST odmítne celý
  // zápis kvůli neznámému sloupci — a uživatel by si nemohl uložit ani
  // tiché hodiny. Druhý pokus je bez něj.
  if (error) {
    const { on_processing_stuck, ...bezNoveho } = row as NotificationPrefsInsert & {
      on_processing_stuck?: boolean;
    };
    void on_processing_stuck;
    const druhy = await ulozit(bezNoveho as NotificationPrefsInsert);
    if (!druhy.error) {
      console.warn("Předvolba on_processing_stuck se neuložila — chybí migrace 20260912120000");
      error = null;
    }
  }

  if (error) {
    console.error("Zápis předvoleb notifikací selhal", { message: error.message });
    return { ok: false, message: "Předvolby se nepodařilo uložit." };
  }

  revalidatePath("/nastaveni");
  return { ok: true };
}
