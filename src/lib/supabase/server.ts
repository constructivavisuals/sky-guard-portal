import { cache } from "react";
import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";

import type { Database } from "../../types/database.ts";

// Klient pro server komponenty a route handlery. Session čte z cookies,
// takže platí RLS přihlášeného uživatele.
//
// cache(): layout, stránka i pomocné funkce si klienta berou nezávisle
// na sobě. Bez memoizace by každé volání znovu četlo cookies a stavělo
// nový klient — a hlavně by se rozpadla memoizace dotazů nad ním.
export const createClient = cache(async function createClient() {
  const cookieStore = await cookies();

  return createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            for (const { name, value, options } of cookiesToSet) {
              cookieStore.set(name, value, options);
            }
          } catch {
            // Server komponenta cookies zapisovat nesmí. Obnovu session
            // řeší middleware, takže se tenhle případ dá ignorovat.
          }
        },
      },
    },
  );
});
