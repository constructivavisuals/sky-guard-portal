import { createClient } from "./supabase/server.ts";
import type { CurrentProfile } from "./profile.ts";

// Načtení profilu přihlášeného uživatele. Server-only — sahá na cookies
// i na databázi. Typ a čisté funkce nad profilem jsou v profile.ts.

export async function getCurrentProfile(): Promise<CurrentProfile | null> {
  try {
    const supabase = await createClient();

    // getUser() ověřuje token u Supabase, na rozdíl od getSession(),
    // která věří obsahu cookie.
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return null;

    const { data } = await supabase
      .from("profiles")
      .select("id, email, full_name, role")
      .eq("id", user.id)
      .maybeSingle();

    if (!data) {
      // Uživatel existuje v auth, ale nemá řádek v profiles. V databázi
      // se chová jako nikdo — is_admin() i site_is_visible() vrátí false,
      // takže neuvidí nic. UI to musí odrážet, ne mu přiznat víc.
      return {
        id: user.id,
        email: user.email ?? null,
        fullName: null,
        role: "viewer",
      };
    }

    return {
      id: data.id,
      // Profil e-mail mít nemusí — plní se ručně a u účtů založených
      // pozvánkou zůstává prázdný. Autoritativní je stejně auth.users,
      // odkud přišel při přihlášení.
      email: data.email ?? user.email ?? null,
      fullName: data.full_name,
      role: data.role,
    };
  } catch {
    return null;
  }
}

