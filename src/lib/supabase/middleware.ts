import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

import type { Database } from "../../types/database.ts";

/** Cesty dostupné bez přihlášení. */
// /offline musí jít načíst i bez session — service worker si ji ukládá
// při instalaci, tedy ještě než se kdokoli přihlásí.
// /prijezd je stránka pro řidiče dopravce: nemá session ani účet,
// ověřuje se tokenem v adrese. Middleware ji musí pustit, jinak by
// řidiče poslala na přihlášení, které nikdy nedostane.
const PUBLIC_PATHS = ["/login", "/auth", "/offline", "/prijezd"];

function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.some(
    (path) => pathname === path || pathname.startsWith(`${path}/`),
  );
}

/**
 * Obnoví session z cookies a nepřihlášené odkloní na /login.
 *
 * Odpověď se musí vracet i s cookies, které Supabase cestou nastaví —
 * jinak by se obnovený token zahodil a uživatel by po hodině vypadl.
 */
export async function updateSession(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          for (const { name, value } of cookiesToSet) {
            request.cookies.set(name, value);
          }
          response = NextResponse.next({ request });
          for (const { name, value, options } of cookiesToSet) {
            response.cookies.set(name, value, options);
          }
        },
      },
    },
  );

  // getClaims(), ne getSession(): getSession věří obsahu cookie, který
  // jde podvrhnout. getClaims podpis ověřuje — u projektů s asymetrickým
  // klíčem lokálně přes WebCrypto, jinak dotazem na Auth server, tedy
  // stejně jako getUser(). V prvním případě ubude jedno kolo přes síť
  // z každého požadavku, ve druhém je to shodné s tím, co bylo.
  const { data: claimsData } = await supabase.auth.getClaims();
  const user = claimsData?.claims ?? null;

  const { pathname } = request.nextUrl;

  if (!user && !isPublicPath(pathname)) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    // Kam se vrátit po přihlášení.
    url.searchParams.set("dalsi", pathname);
    return NextResponse.redirect(url);
  }

  // Přihlášenému na /login nemá smysl ukazovat formulář.
  if (user && pathname === "/login") {
    const url = request.nextUrl.clone();
    url.pathname = "/prehled";
    url.search = "";
    return NextResponse.redirect(url);
  }

  return response;
}
