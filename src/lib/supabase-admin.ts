import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { supabaseAdminConfig } from "./env.ts";
import type { Database } from "../types/database.ts";

let cached: SupabaseClient<Database> | null = null;

/**
 * Klient se service role klíčem — obchází RLS, takže patří výhradně do
 * serverového kódu (route handlery, cron). Nikdy se nesmí dostat do
 * bundle pro prohlížeč.
 *
 * Instance se drží mezi požadavky, aby se v serverless prostředí
 * neplýtvalo na navazování spojení.
 */
export function supabaseAdmin(): SupabaseClient<Database> {
  if (cached) return cached;

  const { url, serviceRoleKey } = supabaseAdminConfig();
  cached = createClient<Database>(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return cached;
}
