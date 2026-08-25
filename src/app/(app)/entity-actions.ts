"use server";

import { revalidatePath } from "next/cache";

import { getCurrentProfile } from "@/lib/current-profile.ts";
import { isAdmin } from "@/lib/profile.ts";
import { createClient } from "@/lib/supabase/server.ts";
import {
  databaseErrorToFieldErrors,
  parseCameraForm,
  parsePatrolForm,
  parseSiteForm,
  parseZoneForm,
  type FieldErrors,
} from "@/lib/validation.ts";

// Server akce pro zakládání a úpravu konfigurace. Zapisovat smí jen
// admin.
//
// Kontrola role tady NENÍ bezpečnostní hranice — tou jsou zápisové
// politiky v databázi, které stojí na is_admin(). Kdyby tahle kontrola
// chyběla, neadmin by stejně dostal chybu z RLS; jen by byla
// nesrozumitelná. Skrytí tlačítek v UI je totéž: úklid, ne zámek.

export interface FormState {
  ok: boolean;
  errors: FieldErrors;
  /**
   * Co uživatel odeslal. React 19 po server akci nekontrolovaná pole
   * resetuje, takže bez tohohle by po jediné chybě zmizel celý
   * vyplněný formulář — u lokality dvanáct polí.
   */
  values?: Record<string, string | string[]>;
  /** Pořadí pokusu — formulář se jím klíčuje, viz components/form.tsx. */
  attempt?: number;
}

const DENIED: FormState = {
  ok: false,
  errors: { _form: "Na tuhle změnu nemáte oprávnění." },
};

function snapshot(data: FormData): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [key, value] of data.entries()) {
    if (typeof value !== "string") continue;
    const existing = out[key];
    if (existing === undefined) out[key] = value;
    else if (Array.isArray(existing)) existing.push(value);
    else out[key] = [existing, value];
  }
  return out;
}

async function requireAdmin(): Promise<boolean> {
  return isAdmin(await getCurrentProfile());
}

/** Souřadnice do sloupce geography. PostGIS si EWKT přetypuje sám. */
function toPoint(latitude: number, longitude: number): string {
  // POINT bere pořadí (délka, šířka) — tedy X, Y, ne naopak.
  return `SRID=4326;POINT(${longitude} ${latitude})`;
}

function failed(message: string, code?: string): FormState {
  return { ok: false, errors: databaseErrorToFieldErrors(message, code) };
}

// ── Lokality ─────────────────────────────────────────────────────

export async function saveSite(
  _prev: FormState,
  data: FormData,
): Promise<FormState> {
  const attempt = (_prev.attempt ?? 0) + 1;
  if (!(await requireAdmin()))
    return { ...DENIED, values: snapshot(data), attempt };

  const parsed = parseSiteForm(data);
  if (!parsed.ok)
    return { ok: false, errors: parsed.errors, values: snapshot(data), attempt };

  const id = String(data.get("id") ?? "");
  const supabase = await createClient();

  const { error } = id
    ? await supabase.from("sites").update(parsed.value).eq("id", id)
    : await supabase.from("sites").insert(parsed.value);

  if (error)
    return { ...failed(error.message, error.code), values: snapshot(data), attempt };

  revalidatePath("/", "layout");
  return { ok: true, errors: {}, attempt };
}

// ── Zóny ─────────────────────────────────────────────────────────

export async function saveZone(
  _prev: FormState,
  data: FormData,
): Promise<FormState> {
  const attempt = (_prev.attempt ?? 0) + 1;
  if (!(await requireAdmin()))
    return { ...DENIED, values: snapshot(data), attempt };

  const parsed = parseZoneForm(data);
  if (!parsed.ok)
    return { ok: false, errors: parsed.errors, values: snapshot(data), attempt };

  const { latitude, longitude, ...rest } = parsed.value;
  const row = { ...rest, location: toPoint(latitude, longitude) };

  const id = String(data.get("id") ?? "");
  const supabase = await createClient();

  const { error } = id
    ? await supabase.from("zones").update(row).eq("id", id)
    : await supabase.from("zones").insert(row);

  if (error)
    return { ...failed(error.message, error.code), values: snapshot(data), attempt };

  revalidatePath("/", "layout");
  return { ok: true, errors: {}, attempt };
}

// ── Kamery ───────────────────────────────────────────────────────

export async function saveCamera(
  _prev: FormState,
  data: FormData,
): Promise<FormState> {
  const attempt = (_prev.attempt ?? 0) + 1;
  if (!(await requireAdmin()))
    return { ...DENIED, values: snapshot(data), attempt };

  const parsed = parseCameraForm(data);
  if (!parsed.ok)
    return { ok: false, errors: parsed.errors, values: snapshot(data), attempt };

  const id = String(data.get("id") ?? "");
  const supabase = await createClient();

  const { error } = id
    ? await supabase.from("cameras").update(parsed.value).eq("id", id)
    : await supabase.from("cameras").insert(parsed.value);

  if (error)
    return { ...failed(error.message, error.code), values: snapshot(data), attempt };

  revalidatePath("/", "layout");
  return { ok: true, errors: {}, attempt };
}

// ── Hlídky ───────────────────────────────────────────────────────

export async function savePatrol(
  _prev: FormState,
  data: FormData,
): Promise<FormState> {
  const attempt = (_prev.attempt ?? 0) + 1;
  if (!(await requireAdmin()))
    return { ...DENIED, values: snapshot(data), attempt };

  const parsed = parsePatrolForm(data);
  if (!parsed.ok)
    return { ok: false, errors: parsed.errors, values: snapshot(data), attempt };

  const id = String(data.get("id") ?? "");
  const supabase = await createClient();

  const { error } = id
    ? await supabase.from("patrols").update(parsed.value).eq("id", id)
    : await supabase.from("patrols").insert(parsed.value);

  if (error)
    return { ...failed(error.message, error.code), values: snapshot(data), attempt };

  revalidatePath("/", "layout");
  return { ok: true, errors: {}, attempt };
}
