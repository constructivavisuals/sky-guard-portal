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

/**
 * Tajemství, kterými se ověřuje RELAY, ne kamera.
 *
 * ═══ Proč vlastní, a ne záznam v cameras ═══════════════════════════
 * Kamera je zařízení; relay je prostředník, který mluví za víc kamer
 * naráz. Dát mu řádek v `cameras` by znamenalo vyrobit zařízení, které
 * neexistuje, a připsat mu sériové číslo, které nikde není. Kameru
 * relay pojmenuje sériovým číslem v těle požadavku.
 *
 * Pořadí i rotace jsou stejné jako u INGEST_SECRET: nové první,
 * předchozí po dobu přepojení. Viz ingestSecrets().
 */
export function relaySecrets(): string[] {
  const out = [required("RELAY_SECRET")];

  const previous = process.env.RELAY_SECRET_PREVIOUS?.trim();
  if (previous && previous !== out[0]) out.push(previous);

  return out;
}

export interface HetznerStorageConfig {
  endpoint: string;
  region: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
}

/**
 * Hetzner Object Storage — kde leží video ze stavebních kamer.
 *
 * ═══ Proč cizí úložiště, když bucket `zaznamy` existuje ════════════
 * Devět kamer nahrává nepřetržitě, zhruba 300 GB denně; týden zpětně
 * jsou přes 2 TB. Na Supabase Storage je to řádově dražší než 3 TB
 * u Hetzneru, a relay stojí v témže datacentru (Falkenstein), takže
 * nahrávání nic nestojí. Migrace 20260915180000 argumentovala proti
 * druhému úložišti objemem, který tehdy nebyl znám — viz
 * 20260918120000.
 *
 * ═══ Klíč je na PORTÁLU, ne na relayi ══════════════════════════════
 * Klíč platí na celý bucket a nezná RLS. Relay ho nedostane: portál mu
 * podepíše jednorázovou adresu a soubor jde do Hetzneru přímo. Tím se
 * na kompromitované VPS nenajde nic, čím by šlo číst cizí záznamy.
 */
export function hetznerStorageConfig(): HetznerStorageConfig {
  const endpoint = required("HETZNER_S3_ENDPOINT").replace(/^https?:\/\//, "").replace(/\/+$/, "");
  return {
    endpoint,
    // Region je první část endpointu (`fsn1.your-objectstorage.com`).
    // Do podpisu musí sednout přesně, jinak úložiště vrátí 403 bez
    // vysvětlení — proto se dá i přebít.
    region: process.env.HETZNER_S3_REGION?.trim() || endpoint.split(".")[0],
    bucket: process.env.HETZNER_S3_BUCKET?.trim() || "sky-guard-zaznamy",
    accessKey: required("HETZNER_S3_ACCESS_KEY"),
    secretKey: required("HETZNER_S3_SECRET_KEY"),
  };
}

/** Je Hetzner nastavený? Chybějící klíče nemají shodit build ani UI. */
export function hetznerConfigured(): boolean {
  return Boolean(
    process.env.HETZNER_S3_ACCESS_KEY && process.env.HETZNER_S3_SECRET_KEY,
  );
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
