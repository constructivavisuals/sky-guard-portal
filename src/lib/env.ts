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
