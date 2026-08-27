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

/**
 * Tajemství, kterými se smí ingest ověřit — nové i to předchozí.
 *
 * ═══ Proč dvě ═════════════════════════════════════════════════════
 * Klíč každé kamery se odvozuje z INGEST_SECRET. Když se tajemství
 * vymění, přestanou zároveň platit klíče VŠECH kamer — a než někdo
 * objede areál a přehraje je, ingest nepřijme jedinou detekci. Přitom
 * se to ani nepozná: kamera zmlkne stejně, jako když jí někdo utrhne
 * kabel, a portál to ohlásí až po hodině jako „kamera se neozvala“.
 *
 * INGEST_SECRET_PREVIOUS proto drží tu starou hodnotu po dobu
 * přepojení. Kamery jedou dál na starém klíči, přehrávají se po jedné
 * a v logu je vidět, kolik jich ještě zbývá. Po dokončení se proměnná
 * smaže a rotace je hotová.
 *
 * Pořadí je dané: nové tajemství se zkouší první, aby už přepnutá
 * kamera prošla na první pokus a stará hodnota se s každým dnem
 * používala míň.
 * ═════════════════════════════════════════════════════════════════
 */
export function ingestSecrets(): string[] {
  const out = [required("INGEST_SECRET")];

  const previous = process.env.INGEST_SECRET_PREVIOUS?.trim();
  // Prázdná hodnota se bere jako nenastavená, jinak by se ověřovalo
  // proti prázdnému tajemství.
  if (previous) {
    // Shodné hodnoty nemají smysl a jen by zdvojily práci.
    if (previous !== out[0]) out.push(previous);
  }

  return out;
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
