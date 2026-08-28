import { createHmac, timingSafeEqual } from "node:crypto";

// Lístek na živý obraz jedné kamery.
//
// ═══ Proč vůbec ════════════════════════════════════════════════════
// Živý obraz nejde vést přes portál: serverless funkce neudrží
// minutové spojení a video by teklo přes Vercel. Prohlížeč se proto
// připojuje PŘÍMO na relay — a ten o přihlášených uživatelích nic neví
// a vědět nemá.
//
// Rozhoduje tedy portál a relayi to řekne podepsaným lístkem. Je to
// týž vzor jako u /api/media, jen obráceně: tam portál podepisuje
// adresu do úložiště, tady lístek pro vlastní VPS.
//
//   1. prohlížeč si řekne portálu o kameru
//   2. portál pod RLS ověří, že na ni uživatel vidí
//   3. vydá lístek platný pár minut, jen na TU kameru
//   4. relay lístek ověří a teprve pak pustí proud
//
// ═══ Co lístek NENÍ ════════════════════════════════════════════════
// Není to session. Platí krátce, protože se jím jen NAVAZUJE spojení;
// jakmile proud běží, drží ho socket, ne lístek. Kdo si lístek uloží,
// nedostane s ním nic po vypršení — a nedostane s ním ani jinou kameru
// než tu, na kterou byl vydán.
//
// ═══ Musí sedět s live.py na relayi ════════════════════════════════
// Ověřuje ho Python na druhé straně. Kdyby se obě strany rozešly
// v tom, co přesně se podepisuje, projeví se to jako „neplatný
// lístek“ — tedy stejně jako špatné tajemství. Hlídá to
// scripts/hranice-listek.mjs, který obě implementace porovnává na
// stejných vstupech.

/**
 * Jak dlouho lístek platí.
 *
 * Dvě minuty jsou s rezervou dost na navázání spojení i na pomalém
 * mobilu, a zároveň krátce na to, aby uniklý lístek za chvíli nebyl
 * k ničemu. Delší nemá smysl: běžící proud drží socket.
 */
export const LIVE_TOKEN_TTL_SECONDS = 120;

/**
 * Podepisovaná zpráva.
 *
 * Jméno proudu je uvnitř schválně — bez něj by šel lístek na jednu
 * kameru použít na kteroukoli jinou, tedy i na cizí stavbě.
 */
function message(stream: string, expiresAt: number): string {
  return `${stream}.${expiresAt}`;
}

export interface LiveToken {
  /** Tvar `<vyprší>.<podpis>`; jméno proudu jde vedle, v adrese. */
  token: string;
  expiresAt: number;
  expiresIn: number;
}

export function issueLiveToken(options: {
  stream: string;
  secret: string;
  now?: Date;
  ttlSeconds?: number;
}): LiveToken {
  const ttl = options.ttlSeconds ?? LIVE_TOKEN_TTL_SECONDS;
  const vydano = Math.floor((options.now ?? new Date()).getTime() / 1000);
  const expiresAt = vydano + ttl;

  const podpis = createHmac("sha256", options.secret)
    .update(message(options.stream, expiresAt))
    .digest("hex");

  return { token: `${expiresAt}.${podpis}`, expiresAt, expiresIn: ttl };
}

export type LiveTokenFailure =
  | "malformed"
  | "expired"
  | "bad_signature";

export type LiveTokenCheck =
  | { valid: true; expiresAt: number }
  | { valid: false; reason: LiveTokenFailure };

/**
 * Ověří lístek pro KONKRÉTNÍ proud.
 *
 * Jméno proudu je povinný vstup, ne něco, co by se četlo z lístku:
 * ověřuje se tím, že lístek patří k tomu, co si volající vyžádal.
 */
export function verifyLiveToken(options: {
  stream: string;
  token: string | null | undefined;
  secret: string;
  now?: Date;
}): LiveTokenCheck {
  const raw = options.token?.trim();
  if (!raw) return { valid: false, reason: "malformed" };

  const tecka = raw.indexOf(".");
  if (tecka <= 0) return { valid: false, reason: "malformed" };

  const expiresAt = Number(raw.slice(0, tecka));
  const podpis = raw.slice(tecka + 1);

  if (!Number.isInteger(expiresAt) || expiresAt <= 0 || !/^[0-9a-f]{64}$/.test(podpis)) {
    return { valid: false, reason: "malformed" };
  }

  // Platnost se kontroluje PŘED podpisem: propadlý lístek není důvod
  // počítat HMAC a je to levnější odmítnutí.
  const ted = Math.floor((options.now ?? new Date()).getTime() / 1000);
  if (ted >= expiresAt) return { valid: false, reason: "expired" };

  const ocekavany = createHmac("sha256", options.secret)
    .update(message(options.stream, expiresAt))
    .digest("hex");

  // Porovnání v konstantním čase: rozdíl v době odpovědi by prozradil,
  // kolik znaků podpisu sedí, a dal by podpis uhádnout po znacích.
  const a = Buffer.from(ocekavany, "utf8");
  const b = Buffer.from(podpis, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { valid: false, reason: "bad_signature" };
  }

  return { valid: true, expiresAt };
}
