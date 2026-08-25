import { cache } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";

import { createClient } from "./supabase/server.ts";
import type { CurrentProfile } from "./profile.ts";

/** Sloupce, které v profiles byly odjakživa. */
const ZAKLADNI = "id, email, full_name, role";

/** Přibyly migrací 20260830120000 (firma a logo klienta). */
const KLIENTSKE = `${ZAKLADNI}, company_name, logo_path`;

interface ProfilRow {
  id: string;
  email: string | null;
  full_name: string | null;
  role: CurrentProfile["role"];
  company_name?: string | null;
  logo_path?: string | null;
}

async function nacistProfil(
  supabase: SupabaseClient,
  userId: string,
  sKlientskymi: boolean,
) {
  return supabase
    .from("profiles")
    .select(sKlientskymi ? KLIENTSKE : ZAKLADNI)
    .eq("id", userId)
    .maybeSingle<ProfilRow>();
}

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

    // Nejdřív se sloupci z migrace 20260830120000, a když ta ještě
    // nedoběhla, znovu bez nich.
    //
    // Bez téhle záchytné větve stačí, aby se kód nasadil dřív než
    // migrace: PostgREST odmítne neznámý sloupec, dotaz nevrátí nic
    // a kód spadne do větve „uživatel bez profilu“, která má natvrdo
    // roli viewer. Administrátor by se tak sám sobě proměnil v klienta
    // — a nepoznal by proč, protože chyba dotazu se nikde neukáže.
    let row = await nacistProfil(supabase, userId, true);
    let chybiSloupce = false;
    if (row.error) {
      row = await nacistProfil(supabase, userId, false);
      chybiSloupce = true;
    }

    // Rozdíl mezi „řádek neexistuje“ a „dotaz selhal“ je podstatný.
    // Selhaný dotaz nesmí nikoho tiše degradovat na klienta; role se
    // v takovém případě nezná, a než ji hádat, je lepší nevracet profil
    // vůbec — volající si to přeloží na „nic nesmíš“, ne na „jsi klient“.
    if (row.error) return null;

    const data = row.data;

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
      companyName: chybiSloupce ? null : (data.company_name ?? null),
      logoPath: chybiSloupce ? null : (data.logo_path ?? null),
    };
  } catch {
    return null;
  }
});

