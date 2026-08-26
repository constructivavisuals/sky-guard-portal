// Čtení konfigurace z prostředí.
//
// Hodnoty se čtou líně, až při prvním použití — kdyby se braly při
// importu modulu, spadl by `next build` na stroji bez .env.local.
//
// Chybová hláška nese jen NÁZEV proměnné, nikdy hodnotu; tajemství se
// nesmí dostat do logu ani do odpovědi API.

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Chybí povinná proměnná prostředí ${name}`);
  }
  return value;
}

export interface SupabaseAdminConfig {
  url: string;
  serviceRoleKey: string;
}

/** Service role obchází RLS — používat výhradně na serveru. */
export function supabaseAdminConfig(): SupabaseAdminConfig {
  return {
    url: required("NEXT_PUBLIC_SUPABASE_URL"),
    serviceRoleKey: required("SUPABASE_SERVICE_ROLE_KEY"),
  };
}

/** Sdílený secret pro HMAC podpis ingest požadavků. */
export function ingestSecret(): string {
  return required("INGEST_SECRET");
}

export interface FlightHubConfig {
  host: string;
  projectUuid: string;
  creator: string;
  userToken: string;
}

export function flightHubConfig(): FlightHubConfig {
  return {
    // Bez koncového lomítka, ať se cesty skládají předvídatelně.
    host: required("FH_HOST").replace(/\/+$/, ""),
    projectUuid: required("FH_PROJECT_UUID"),
    // FH_WORKFLOW_UUID se už nečte: workflow trigger je pryč
    // a povinná proměnná, kterou nikdo nepoužívá, jen brání nasazení.
    creator: required("FH_CREATOR"),
    userToken: required("FH_USER_TOKEN"),
  };
}

export interface VapidConfig {
  publicKey: string;
  privateKey: string;
  /** Kontakt pro push službu podle RFC 8292; mailto: nebo https:. */
  subject: string;
}

/**
 * Klíče pro podpis push notifikací.
 *
 * Veřejný klíč je NEXT_PUBLIC_, protože ho potřebuje prohlížeč při
 * zakládání odběru. Privátní zůstává na serveru — kdyby unikl, může
 * jménem portálu poslat notifikaci komukoli s přihlášeným zařízením.
 *
 * Generuje je `npm run vapid`.
 */
export function vapidConfig(): VapidConfig {
  return {
    publicKey: required("NEXT_PUBLIC_VAPID_PUBLIC_KEY"),
    privateKey: required("VAPID_PRIVATE_KEY"),
    subject: process.env.VAPID_SUBJECT ?? "mailto:info@sky-guard.cz",
  };
}

/** Jsou notifikace vůbec nastavené? Chybějící klíče nejsou chyba běhu. */
export function pushConfigured(): boolean {
  return Boolean(
    process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY,
  );
}
