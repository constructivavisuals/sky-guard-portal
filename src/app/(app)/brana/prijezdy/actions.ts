"use server";

import { revalidatePath } from "next/cache";

import { localDateISO, MAX_DAYS_AHEAD } from "@/lib/arrivals/rules.ts";
import { getCurrentProfile } from "@/lib/current-profile.ts";
import { normalizePlate } from "@/lib/plates.ts";
import { isAdmin } from "@/lib/profile.ts";
import { createClient } from "@/lib/supabase/server.ts";

// Zakládání a rušení ohlášení z portálu.
//
// Běží pod session administrátora, ne pod service_role: zápisovou
// politiku na announced_arrivals přidává migrace 20260907120000
// a hranicí je ona, ne tenhle kód. Kontrola role tu je proto, aby
// neadmin dostal větu místo hlášky z Postgresu.

export interface ArrivalAdminState {
  ok: boolean;
  error?: string;
  values?: Record<string, string>;
}

const DENIED: ArrivalAdminState = {
  ok: false,
  error: "Ohlášení smí zakládat jen administrátor.",
};

function snapshot(data: FormData): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of data.entries()) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

export async function zalozitOhlaseni(
  _prev: ArrivalAdminState,
  data: FormData,
): Promise<ArrivalAdminState> {
  if (!isAdmin(await getCurrentProfile())) return { ...DENIED, values: snapshot(data) };

  const values = snapshot(data);
  const carrierId = String(data.get("carrier_id") ?? "");
  const plateRaw = String(data.get("plate") ?? "").trim();
  const dateRaw = String(data.get("arrival_date") ?? "").trim();
  const note = String(data.get("note") ?? "").trim();
  const nightOk = data.has("night_ok");

  if (!carrierId) return { ok: false, error: "Vyberte dopravce.", values };
  if (!normalizePlate(plateRaw)) {
    return { ok: false, error: "Zadejte registrační značku.", values };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateRaw)) {
    return { ok: false, error: "Zadejte datum příjezdu.", values };
  }

  const supabase = await createClient();

  // Lokalita se bere z dopravce, ne z formuláře — stejně jako na
  // stránce řidiče. Jinak by šlo ohlásit příjezd na cizí areál.
  const { data: carrier, error: carrierError } = await supabase
    .from("carriers")
    .select("id, site_id, sites(timezone)")
    .eq("id", carrierId)
    .maybeSingle<{ id: string; site_id: string; sites: { timezone: string } | null }>();

  if (carrierError || !carrier) {
    return { ok: false, error: "Dopravce se nepodařilo najít.", values };
  }

  const timezone = carrier.sites?.timezone ?? "Europe/Prague";
  const dnes = localDateISO(timezone);
  if (dateRaw < dnes) {
    return { ok: false, error: "Zpětně se ohlásit nedá.", values };
  }

  const nejzazsi = localDateISO(
    timezone,
    new Date(new Date().getTime() + MAX_DAYS_AHEAD * 86_400_000),
  );
  if (dateRaw > nejzazsi) {
    return { ok: false, error: `Nejvýš ${MAX_DAYS_AHEAD} dní dopředu.`, values };
  }

  const { error } = await supabase.from("announced_arrivals").insert({
    carrier_id: carrier.id,
    site_id: carrier.site_id,
    plate: plateRaw,
    arrival_date: dateRaw,
    note: note || null,
    night_ok: nightOk,
  });

  if (error) {
    if (error.code === "23505") {
      return { ok: false, error: "Tenhle příjezd už je ohlášený.", values };
    }
    console.error("Zápis ohlášení z portálu selhal", { message: error.message });
    return { ok: false, error: "Ohlášení se nepodařilo uložit.", values };
  }

  revalidatePath("/brana/prijezdy");
  return { ok: true };
}

export async function zrusitOhlaseniAdmin(
  _prev: ArrivalAdminState,
  data: FormData,
): Promise<ArrivalAdminState> {
  if (!isAdmin(await getCurrentProfile())) return DENIED;

  const id = String(data.get("id") ?? "");
  const supabase = await createClient();

  // Razítko, ne DELETE: ohlášení, na které se ingest při rozhodování
  // odvolal, musí zůstat dohledatelné.
  const { error } = await supabase
    .from("announced_arrivals")
    .update({ cancelled_at: new Date().toISOString() })
    .eq("id", id)
    .is("cancelled_at", null);

  if (error) {
    console.error("Zrušení ohlášení z portálu selhalo", { message: error.message });
    return { ok: false, error: "Ohlášení se nepodařilo zrušit." };
  }

  revalidatePath("/brana/prijezdy");
  return { ok: true };
}
