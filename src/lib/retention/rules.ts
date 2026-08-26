// Čistá pravidla retence.
//
// Co se má smazat a co ne. Bez databáze, aby šlo otestovat rozhodnutí
// o mazání cizích dat — u něj se chyba pozná až tehdy, když je pozdě.

/** Výchozí lhůta, když ji lokalita nemá nastavenou. Musí sedět s DEFAULT v migraci. */
export const DEFAULT_RETENTION_DAYS = 90;

/**
 * Kolik souborů se smaže v jednom běhu.
 *
 * Strop je tu proto, že běh má konečný čas a mazání jde po dávkách;
 * co se nevejde, vezme zítřejší běh. Useknutí se vypisuje do souhrnu —
 * tiché by vypadalo jako „víc toho nebylo“.
 */
export const MAX_DELETES_PER_RUN = 500;

/** Po kolika souborech se volá úložiště. Supabase bere pole cest. */
export const DELETE_BATCH = 50;

export interface RetentionRow {
  /** Cesta v úložišti. null = soubor už není. */
  storage_path: string | null;
  /** Čas události, podle kterého se počítá stáří. */
  at: string | null;
}

/**
 * Hranice, před kterou se maže.
 *
 * Lhůta je v dnech a počítá se od okamžiku běhu, ne od půlnoci —
 * na devadesáti dnech je pár hodin jedno a zarovnávat na kalendářní
 * den by znamenalo tahat sem časové pásmo lokality.
 */
export function retentionCutoff(
  retentionDays: number | null | undefined,
  now: Date = new Date(),
): Date {
  const dny =
    typeof retentionDays === "number" && Number.isFinite(retentionDays) && retentionDays > 0
      ? retentionDays
      : DEFAULT_RETENTION_DAYS;
  return new Date(now.getTime() - dny * 86_400_000);
}

/**
 * Které řádky mají přijít o soubor.
 *
 * Řádek bez cesty se přeskočí — buď soubor nikdy neměl, nebo už ho
 * smazal dřívější běh. Řádek bez času taky: bez něj se nedá spočítat
 * stáří a smazat soubor „pro jistotu“ je přesně to, co se nemá dít.
 */
export function expiredPaths(
  rows: readonly RetentionRow[],
  cutoff: Date,
): string[] {
  const out: string[] = [];

  for (const row of rows) {
    if (!row.storage_path) continue;
    if (!row.at) continue;

    const at = new Date(row.at).getTime();
    // Nečitelné razítko není důvod mazat.
    if (!Number.isFinite(at)) continue;

    if (at < cutoff.getTime()) out.push(row.storage_path);
  }

  return out;
}

/** Rozdělí cesty do dávek, které unese jedno volání úložiště. */
export function batches<T>(items: readonly T[], size: number = DELETE_BATCH): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}
