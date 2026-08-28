// Čistá pravidla retence.
//
// Co se má smazat a co ne. Bez databáze, aby šlo otestovat rozhodnutí
// o mazání cizích dat — u něj se chyba pozná až tehdy, když je pozdě.

/** Výchozí lhůta, když ji lokalita nemá nastavenou. Musí sedět s DEFAULT v migraci. */
export const DEFAULT_RETENTION_DAYS = 90;

/**
 * Výchozí lhůta pro VIDEO ze stavebních kamer (sites.clip_retention_days).
 *
 * Kratší než retention_days schválně a je to ta dražší lhůta: devět
 * kamer nahrává nepřetržitě, takže každý den navíc je zhruba 300 GB
 * v Hetzneru. Snímky detekcí a vjezdů jedou dál na devadesáti dnech —
 * jsou malé a jsou to důkazy.
 *
 * Musí sedět s DEFAULT v migraci 20260914120000.
 */
export const DEFAULT_CLIP_RETENTION_DAYS = 14;

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
  fallbackDays: number = DEFAULT_RETENTION_DAYS,
): Date {
  const dny =
    typeof retentionDays === "number" && Number.isFinite(retentionDays) && retentionDays > 0
      ? retentionDays
      : fallbackDays;
  return new Date(now.getTime() - dny * 86_400_000);
}

/**
 * Hranice pro video ze stavebních kamer.
 *
 * Vlastní funkce, ne jen jiné číslo v volání: splést si tuhle lhůtu
 * s retention_days znamená buď smazat důkazy o 76 dní dřív, nebo držet
 * v Hetzneru šestinásobek videa. Obojí se pozná až pozdě.
 */
export function clipRetentionCutoff(
  clipRetentionDays: number | null | undefined,
  now: Date = new Date(),
): Date {
  return retentionCutoff(clipRetentionDays, now, DEFAULT_CLIP_RETENTION_DAYS);
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

// ── Anonymizace ──────────────────────────────────────────────────
//
// ═══ Proč se řádky nemažou ═════════════════════════════════════════
// SPZ je osobní údaj a držet ho bez lhůty nejde. Smazat celý vjezd by
// ale zahodilo i to, co osobní údaj není: kolikrát někdo do areálu
// vjel a kolik z toho bylo neznámých značek. Ta čísla jsou v měsíčním
// reportu a musí platit i zpětně.
//
// Řádek proto zůstane a zmizí z něj jen to, čím se dá identifikovat
// osoba nebo vozidlo. Hashování by nestačilo: SPZ je krátký
// a vyčíslitelný řetězec, takže z otisku jde původní hodnota dopočítat
// hrubou silou — to je pseudonymizace vydávaná za anonymizaci.
// ═══════════════════════════════════════════════════════════════════

/**
 * Kolik řádků se v jednom běhu anonymizuje.
 *
 * Vyšší než strop na mazání souborů: tady se nikam nevolá po síti, jde
 * jen o to, aby jeden UPDATE nezabral celý běh.
 */
export const MAX_ANONYMIZE_PER_RUN = 5_000;

/**
 * Po jaké nečinnosti se maže vědro rate limitu.
 *
 * Klíč vědra nese IP adresu, tedy osobní údaj. Hodina je s rezervou
 * víc, než kolik trvá nejpomalejší doplnění (0,2 žetonu za vteřinu
 * u stránky řidiče, tedy plné vědro za necelé dvě minuty), takže se
 * mazáním o žádnou ochranu nepřijde.
 */
export const RATE_LIMIT_RETENTION_MINUTES = 60;

/** Co se z vjezdu po lhůtě vymaže. Ostatní sloupce zůstávají. */
export function passageAnonymization(now: Date = new Date()) {
  return {
    // Samotná značka.
    plate: null,
    // Jistota čtení bez značky nic neříká a jen svádí k domýšlení.
    confidence: null,
    // Jméno ze seznamu — typicky firma nebo člověk („Novák, beton“).
    known_label: null,
    known_plate_id: null,
    anonymized_at: now.toISOString(),
    // POZOR: list_match a plate_source se schválně NEMAŽOU. Nejsou to
    // údaje o osobě, ale o tom, jak vjezd dopadl a kdo značku četl —
    // a rozpad na známé a neznámé musí v reportu platit i zpětně.
  };
}

/** Co se z ohlášení po lhůtě vymaže. */
export function arrivalAnonymization(now: Date = new Date()) {
  return {
    plate: null,
    // Volný text od řidiče. Může v něm být cokoli včetně jména.
    note: null,
    anonymized_at: now.toISOString(),
  };
}

/**
 * Kalendářní datum `dny` zpět v ISO tvaru.
 *
 * Ohlášení nemá čas, jen datum příjezdu, takže se lhůta musí porovnat
 * taky datem. Pásmo se neřeší: den sem nebo tam je u devadesátidenní
 * lhůty jedno.
 */
export function cutoffDateISO(cutoff: Date): string {
  return cutoff.toISOString().slice(0, 10);
}
