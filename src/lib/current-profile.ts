import { cache } from "react";

import { createClient } from "./supabase/server.ts";
import type { CurrentProfile } from "./profile.ts";

// Načtení profilu přihlášeného uživatele. Server-only — sahá na cookies
// i na databázi. Typ a čisté funkce nad profilem jsou v profile.ts.

// cache(): profil chce layout (sidebar) i skoro každá stránka
// (isAdmin). Bez memoizace by to bylo dvakrát ověření tokenu u Supabase
// a dvakrát dotaz na profiles, sériově za sebou.
export const getCurrentProfile = cache(async function getCurrentProfile(): Promise<CurrentProfile | null> {
  try {
    const supabase = await createClient();

    // getClaims() podpis ověřuje, na rozdíl od getSession(), která věří
    // obsahu cookie. U projektu s asymetrickým klíčem to zvládne lokálně,
    // takže odpadne jedno kolo přes síť před dotazem na profil.
    const { data: claimsData } = await supabase.auth.getClaims();
    const claims = claimsData?.claims;
    const userId = typeof claims?.sub === "string" ? claims.sub : null;
    if (!userId) return null;

    const claimEmail = typeof claims?.email === "string" ? claims.email : null;

    const { data } = await supabase
      .from("profiles")
      .select("id, email, full_name, role, company_name, logo_path")
      .eq("id", userId)
      .maybeSingle();

    if (!data) {
      // Uživatel existuje v auth, ale nemá řádek v profiles. V databázi
      // se chová jako nikdo — is_admin() i site_is_visible() vrátí false,
      // takže neuvidí nic. UI to musí odrážet, ne mu přiznat víc.
      return {
        id: userId,
        email: claimEmail,
        fullName: null,
        role: "viewer",
        companyName: null,
        logoPath: null,
      };
    }

    return {
      id: data.id,
      // Profil e-mail mít nemusí — plní se ručně a u účtů založených
      // pozvánkou zůstává prázdný. Autoritativní je stejně auth.users,
      // odkud přišel při přihlášení.
      email: data.email ?? claimEmail,
      fullName: data.full_name,
      role: data.role,
      companyName: data.company_name,
      logoPath: data.logo_path,
    };
  } catch {
    return null;
  }
});

