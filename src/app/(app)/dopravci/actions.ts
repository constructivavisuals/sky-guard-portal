"use server";

import { revalidatePath } from "next/cache";

import { generateCarrierToken } from "@/lib/arrivals/carrier.ts";
import { getCurrentProfile } from "@/lib/current-profile.ts";
import { isAdmin } from "@/lib/profile.ts";
import { createClient } from "@/lib/supabase/server.ts";

// Správa dopravců. Zakládat a vypínat smí jen admin.
//
// Kontrola role tady NENÍ bezpečnostní hranice — tou jsou zápisové
// politiky na carriers, které stojí na is_admin(). Kdyby tahle kontrola
// chyběla, neadmin by dostal chybu z RLS; jen by byla nesrozumitelná.

export interface CarrierActionState {
  ok: boolean;
  error?: string;
  values?: Record<string, string>;
}

const DENIED: CarrierActionState = {
  ok: false,
  error: "Na tuhle změnu nemáte oprávnění.",
};

function snapshot(data: FormData): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of data.entries()) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

export async function zalozitDopravce(
  _prev: CarrierActionState,
  data: FormData,
): Promise<CarrierActionState> {
  const profile = await getCurrentProfile();
  if (!isAdmin(profile)) return { ...DENIED, values: snapshot(data) };

  const values = snapshot(data);
  const siteId = String(data.get("site_id") ?? "");
  const name = String(data.get("name") ?? "").trim();
  const contact = String(data.get("contact") ?? "").trim();
  const validUntil = String(data.get("valid_until") ?? "").trim();

  if (!siteId) return { ok: false, error: "Vyberte lokalitu.", values };
  if (!name) return { ok: false, error: "Zadejte název firmy.", values };
  if (name.length > 200) return { ok: false, error: "Název je delší než 200 znaků.", values };
  if (validUntil && !/^\d{4}-\d{2}-\d{2}$/.test(validUntil)) {
    return { ok: false, error: "Platnost zadejte jako datum.", values };
  }

  const supabase = await createClient();
  const { error } = await supabase.from("carriers").insert({
    site_id: siteId,
    name,
    contact: contact || null,
    // Token vzniká na serveru a nikdy ho nezadává člověk — náhodnost
    // je tu jediná ochrana odkazu.
    token: generateCarrierToken(),
    valid_until: validUntil || null,
    created_by: profile?.id ?? null,
  });

  if (error) {
    console.error("Zápis dopravce selhal", { message: error.message });
    return { ok: false, error: "Dopravce se nepodařilo založit.", values };
  }

  revalidatePath("/dopravci");
  return { ok: true };
}

/**
 * Vypnutí a zapnutí odkazu.
 *
 * Ne mazání: ohlášení, která dopravce vytvořil, jsou součástí historie
 * vjezdů. Vypnutý dopravce je navíc stav, který jde vzít zpět —
 * smazaný ne.
 */
export async function prepnoutDopravce(
  _prev: CarrierActionState,
  data: FormData,
): Promise<CarrierActionState> {
  if (!isAdmin(await getCurrentProfile())) return DENIED;

  const id = String(data.get("id") ?? "");
  const active = data.get("active") === "1";

  const supabase = await createClient();
  const { error } = await supabase.from("carriers").update({ active }).eq("id", id);

  if (error) {
    console.error("Změna dopravce selhala", { message: error.message });
    return { ok: false, error: "Změnu se nepodařilo uložit." };
  }

  revalidatePath("/dopravci");
  return { ok: true };
}
