// Přišel POST z našeho původu?
//
// ═══ Proč to route handler potřebuje ═══════════════════════════════
// Server akce Nextu si původ ověřují samy. Route handler ne — je to
// obyčejný endpoint a formulář na cizí stránce na něj může poslat POST
// s cookies uživatele. U odhlášení to znamená, že libovolný web umí
// operátora vyhodit z portálu; stačí skrytý formulář.
//
// Kontroluje se hlavička Origin, ne Referer: Origin posílá prohlížeč
// u každého POSTu napříč původy a nedá se z JavaScriptu podvrhnout,
// kdežto Referer si stránka může odstranit politikou.
//
// ═══ Proti čemu se porovnává ═══════════════════════════════════════
// Proti hlavičkám požadavku, NE proti `request.url`. Ta v route
// handleru Nextu nese vnitřní podobu adresy — na stroji, kde běží
// `next start` na 127.0.0.1, z ní vyleze `http://localhost:3100`.
// Porovnání proti ní by neprošlo nikdy a odhlásit by se nedalo vůbec.
// (Zjištěno měřením, ne z dokumentace.)
//
// Host si sice může podvrhnout kdokoli, ale pro tenhle účel to nevadí:
// prohlížeč ho vyplňuje z adresy, na kterou se připojuje, a útočník
// z cizí stránky nemá jak změnit Origin. Kdo si podvrhne obojí, nemá
// cookies uživatele — a bez nich je odhlášení k ničemu.
// ═══════════════════════════════════════════════════════════════════

export interface OriginCheck {
  ok: boolean;
  /** Do logu. Nikdy do odpovědi — cizí stránce se nemá co upřesňovat. */
  reason:
    | "same_origin"
    | "missing_origin"
    | "missing_host"
    | "cross_origin"
    | "malformed_origin";
}

/** První hodnota z hlavičky, která může být seznam (`a, b`). */
function first(value: string | null): string | null {
  if (!value) return null;
  const head = value.split(",")[0]?.trim();
  return head ? head : null;
}

/**
 * Ověří, že POST přišel z našeho původu.
 *
 * Chybějící Origin se bere jako CIZÍ. Prohlížeče ho u POSTu napříč
 * původy posílají vždycky a u formuláře z vlastní stránky taky;
 * kdo ho nemá, není prohlížeč — a přihlásit se znovu je levnější než
 * odhlašování na cizí povel.
 */
export function checkSameOrigin(headers: Headers): OriginCheck {
  const originHeader = headers.get("origin");
  if (!originHeader) return { ok: false, reason: "missing_origin" };

  const host = first(headers.get("x-forwarded-host")) ?? headers.get("host");
  if (!host) return { ok: false, reason: "missing_host" };

  let origin: URL;
  try {
    origin = new URL(originHeader);
  } catch {
    // Sem spadne i doslovné "null", které posílá sandboxovaný iframe —
    // tedy přesně ten útok.
    return { ok: false, reason: "malformed_origin" };
  }

  // `host` z hlavičky nese i port, stejně jako URL.host.
  if (origin.host !== host) return { ok: false, reason: "cross_origin" };

  // Schéma se porovnává, jen když ho víme jistě. Za proxy ho nese
  // X-Forwarded-Proto (na Vercelu vždycky); bez něj by se muselo
  // hádat a lokální vývoj na http by přestal fungovat.
  const proto = first(headers.get("x-forwarded-proto"));
  if (proto && origin.protocol !== `${proto}:`) {
    return { ok: false, reason: "cross_origin" };
  }

  return { ok: true, reason: "same_origin" };
}
