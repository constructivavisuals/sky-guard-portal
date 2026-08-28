// Strop na objem videa jedné lokality.
//
// Čistý výpočet bez databáze: rozhodnutí „další záznam už nepřijmeme“
// zastaví příjem důkazního materiálu, a to se musí dát otestovat bez
// toho, aby k tomu byl potřeba plný bucket.

import { DEFAULT_RECORDING_QUOTA_BYTES } from "./storage.ts";

/** Od kolika procent se na blížící se strop upozorňuje. */
export const QUOTA_WARNING_PERCENT = 85;

export interface QuotaState {
  usedBytes: number;
  quotaBytes: number;
  /** Zaokrouhleno na celé procento; nad 100 se neuřezává. */
  percent: number;
  /** Strop je vyčerpaný — nové záznamy se nepřijímají. */
  exceeded: boolean;
  /** Blíží se ke stropu, ale ještě se přijímá. */
  warning: boolean;
}

/**
 * Stav stropu.
 *
 * Nastavená nula ani záporná hodnota nezastaví příjem: bylo by to
 * ticho, které vypadá jako porucha kamer. Bere se to jako „nenastaveno“
 * a platí výchozí strop — omylem vynulovaný sloupec nemá odstavit
 * ostrahu celé stavby.
 */
export function quotaState(
  usedBytes: number | null | undefined,
  quotaBytes: number | null | undefined,
): QuotaState {
  const strop =
    typeof quotaBytes === "number" && Number.isFinite(quotaBytes) && quotaBytes > 0
      ? quotaBytes
      : DEFAULT_RECORDING_QUOTA_BYTES;

  const pouzito =
    typeof usedBytes === "number" && Number.isFinite(usedBytes) && usedBytes > 0
      ? usedBytes
      : 0;

  const percent = Math.round((pouzito / strop) * 100);

  return {
    usedBytes: pouzito,
    quotaBytes: strop,
    percent,
    exceeded: pouzito >= strop,
    warning: percent >= QUOTA_WARNING_PERCENT && pouzito < strop,
  };
}

/**
 * Objem lidsky, do hlášky a do UI.
 *
 * ═══ Proč ne formatBytes() z lib/format.ts ═════════════════════════
 * Ta je BINÁRNÍ (kB = 1024, MB = 1048576) a končí u megabajtů — je na
 * velikosti jednoho souboru. Tohle je objem proti stropu a proti
 * faktuře, a Hetzner účtuje v DEKADICKÝCH TB. Kdyby se použila ta
 * druhá, ukazoval by portál o 10 % nižší číslo než faktura a nikdo by
 * nepoznal proč.
 *
 * Proto vlastní funkce a jiné jméno: dvě stejnojmenné s jiným
 * výsledkem by se dřív nebo později prohodily importem.
 */
export function formatQuotaBytes(bytes: number): string {
  if (bytes >= 1_000_000_000_000) return `${(bytes / 1_000_000_000_000).toFixed(1)} TB`;
  if (bytes >= 1_000_000_000) return `${Math.round(bytes / 1_000_000_000)} GB`;
  if (bytes >= 1_000_000) return `${Math.round(bytes / 1_000_000)} MB`;
  return `${bytes} B`;
}

/** Věta do varování. Jedno místo, ať zní stejně v pushi i v logu. */
export function quotaMessage(siteName: string, stav: QuotaState): string {
  return stav.exceeded
    ? `Lokalita ${siteName} vyčerpala strop na záznamy ` +
      `(${formatQuotaBytes(stav.usedBytes)} z ${formatQuotaBytes(stav.quotaBytes)}). ` +
      "Nové záznamy z kamer se nepřijímají."
    : `Lokalita ${siteName} má zaplněno ${stav.percent} % stropu na záznamy ` +
      `(${formatQuotaBytes(stav.usedBytes)} z ${formatQuotaBytes(stav.quotaBytes)}).`;
}
