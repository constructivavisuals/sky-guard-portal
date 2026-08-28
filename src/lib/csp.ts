// Content-Security-Policy portálu.
//
// Vlastní modul, ne řetězec v next.config.ts, kvůli TESTŮM. Chybějící
// direktiva se totiž neprojeví ničím, co by šlo vidět při buildu ani
// v testech aplikace — projeví se až v prohlížeči u klienta, jako že
// „video nejde“. Přesně tak nám unikl `media-src`: video z dronu se
// nedalo přehrát od zavedení CSP a nikdo si toho nevšiml, protože
// obrázky (img-src) povolené byly a chyba se ukázala až u záznamů
// z kamer.
//
// ═══ Odkud se smí načítat MÉDIUM ═══════════════════════════════════
// Ze dvou míst, a obojí musí být v `media-src`:
//
//   Supabase Storage  — média z letů a záznamy z doby před přechodem
//   Hetzner           — záznamy ze stavebních kamer
//
// Adresa přitom vede na /api/media, tedy na vlastní původ. To NESTAČÍ:
// portál odpoví přesměrováním a prohlížeč kontroluje i cíl toho
// přesměrování. Proto tu musí být cizí původy, i když na ně v kódu
// nikde neodkazujeme přímo.

/** Kde končí `default-src 'self'` a musí se to říct výslovně. */
export interface CspOptions {
  /** `NEXT_PUBLIC_SUPABASE_URL`; chybí při buildu bez .env. */
  supabaseUrl?: string;
  /** `HETZNER_S3_ENDPOINT`, např. `fsn1.your-objectstorage.com`. */
  hetznerEndpoint?: string;
  /** `LIVE_STREAM_BASE_URL`, např. `https://kamery.sky-guard.cz`. */
  liveBaseUrl?: string;
  /**
   * Vývojový režim.
   *
   * `next dev` staví zdrojové mapy přes `eval`, takže bez
   * `'unsafe-eval'` se HMR nerozjede. V produkci ho nepotřebuje ani
   * jeden chunk — ověřeno grepem přes .next/static/chunks — a je to
   * zbytečné povolení, kterým se dá spustit vložený kód.
   */
  dev?: boolean;
}

/**
 * Původ projektu Supabase, odkud se načítají soubory.
 *
 * Doména projektu se mezi prostředími liší, tak se bere z proměnné.
 * Když chybí (build bez .env), pustí se celá supabase.co — přísnější
 * hodnota by rozbila přihlášení a projevilo by se to až u klienta.
 */
export function supabaseOrigin(supabaseUrl?: string): string {
  const raw = supabaseUrl?.trim();
  if (!raw) return "https://*.supabase.co";
  try {
    return new URL(raw).origin;
  } catch {
    return "https://*.supabase.co";
  }
}

/**
 * Totéž pro `connect-src`, tedy včetně websocketu.
 *
 * Odděleně od `supabaseOrigin()` schválně: `wss://` má smysl JEN
 * u connect-src. V `img-src` nebo `media-src` je to šum, který svádí
 * k domněnce, že se odtamtud něco streamuje.
 */
export function supabaseConnectOrigin(supabaseUrl?: string): string {
  const raw = supabaseUrl?.trim();
  if (!raw) return "https://*.supabase.co wss://*.supabase.co";
  try {
    const url = new URL(raw);
    const ws = url.protocol === "https:" ? "wss:" : "ws:";
    return `${url.origin} ${ws}//${url.host}`;
  } catch {
    return "https://*.supabase.co wss://*.supabase.co";
  }
}

/**
 * Odkud smí prohlížeč načítat video z Hetzneru.
 *
 * Dvojí tvar schválně: klient v `lib/storage/s3.ts` skládá adresy
 * virtual-hosted (`bucket.fsn1.…`), ale path-style (`fsn1.…/bucket`)
 * je jedním přepínačem daleko. Kdyby v CSP byl jen jeden tvar,
 * přepnutí by video umlčelo a vypadalo by to jako vada úložiště.
 */
export function hetznerOrigin(endpoint?: string): string {
  const raw = endpoint?.trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
  // Bez proměnné (build bez .env) se pustí celá doména úložiště
  // Hetzneru. Pořád je to jeden dodavatel, ne celý internet.
  if (!raw) return "https://*.your-objectstorage.com";
  return `https://${raw} https://*.${raw}`;
}

/**
 * Odkud si prohlížeč smí říct o živý obraz.
 *
 * Websocket, ne https: obraz teče přes `wss://`. Bez proměnné se
 * nevrací nic — na rozdíl od úložiště tu není rozumná náhradní
 * hodnota a pustit „jakýkoli websocket“ by zrušilo půlku smyslu CSP.
 * Nenastavený živý obraz se stejně nikam nepřipojuje.
 */
export function liveOrigin(baseUrl?: string): string {
  const raw = baseUrl?.trim();
  if (!raw) return "";
  try {
    const url = new URL(raw);
    const ws = url.protocol === "https:" ? "wss:" : "ws:";
    return `${ws}//${url.host}`;
  } catch {
    return "";
  }
}

export function contentSecurityPolicy(options: CspOptions = {}): string {
  const supabase = supabaseOrigin(options.supabaseUrl);
  const supabaseConnect = supabaseConnectOrigin(options.supabaseUrl);
  const hetzner = hetznerOrigin(options.hetznerEndpoint);
  const live = liveOrigin(options.liveBaseUrl);

  // Next si do stránky vkládá vlastní inline skripty (streamování,
  // hydratace), takže bez 'unsafe-inline' by se portál nespustil.
  // Utáhnout by to šlo jedině nonce vydávaným v middleware a protaženým
  // do všech skriptů — to je samostatná změna, ne řádek v konfiguraci.
  const script = options.dev
    ? "'self' 'unsafe-inline' 'unsafe-eval'"
    : "'self' 'unsafe-inline'";

  return [
    "default-src 'self'",
    `script-src ${script}`,
    "style-src 'self' 'unsafe-inline'",
    // Loga klientů, snímky detekcí a vjezdů leží v Supabase Storage,
    // podklady areálu v public/.
    `img-src 'self' data: blob: ${supabase}`,
    // Video: z letů a starých záznamů Supabase, z kamer Hetzner.
    // Vlastní původ kvůli /api/media, cizí kvůli jeho přesměrování.
    //
    // `blob:` kvůli ŽIVÉMU obrazu: ten neteče z adresy, ale skládá se
    // v prohlížeči přes MediaSource, a ta se do <video> dostane jako
    // blob. Bez toho se živý obraz nerozjede, přestože se websocket
    // připojí — a vypadá to jako vada kamery.
    `media-src 'self' blob: ${supabase} ${hetzner}`,
    "font-src 'self' data:",
    // Živý obraz teče přes websocket přímo z relaye, ne přes portál.
    `connect-src ${["'self'", supabaseConnect, live].filter(Boolean).join(" ")}`,
    // Servisní worker a manifest jsou naše. Výslovně, i když by je
    // pokryl fallback — aby je nerozvolnilo pozdější uvolnění
    // script-src nebo default-src.
    "worker-src 'self'",
    "manifest-src 'self'",
    // Nic se nesmí vkládat do rámu a portál sám nikam nepatří.
    "frame-ancestors 'none'",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    // Formuláře smí odesílat jen na vlastní původ — brzda pro případ,
    // že by se do stránky dostal cizí <form action>.
    "form-action 'self'",
    "upgrade-insecure-requests",
  ].join("; ");
}
