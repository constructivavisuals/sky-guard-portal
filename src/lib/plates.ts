// Práce se značkami.
//
// Normalizace je tu JEDNOU. V constructiva-portal, odkud je evidence
// převzatá, byla tatáž úprava opsaná na čtyřech místech — jednou v SQL
// a třikrát inline v TypeScriptu — bez sdíleného helperu a bez testu.
// Kdyby se pravidlo změnilo (třeba kvůli záměně 0 a O), rozešlo by se
// to potichu a párování se seznamem by tiše přestalo fungovat.
//
// Protějšek SQL funkce plate_normalize() v migraci 20260901120000.
// Shodu obou implementací hlídá paritní test v run-local.sh, stejně
// jako u site_is_armed().

/**
 * Porovnávací tvar značky: velká písmena, bez všeho, co není písmeno
 * nebo číslice.
 *
 * `1AB 2345`, `1ab2345` i `1AB-2345` dají `1AB2345`.
 *
 * Rozsah je schválně jen ASCII, stejně jako `[^a-zA-Z0-9]` v SQL:
 * česká značka jiné znaky neobsahuje a širší rozsah by se v obou
 * implementacích choval jinak — regulární výrazy v Postgresu
 * a v JavaScriptu si Unicode třídy nevykládají stejně.
 */
export function normalizePlate(plate: string): string {
  return plate.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/**
 * Pod touhle jistotou se přečtená značka bere jako nespolehlivá.
 *
 * Nejde jen o odstín v UI: nejistá značka se NEPÁRUJE se seznamem.
 * Spustit zásah kvůli špatně přečtené deny značce je planý poplach,
 * ale odbavit cizí auto jako známé kvůli špatně přečtené allow značce
 * je díra v ostraze — a to je horší.
 */
export const PLATE_CONFIDENCE_MIN = 0.7;

/** Dá se téhle přečtené značce věřit natolik, aby se podle ní rozhodovalo? */
export function isPlateReliable(
  plate: string | null,
  confidence: number | null,
): boolean {
  if (!plate) return false;
  // Chybějící jistota není totéž co vysoká. Model ji vrací vždy, když
  // něco přečetl; její nepřítomnost znamená rozbitou odpověď.
  if (confidence === null || !Number.isFinite(confidence)) return false;
  return confidence >= PLATE_CONFIDENCE_MIN;
}

/** Jak vjezd dopadl proti seznamu známých značek. */
export type PlateVerdict = "allow" | "deny" | "unknown" | "unread";

export interface KnownPlate {
  id: string;
  plate: string;
  label: string | null;
  list_type: "allow" | "deny";
}

export interface PlateMatch {
  verdict: PlateVerdict;
  knownPlateId: string | null;
  knownLabel: string | null;
}

/**
 * Přiřadí přečtenou značku k seznamu.
 *
 * `unread` je zvlášť od `unknown`: „nepřečetli jsme ji“ a „přečetli
 * a v seznamu není“ vedou na jiné chování a v přehledu se nesmí
 * slévat. Nejistá značka spadá pod `unread`, viz PLATE_CONFIDENCE_MIN.
 */
export function matchPlate(
  plate: string | null,
  confidence: number | null,
  known: KnownPlate[],
): PlateMatch {
  if (!isPlateReliable(plate, confidence)) {
    return { verdict: "unread", knownPlateId: null, knownLabel: null };
  }

  const hledana = normalizePlate(plate as string);
  const nalezena = known.find((k) => normalizePlate(k.plate) === hledana);

  if (!nalezena) {
    return { verdict: "unknown", knownPlateId: null, knownLabel: null };
  }

  return {
    verdict: nalezena.list_type,
    knownPlateId: nalezena.id,
    knownLabel: nalezena.label,
  };
}

export const PLATE_VERDICT_LABELS: Record<PlateVerdict, string> = {
  allow: "Známé vozidlo",
  deny: "Nežádoucí",
  unknown: "Neznámá značka",
  unread: "Značka nepřečtená",
};
