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
     * /api/ingest/* má vlastní autentizaci HMAC podpisem a /api/cron/*
     * sdílené tajemství od Vercelu — ani jedno nemá session cookie
     * a middleware by je odkláněl na /login.
     */
    "/((?!_next/static|_next/image|favicon.ico|sw.js|manifest.webmanifest|api/ingest|api/cron|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
