import type { SupabaseClient } from "@supabase/supabase-js";

// Omezení počtu požadavků na ingest.
//
// Vědro s žetony žije v databázi, ne v paměti procesu: na Vercelu běží
// každý požadavek klidně na jiné instanci, takže čítač v paměti by
// hlídal jednu instanci z mnoha a dohromady by nezastavil nic.
//
// Klíčů je schválně víc. Sériové číslo si určuje odesílatel v těle,
// které v tu chvíli ještě není ověřené — kdo by chtěl limit obejít,
// střídal by vymyšlená čísla. Vedle něj proto stojí vědro na IP.

/** Kolik požadavků smí kamera poslat v nárazu. */
export const BURST = 30;

/** A kolik za vteřinu v ustáleném stavu. */
export const REFILL_PER_SECOND = 1;

/** IP pustí víc — může za ní být celý areál kamer. */
export const IP_BURST = 120;
export const IP_REFILL_PER_SECOND = 4;

export interface RateLimitVerdict {
  allowed: boolean;
  /** Který klíč došel; jen pro log, volajícímu se neposílá. */
  reason: "camera" | "ip" | "unavailable" | null;
}

/**
 * Vezme žeton kameře i IP naráz.
 *
 * Když databáze neodpoví, požadavek se PUSTÍ dál. Limit je ochrana
 * proti zahlcení, ne autentizace — kdyby výpadek databáze umlčel
 * ingest, přišli bychom o detekce kvůli něčemu, co s bezpečností
 * nesouvisí. Podpis se stejně ověřuje pak.
 */
export async function takeIngestToken(
  db: SupabaseClient,
  keys: { cameraSerial: string | null; ip: string | null },
): Promise<RateLimitVerdict> {
  const bucketKeys: string[] = [];
  if (keys.cameraSerial) bucketKeys.push(`cam:${keys.cameraSerial}`);
  if (keys.ip) bucketKeys.push(`ip:${keys.ip}`);
  if (bucketKeys.length === 0) return { allowed: true, reason: null };

  // Dvě volání, protože každý klíč má jiný strop. Vědra se odečítají
  // nezávisle; kdyby jedno došlo, druhé se stejně už neptáme.
  const camera = keys.cameraSerial
    ? await take(db, [`cam:${keys.cameraSerial}`], BURST, REFILL_PER_SECOND)
    : true;
  if (camera === "unavailable") return { allowed: true, reason: "unavailable" };
  if (!camera) return { allowed: false, reason: "camera" };

  const ip = keys.ip
    ? await take(db, [`ip:${keys.ip}`], IP_BURST, IP_REFILL_PER_SECOND)
    : true;
  if (ip === "unavailable") return { allowed: true, reason: "unavailable" };
  if (!ip) return { allowed: false, reason: "ip" };

  return { allowed: true, reason: null };
}

/**
 * Vědro pro stránku řidiče.
 *
 * Stejný mechanismus jako u ingestu, jiné stropy: člověk na mobilu
 * pošle za minutu jednotky požadavků, ne desítky. Klíčem je token, ne
 * dopravce — cizí token se dá zkoušet uhodnout a limit má takový pokus
 * zdržet dřív, než se vůbec sáhne do databáze.
 *
 * Vedle toho vědro na IP, aby se stropu nešlo vyhnout střídáním tokenů.
 */
export const ARRIVAL_BURST = 20;
export const ARRIVAL_REFILL_PER_SECOND = 0.2;

export async function takeArrivalToken(
  db: SupabaseClient,
  keys: { token: string | null; ip: string | null },
): Promise<RateLimitVerdict> {
  if (keys.token) {
    const token = await take(
      db,
      // Do klíče jde jen otisk začátku: celý token nemá co ležet
      // v tabulce věder, ke které má přístup víc kódu než k dopravcům.
      [`arr:${keys.token.slice(0, 16)}`],
      ARRIVAL_BURST,
      ARRIVAL_REFILL_PER_SECOND,
    );
    if (token === "unavailable") return { allowed: true, reason: "unavailable" };
    if (!token) return { allowed: false, reason: "camera" };
  }

  if (keys.ip) {
    const ip = await take(
      db,
      [`arrip:${keys.ip}`],
      ARRIVAL_BURST * 3,
      ARRIVAL_REFILL_PER_SECOND * 3,
    );
    if (ip === "unavailable") return { allowed: true, reason: "unavailable" };
    if (!ip) return { allowed: false, reason: "ip" };
  }

  return { allowed: true, reason: null };
}

async function take(
  db: SupabaseClient,
  keys: string[],
  capacity: number,
  refillPerSecond: number,
): Promise<boolean | "unavailable"> {
  const { data, error } = await db.rpc("ingest_take_tokens", {
    p_keys: keys,
    p_capacity: capacity,
    p_refill_per_second: refillPerSecond,
  });

  if (error) return "unavailable";
  return data === true;
}

/**
 * IP odesílatele.
 *
 * ═══ Pořadí zdrojů není libovolné ══════════════════════════════════
 * `x-forwarded-for` si smí připsat kdokoli po cestě, včetně toho, kdo
 * požadavek posílá. Brát z něj PRVNÍ položku znamená brát hodnotu,
 * kterou si odesílatel vybral sám — a tou se dají udělat tři věci:
 *
 *   * obejít vědro na IP (každý požadavek si vymyslí jinou adresu),
 *   * nafouknout tabulku věder donekonečna,
 *   * podvrhnout `detections.source_ip`, což je údaj, který detail
 *     detekce ukazuje operátorovi jako doklad o původu.
 *
 * Věřit se dá jen tomu, co doplnila NAŠE proxy:
 *
 *   1. `x-vercel-forwarded-for` — nastavuje edge Vercelu a odesílatel
 *      ji přepsat nemůže; cizí hodnota se zahodí.
 *   2. `x-real-ip` — totéž u běžných reverzních proxy.
 *   3. poslední položka `x-forwarded-for` — tu připsala proxy nejblíž
 *      k nám. Ne první: ta je z druhého konce řetězu, tedy od
 *      odesílatele.
 *
 * Za jiným než popsaným nasazením (přímo vystavený Node) je poslední
 * položka pořád tou nejméně špatnou volbou.
 * ═══════════════════════════════════════════════════════════════════
 */
export function clientIp(headers: Headers): string | null {
  const vercel = prvni(headers.get("x-vercel-forwarded-for"));
  if (vercel) return vercel;

  const real = headers.get("x-real-ip")?.trim();
  if (real) return real.slice(0, MAX_IP_LENGTH);

  return posledni(headers.get("x-forwarded-for"));
}

/** Nejdelší adresa, která dává smysl: IPv6 se zónou. */
const MAX_IP_LENGTH = 45;

/** První položka seznamu — u hlavičky od naší proxy je to klient. */
function prvni(value: string | null): string | null {
  const first = value?.split(",")[0]?.trim();
  return first ? first.slice(0, MAX_IP_LENGTH) : null;
}

/** Poslední položka seznamu — tu připsala proxy nejblíž k nám. */
function posledni(value: string | null): string | null {
  if (!value) return null;
  const parts = value.split(",");
  const last = parts[parts.length - 1]?.trim();
  return last ? last.slice(0, MAX_IP_LENGTH) : null;
}
