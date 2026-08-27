import {
  verifySignature,
  type SignatureFailure,
  type SignatureResult,
} from "./signature.ts";

// Ověření podpisu relaye. Sdílené třemi cestami — ohlášení záznamu,
// jeho potvrzení a stažení konfigurace — protože tři kopie téhle
// smyčky by se při první změně rozešly a rozcházejí se tiše.
//
// Relay drží jediné tajemství, RELAY_SECRET. Podepisuje se jím přímo,
// bez odvozování na kameru: mluví za víc kamer naráz a kameru
// pojmenuje sériovým číslem v těle.
//
// Dvě tajemství při rotaci ze stejného důvodu jako u kamer: výměna
// jedné hodnoty nesmí znamenat, že se do přehrání konfigurace na VPS
// nezapíše ani jeden záznam.

export type RelayVerification =
  | { valid: true; usedPrevious: boolean }
  | { valid: false; reason: SignatureFailure };

export function verifyRelay(options: {
  rawBody: string;
  signature: string | null;
  timestamp: string | null;
  now: Date;
  /** Nové tajemství první, předchozí druhé. Viz env.relaySecrets(). */
  secrets: readonly string[];
}): RelayVerification {
  const { rawBody, signature, timestamp, now, secrets } = options;

  let posledni: SignatureResult = { valid: false, reason: "signature_mismatch" };

  for (const [index, secret] of secrets.entries()) {
    const result = verifySignature({ rawBody, signature, timestamp, now, secret });
    if (result.valid) return { valid: true, usedPrevious: index > 0 };
    posledni = result;
  }

  return posledni;
}
