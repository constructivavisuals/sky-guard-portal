import { NextResponse, type NextRequest } from "next/server";

import { checkSameOrigin } from "@/lib/same-origin.ts";
import { createClient } from "@/lib/supabase/server.ts";

// POST z tlačítka v horní liště. Route je v PUBLIC_PATHS middlewaru,
// aby odhlášení prošlo i s už neplatnou session.
//
// Původ se ověřuje: bez toho umí libovolná cizí stránka poslat POST
// s cookies uživatele a vyhodit operátora z portálu. Škoda je malá
// (přihlásí se znovu), ale u dohledového systému je „někdo mě právě
// odhlásil“ přesně ta chvíle, kdy se nikdo nedívá.
export async function POST(request: NextRequest) {
  const puvod = checkSameOrigin(request.headers);

  if (!puvod.ok) {
    console.warn("Odhlášení odmítnuto: požadavek z cizího původu", {
      duvod: puvod.reason,
    });
    // Prostý 403 bez upřesnění. Cizí stránce se nemá co vysvětlovat.
    return new NextResponse("Forbidden", { status: 403 });
  }

  const supabase = await createClient();
  await supabase.auth.signOut();

  return NextResponse.redirect(new URL("/login", request.url), {
    status: 303,
  });
}
