import type { NextRequest } from "next/server";

import { updateSession } from "./lib/supabase/middleware.ts";

export async function middleware(request: NextRequest) {
  return updateSession(request);
}

export const config = {
  matcher: [
    /*
     * Vše kromě statických assetů a ingest API.
     *
     * /api/ingest/* má vlastní autentizaci HMAC podpisem, /api/cron/*
     * a /api/sync/* sdílené tajemství CRON_SECRET — nic z toho nemá
     * session cookie a middleware by je odkláněl na /login.
     *
     * Na tohle se snadno zapomene: nová routa pod /api, která se
     * ověřuje jinak než session, musí přibýt i sem, jinak vrací
     * přesměrování místo odpovědi.
     */
    "/((?!_next/static|_next/image|favicon.ico|sw.js|manifest.webmanifest|api/ingest|api/cron|api/sync|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
