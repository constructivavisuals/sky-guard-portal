import { randomBytes } from "node:crypto";

import { supabaseAdmin } from "../supabase-admin.ts";
import type { Carrier } from "../../types/database.ts";

import { localDateISO } from "./rules.ts";

// Dohledání dopravce podle tokenu z odkazu.
//
// Běží pod service_role, protože stránka řidiče žádnou session nemá —
// token JE ověření. RLS by tu nepomohla ani nevadila; celá kontrola je
// v téhle funkci a musí být proto na jednom místě.

/** Kolik náhodných bajtů má token. 32 = 256 bitů, tedy neuhodnutelný. */
export const TOKEN_BYTES = 32;

/**
 * Nový token do odkazu.
 *
 * base64url, ne hex: vejde se do kratší adresy a nepotřebuje
 * kódování v URL. 32 bajtů dá 43 znaků.
 */
export function generateCarrierToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

export type CarrierLookup =
  | { ok: true; carrier: Carrier; site: { id: string; name: string; timezone: string } }
  | { ok: false; reason: "not_found" | "inactive" | "expired" };

/**
 * Najde dopravce a ověří, že odkaz ještě platí.
 *
 * Neplatný, vypnutý i prošlý token vede na tutéž prostou stránku:
 * odkaz, který se ocitne v cizích rukou, se z odpovědi nemá jak
 * dozvědět, jestli aspoň existoval. Rozdíl zůstává v návratové
 * hodnotě kvůli logu, ne kvůli uživateli.
 */
export async function findCarrierByToken(token: string): Promise<CarrierLookup> {
  // Tvar se kontroluje dřív, než se sáhne do databáze: token je vždycky
  // base64url a cokoli jiného je pokus, ne překlep.
  if (!/^[A-Za-z0-9_-]{20,200}$/.test(token)) {
    return { ok: false, reason: "not_found" };
  }

  const { data, error } = await supabaseAdmin()
    .from("carriers")
    .select("*, sites(id, name, timezone)")
    .eq("token", token)
    .maybeSingle<Carrier & { sites: { id: string; name: string; timezone: string } | null }>();

  if (error) {
    console.error("Dohledání dopravce selhalo", { message: error.message });
    return { ok: false, reason: "not_found" };
  }

  if (!data || !data.sites) return { ok: false, reason: "not_found" };
  if (!data.active) return { ok: false, reason: "inactive" };

  // Platnost je kalendářní den v pásmu lokality a je INKLUZIVNÍ:
  // „platí do 31. 8.“ znamená, že 31. srpna se ještě ohlásit dá.
  if (data.valid_until) {
    const dnes = localDateISO(data.sites.timezone);
    if (dnes > data.valid_until) return { ok: false, reason: "expired" };
  }

  return { ok: true, carrier: data, site: data.sites };
}
