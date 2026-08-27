import type { NextRequest } from "next/server";

import { updateSession } from "./lib/supabase/middleware.ts";

export async function middleware(request: NextRequest) {
  return updateSession(request);
}

export const config = {
  matcher: [
    /*
     * Vše kromě statických assetů a rozhraní, která se ověřují sama.
     *
     *   /api/ingest/*  HMAC podpisem kamery nebo relaye
     *   /api/relay/*   HMAC podpisem relaye (RELAY_SECRET)
     *   /api/cron/*    sdíleným tajemstvím CRON_SECRET
     *   /api/sync/*    týmž tajemstvím
     *
     * Nic z toho session cookie nemá a nikdy mít nebude, takže by je
     * middleware odkláněl na /login.
     *
     * Na tohle se zapomnělo TŘIKRÁT a pokaždé se to poznalo až zvenčí,
     * z relaye nebo z crontabu, kde přesměrování vypadá jako výpadek
     * sítě. Hlídá to teď middleware.test.ts: prochází skutečné routy
     * na disku a pouští na ně tenhle vzor. Nová routa, která sahá na
     * databázi přes supabaseAdmin(), musí přibýt sem — jinak test
     * spadne dřív, než se stihne nasadit.
     */
    "/((?!_next/static|_next/image|favicon.ico|sw.js|manifest.webmanifest|api/ingest|api/relay|api/cron|api/sync|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
