import { createHmac, timingSafeEqual } from "node:crypto";

// Ověření podpisu ingest požadavku.
//
// Podepisuje se řetězec `${timestamp}.${rawBody}`, ne samotné tělo.
// Zadání mluví o podpisu "nad raw body", to ale s ochranou proti replay
// nejde dohromady: kdyby podpis pokrýval jen tělo, útočník odchycený
// požadavek přehraje s čerstvou hlavičkou X-Timestamp a projde, protože
// hlavička není ničím chráněná. Svázáním času s tělem (stejné schéma
// používá Stripe i Slack) platí podpis jen pro to jedno okno.
//
// Odesílatel tedy počítá:
//   HMAC-SHA256(INGEST_SECRET, `${X-Timestamp}.${raw body}`)

/** Tolerance stáří požadavku. Platí i do budoucna kvůli rozjetým hodinám. */
export const DEFAULT_TOLERANCE_SECONDS = 300;

export type SignatureFailure =
  | "missing_signature"
  | "missing_timestamp"
  | "malformed_timestamp"
  | "malformed_signature"
  | "stale_timestamp"
  | "signature_mismatch";

export type SignatureResult =
  | { valid: true }
  | { valid: false; reason: SignatureFailure };

export interface VerifyOptions {
  rawBody: string;
  /** Obsah hlavičky X-Signature — hex, volitelně s prefixem `sha256=`. */
  signature: string | null;
  /** Obsah hlavičky X-Timestamp — unixový čas v sekundách. */
  timestamp: string | null;
  secret: string;
  now?: Date;
  toleranceSeconds?: number;
}

/** Kanonický řetězec, nad kterým se počítá HMAC. */
export function signedPayload(timestamp: string, rawBody: string): string {
  return `${timestamp}.${rawBody}`;
}

/** Podpis, jak ho má spočítat odesílatel. Sdílené s testy. */
export function computeSignature(
  secret: string,
  timestamp: string,
  rawBody: string,
): string {
  return createHmac("sha256", secret)
    .update(signedPayload(timestamp, rawBody), "utf8")
    .digest("hex");
}

/** Porovnání v konstantním čase. Délka hexu není tajná, tak ji smíme řešit dřív. */
function equalsInConstantTime(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

export function verifySignature(options: VerifyOptions): SignatureResult {
  const {
    rawBody,
    signature,
    timestamp,
    secret,
    now = new Date(),
    toleranceSeconds = DEFAULT_TOLERANCE_SECONDS,
  } = options;

  // Časové razítko se řeší JAKO PRVNÍ, dřív než cokoli o podpisu.
  // Nejde o výkon, ale o to, co smí ven: dokud není razítko platné,
  // odpověď nesmí prozradit, ve které fázi ověření to spadlo — viz
  // publicFailureReason() níž.
  if (!timestamp) return { valid: false, reason: "missing_timestamp" };

  if (!/^\d{1,15}$/.test(timestamp)) {
    return { valid: false, reason: "malformed_timestamp" };
  }

  // Stáří se kontroluje před HMAC — starý požadavek nemá cenu počítat.
  const ageSeconds = Math.abs(
    now.getTime() / 1000 - Number.parseInt(timestamp, 10),
  );
  if (ageSeconds > toleranceSeconds) {
    return { valid: false, reason: "stale_timestamp" };
  }

  if (!signature) return { valid: false, reason: "missing_signature" };

  const provided = signature.startsWith("sha256=")
    ? signature.slice("sha256=".length)
    : signature;

  if (!/^[0-9a-fA-F]{64}$/.test(provided)) {
    return { valid: false, reason: "malformed_signature" };
  }

  const expected = computeSignature(secret, timestamp, rawBody);
  if (!equalsInConstantTime(expected, provided.toLowerCase())) {
    return { valid: false, reason: "signature_mismatch" };
  }

  return { valid: true };
}

/**
 * Které důvody se smí poslat v odpovědi.
 *
 * ═══ Proč ne všechny ═══════════════════════════════════════════════
 * Rozdíl mezi „razítko je staré“ a „podpis nesedí“ je pro nepřihlášeného
 * volajícího návod: dá se z něj po částech zjistit, kde přesně končí
 * tolerance a jestli se vůbec trefuje do okna. Ověřovat se má buď celé,
 * nebo nic.
 *
 * Jakmile je razítko platné, konkrétní důvod už nic neprozrazuje —
 * volající zná čas, který poslal, i ten současný. Zůstává tedy jako
 * nápověda pro toho, kdo kameru zapojuje, a to je přesně ta chvíle,
 * kdy je k něčemu.
 *
 * Úplný důvod jde vždycky do serverového logu; ubývá jen z odpovědi.
 * ═══════════════════════════════════════════════════════════════════
 */
export function publicFailureReason(
  reason: SignatureFailure,
): SignatureFailure | null {
  switch (reason) {
    // Fáze razítka: dokud není platné, ven nejde nic konkrétního.
    case "missing_timestamp":
    case "malformed_timestamp":
    case "stale_timestamp":
      return null;
    // Za platným razítkem už konkrétní důvod nic nepřidává útočníkovi
    // a hodně pomáhá integrátorovi.
    default:
      return reason;
  }
}
