import { PLATE_CONFIDENCE_MIN, type PlateVerdict } from "../plates.ts";
import type { PlateListType } from "../../types/database.ts";

// Jak se uložený vjezd čte zpátky.
//
// Verdikt se do databáze ukládá jen tehdy, když značka padla na seznam
// (list_match). Zbytek se odvozuje z toho, co v řádku je — a odvozuje
// se TADY, jednou, aby seznam, detail i přehled nedávaly každý jinou
// odpověď.

export interface PassageVerdictInput {
  plate: string | null;
  confidence: number | null;
  list_match: PlateListType | null;
  plate_read_at: string | null;
}

/** Vjezd čeká na přečtení, nebo ho už má za sebou? */
export function isPlatePending(row: PassageVerdictInput): boolean {
  return row.plate_read_at === null;
}

/** Byla přečtená značka pod prahem jistoty? */
export function isPlateUncertain(row: PassageVerdictInput): boolean {
  return (
    row.plate !== null &&
    row.confidence !== null &&
    row.confidence < PLATE_CONFIDENCE_MIN
  );
}

/**
 * Verdikt pro zobrazení.
 *
 * `pending` je stav navíc oproti PlateVerdict: čtení běží na pozadí,
 * takže mezi zápisem vjezdu a přečtením značky je okamžik, kdy ještě
 * nic nevíme. Tvářit se v něm jako „nepřečteno“ by bylo tvrzení, které
 * se za vteřinu změní.
 */
export function passageVerdict(
  row: PassageVerdictInput,
): PlateVerdict | "pending" {
  if (isPlatePending(row)) return "pending";
  if (row.list_match) return row.list_match;
  if (!row.plate) return "unread";
  // Přečtená, ale nejistá značka se se seznamem nepárovala, takže
  // v list_match nic není — ale „neznámá“ to taky není. Nevíme.
  if (isPlateUncertain(row)) return "unread";
  return "unknown";
}
