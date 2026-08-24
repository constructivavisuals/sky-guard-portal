"use client";

import { createBrowserClient } from "@supabase/ssr";

import type { Database } from "../../types/database.ts";

// Klient pro prohlížeč — jezdí na anon klíči a podléhá RLS.
// Service role klient je v src/lib/supabase-admin.ts a na klienta nesmí.
export function createClient() {
  return createBrowserClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
}
