import type { UserRole } from "../types/database.ts";

// Profil přihlášeného uživatele pro potřeby UI: typ a čisté funkce nad
// ním. Schválně bez importu supabase/server.ts — ten táhne next/headers
// a klientský sidebar by s ním nešel sestavit. Načítání je vedle
// v current-profile.ts, které je jen pro server.
//
// POZOR: nic z toho není bezpečnostní hranice. Skrytí sloupce jen uklidí
// obrazovku od údajů, které danou roli nezajímají. Jedinou zárukou
// zůstává RLS v databázi — kdyby tyhle funkce vrátily nesprávnou roli,
// uživatel se stejně k cizím datům nedostane, protože mu je nevrátí
// PostgREST.

export interface CurrentProfile {
  id: string;
  email: string | null;
  fullName: string | null;
  role: UserRole;
  /** Firma klienta a cesta k jeho logu. Migrace 20260830120000. */
  companyName: string | null;
  logoPath: string | null;
}

/** Administrátor portálu. Protějšek SQL funkce is_admin(). */
export function isAdmin(profile: CurrentProfile | null): boolean {
  return profile?.role === "admin";
}

/** Administrátor nebo operátor. Protějšek SQL funkce is_operator(). */
export function isOperator(profile: CurrentProfile | null): boolean {
  return profile?.role === "admin" || profile?.role === "operator";
}

/** Iniciála do kolečka — ze jména, jinak z e-mailu. */
export function profileInitial(profile: CurrentProfile): string {
  const source = profile.fullName?.trim() || profile.email?.trim() || "?";
  return source.charAt(0).toUpperCase();
}
