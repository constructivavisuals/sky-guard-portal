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
 * Za Vercelem je skutečná adresa v x-forwarded-for; první položka je
 * klient, zbytek jsou proxy. Hlavičku si může kdokoli vymyslet, takže
 * jako důkaz neslouží — na omezení počtu požadavků a do logu stačí.
 */
export function clientIp(headers: Headers): string | null {
  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first.slice(0, 45);
  }
  const real = headers.get("x-real-ip");
  return real ? real.trim().slice(0, 45) : null;
}
