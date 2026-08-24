import { NextResponse, type NextRequest } from "next/server";

import { createClient } from "@/lib/supabase/server.ts";

// POST z tlačítka v horní liště. Route je v PUBLIC_PATHS middlewaru,
// aby odhlášení prošlo i s už neplatnou session.
export async function POST(request: NextRequest) {
  const supabase = await createClient();
  await supabase.auth.signOut();

  return NextResponse.redirect(new URL("/login", request.url), {
    status: 303,
  });
}
