"use server";

import { revalidatePath } from "next/cache";

import { getCurrentProfile } from "@/lib/current-profile.ts";
import {
  LOGO_BUCKET,
  isSupportedLogoType,
  logoPathFor,
} from "@/lib/logo.ts";
import { isAdmin } from "@/lib/profile.ts";
import { createClient } from "@/lib/supabase/server.ts";
import { supabaseAdmin } from "@/lib/supabase-admin.ts";
import {
  parseClientForm,
  parsePassword,
  type FieldErrors,
} from "@/lib/validation.ts";

// Správa klientů.
//
// ═══ POZOR ═══════════════════════════════════════════════════════
// Tohle je jediné místo v portálu, kde kontrola role V TYPESCRIPTU
// JE bezpečnostní hranicí. Všude jinde je zámkem RLS a kontrola
// v kódu jen uklízí chybové hlášky. Zakládání uživatelů a změna hesla
// jde ale přes Admin API se service_role klíčem, které RLS obchází
// z podstaty — žádná politika ho nezastaví. Kdyby `requireAdmin()`
// níž vypadl, mohl by si kdokoli přihlášený založit administrátorský
// účet.
//
// Proto: každá akce, která sáhne na supabaseAdmin(), musí requireAdmin()
// zavolat jako první příkaz. Ostatní zápisy (profil, granty, logo)
// jdou schválně přes klienta přihlášeného uživatele, aby na ně dál
// platily politiky.
// ═════════════════════════════════════════════════════════════════

export interface ClientFormState {
  ok: boolean;
  errors: FieldErrors;
  values?: Record<string, string | string[]>;
  attempt?: number;
  /** Co se povedlo — vypíše se nad seznamem. */
  message?: string;
}

const DENIED: ClientFormState = {
  ok: false,
  errors: { _form: "Na správu klientů nemáte oprávnění." },
};

function snapshot(data: FormData): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [key, value] of data.entries()) {
    if (typeof value !== "string") continue;
    // Heslo se do formuláře nikdy nevrací — zůstalo by v HTML stránky.
    if (key === "password" || key === "new_password") continue;
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

/** Hláška z Admin API bez podrobností, které uživateli nepomůžou. */
function authError(message: string): FieldErrors {
  const text = message.toLowerCase();
  if (text.includes("already been registered") || text.includes("already exists")) {
    return { email: "Uživatel s tímhle e-mailem už existuje." };
  }
  if (text.includes("password")) {
    return { password: "Heslo Supabase odmítlo. Zkuste delší a složitější." };
  }
  return { _form: "Účet se nepodařilo založit. Zkuste to prosím znovu." };
}

/**
 * Přepíše granty na lokality tak, aby odpovídaly zaškrtnutým.
 *
 * Přes klienta přihlášeného uživatele, ne přes service_role — zápis
 * do site_grants hlídá politika write_site_grants a ta má zůstat
 * v platnosti i tady.
 */
async function nastavitGranty(profileId: string, siteIds: string[]) {
  const supabase = await createClient();

  const { data: existing } = await supabase
    .from("site_grants")
    .select("site_id")
    .eq("profile_id", profileId)
    .returns<{ site_id: string }[]>();

  const mel = new Set((existing ?? []).map((row) => row.site_id));
  const chce = new Set(siteIds);

  const pridat = [...chce].filter((id) => !mel.has(id));
  const odebrat = [...mel].filter((id) => !chce.has(id));

  if (pridat.length > 0) {
    const { error } = await supabase
      .from("site_grants")
      .insert(pridat.map((site_id) => ({ profile_id: profileId, site_id })));
    if (error) return error.message;
  }

  if (odebrat.length > 0) {
    const { error } = await supabase
      .from("site_grants")
      .delete()
      .eq("profile_id", profileId)
      .in("site_id", odebrat);
    if (error) return error.message;
  }

  return null;
}

/**
 * Nahraje logo a vrátí jeho cestu.
 *
 * `null` znamená, že soubor nebyl přiložen — to není chyba, klient
 * logo mít nemusí. Řetězec začínající `!` je chybová hláška.
 */
async function nahratLogo(
  profileId: string,
  soubor: File | null,
): Promise<string | null | { error: string }> {
  if (!soubor || soubor.size === 0) return null;

  if (!isSupportedLogoType(soubor.type)) {
    return { error: "Logo musí být PNG, JPEG, WebP nebo SVG." };
  }
  if (soubor.size > 2 * 1024 * 1024) {
    return { error: "Logo je větší než 2 MB." };
  }

  // Razítko v názvu: nová verze loga musí dostat novou adresu, jinak
  // ji prohlížeč i CDN podrží z cache a klient uvidí to staré.
  const cesta = logoPathFor(profileId, soubor.type, Date.now());
  if (!cesta) return { error: "Tenhle typ souboru neumíme uložit." };

  const supabase = await createClient();
  const { error } = await supabase.storage
    .from(LOGO_BUCKET)
    .upload(cesta, soubor, { contentType: soubor.type, upsert: true });

  if (error) {
    return { error: "Logo se nepodařilo nahrát. Zkuste to prosím znovu." };
  }
  return cesta;
}

// ── Založení klienta ─────────────────────────────────────────────

export async function vytvoritKlienta(
  _prev: ClientFormState,
  data: FormData,
): Promise<ClientFormState> {
  const attempt = (_prev.attempt ?? 0) + 1;
  if (!(await requireAdmin())) return { ...DENIED, values: snapshot(data), attempt };

  const parsed = parseClientForm(data);
  const heslo = parsePassword(String(data.get("password") ?? ""));

  if (!parsed.ok || !heslo.ok) {
    return {
      ok: false,
      errors: { ...(parsed.ok ? {} : parsed.errors), ...(heslo.ok ? {} : heslo.errors) },
      values: snapshot(data),
      attempt,
    };
  }

  // Účet v auth.users umí založit jen Admin API; RLS na to nemá vliv.
  const admin = supabaseAdmin();
  const { data: created, error: authErr } = await admin.auth.admin.createUser({
    email: parsed.value.email,
    password: heslo.value,
    // Klienta zakládá administrátor, ne uživatel sám — potvrzovací
    // e-mail by mu jen přišel bez vysvětlení.
    email_confirm: true,
  });

  if (authErr || !created.user) {
    return {
      ok: false,
      errors: authError(authErr?.message ?? ""),
      values: snapshot(data),
      attempt,
    };
  }

  const profileId = created.user.id;

  const logo = await nahratLogo(profileId, data.get("logo") as File | null);
  if (logo && typeof logo === "object") {
    // Účet už existuje; logo se doplní úpravou, ať se nezakládá znovu.
    return {
      ok: false,
      errors: { logo: `Účet vznikl, ale ${logo.error.toLowerCase()}` },
      values: snapshot(data),
      attempt,
    };
  }

  const supabase = await createClient();
  const { error: profileErr } = await supabase.from("profiles").insert({
    id: profileId,
    email: parsed.value.email,
    full_name: parsed.value.full_name,
    company_name: parsed.value.company_name,
    role: parsed.value.role,
    logo_path: logo,
  });

  if (profileErr) {
    return {
      ok: false,
      errors: {
        _form:
          "Účet vznikl, ale profil se nepodařilo uložit. Doplňte ho úpravou klienta.",
      },
      values: snapshot(data),
      attempt,
    };
  }

  const grantErr = await nastavitGranty(profileId, parsed.value.site_ids);
  if (grantErr) {
    return {
      ok: false,
      errors: { site_ids: "Přístup k lokalitám se nepodařilo uložit." },
      values: snapshot(data),
      attempt,
    };
  }

  revalidatePath("/", "layout");
  return { ok: true, errors: {}, attempt, message: "Klient byl založen." };
}

// ── Úprava klienta ───────────────────────────────────────────────

export async function upravitKlienta(
  _prev: ClientFormState,
  data: FormData,
): Promise<ClientFormState> {
  const attempt = (_prev.attempt ?? 0) + 1;
  if (!(await requireAdmin())) return { ...DENIED, values: snapshot(data), attempt };

  const id = String(data.get("id") ?? "");
  if (!id) return { ...DENIED, values: snapshot(data), attempt };

  const parsed = parseClientForm(data);
  if (!parsed.ok) {
    return { ok: false, errors: parsed.errors, values: snapshot(data), attempt };
  }

  const logo = await nahratLogo(id, data.get("logo") as File | null);
  if (logo && typeof logo === "object") {
    return { ok: false, errors: { logo: logo.error }, values: snapshot(data), attempt };
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from("profiles")
    .update({
      email: parsed.value.email,
      full_name: parsed.value.full_name,
      company_name: parsed.value.company_name,
      role: parsed.value.role,
      // Bez nového souboru zůstává staré logo; undefined se do
      // dotazu nedostane, kdežto null by ho smazalo.
      ...(logo ? { logo_path: logo } : {}),
    })
    .eq("id", id);

  if (error) {
    return {
      ok: false,
      errors: { _form: "Uložení se nezdařilo. Zkuste to prosím znovu." },
      values: snapshot(data),
      attempt,
    };
  }

  // E-mail se mění i v auth.users, jinak by se klient přihlašoval
  // starým a v portálu viděl nový.
  const admin = supabaseAdmin();
  const { error: authErr } = await admin.auth.admin.updateUserById(id, {
    email: parsed.value.email,
    email_confirm: true,
  });
  if (authErr) {
    return {
      ok: false,
      errors: authError(authErr.message),
      values: snapshot(data),
      attempt,
    };
  }

  const grantErr = await nastavitGranty(id, parsed.value.site_ids);
  if (grantErr) {
    return {
      ok: false,
      errors: { site_ids: "Přístup k lokalitám se nepodařilo uložit." },
      values: snapshot(data),
      attempt,
    };
  }

  revalidatePath("/", "layout");
  return { ok: true, errors: {}, attempt, message: "Klient byl upraven." };
}

// ── Heslo ────────────────────────────────────────────────────────

export async function zmenitHeslo(
  _prev: ClientFormState,
  data: FormData,
): Promise<ClientFormState> {
  const attempt = (_prev.attempt ?? 0) + 1;
  if (!(await requireAdmin())) return { ...DENIED, attempt };

  const id = String(data.get("id") ?? "");
  if (!id) return { ...DENIED, attempt };

  const heslo = parsePassword(String(data.get("new_password") ?? ""), "new_password");
  if (!heslo.ok) return { ok: false, errors: heslo.errors, attempt };

  const admin = supabaseAdmin();
  const { error } = await admin.auth.admin.updateUserById(id, {
    password: heslo.value,
  });

  if (error) {
    return { ok: false, errors: authError(error.message), attempt };
  }

  // Heslo se nikam nevrací ani neloguje.
  revalidatePath("/", "layout");
  return { ok: true, errors: {}, attempt, message: "Heslo bylo změněno." };
}

// ── Zablokování přístupu ─────────────────────────────────────────

/**
 * Mazání schéma neumožňuje a ani by nebylo správně — s uživatelem by
 * zmizela stopa v audit_log. Přístup se místo toho zamkne v auth,
 * takže se klient nepřihlásí, ale historie zůstane.
 */
export async function prepnoutPristup(
  _prev: ClientFormState,
  data: FormData,
): Promise<ClientFormState> {
  const attempt = (_prev.attempt ?? 0) + 1;
  const profile = await getCurrentProfile();
  if (!isAdmin(profile)) return { ...DENIED, attempt };

  const id = String(data.get("id") ?? "");
  const zablokovat = data.get("blokovat") === "1";
  if (!id) return { ...DENIED, attempt };

  // Zamknout sám sebe by znamenalo vyhodit se z portálu bez cesty zpět.
  if (profile && id === profile.id) {
    return {
      ok: false,
      errors: { _form: "Vlastní přístup si zablokovat nemůžete." },
      attempt,
    };
  }

  const admin = supabaseAdmin();
  const { error } = await admin.auth.admin.updateUserById(id, {
    // "none" zámek zruší; jinak sto let, což je v praxi natrvalo.
    ban_duration: zablokovat ? "876000h" : "none",
  });

  if (error) {
    return {
      ok: false,
      errors: { _form: "Změna se nezdařila. Zkuste to prosím znovu." },
      attempt,
    };
  }

  revalidatePath("/", "layout");
  return {
    ok: true,
    errors: {},
    attempt,
    message: zablokovat ? "Přístup byl zablokován." : "Přístup byl obnoven.",
  };
}
