// Úložiště médií z letů.
//
// Bucket je privátní: na záznamech z dronu je cizí pozemek a lidé na
// něm. Adresa se podepisuje a podpis platí krátce. První složka
// v cestě je UUID lokality, takže politika nad storage.objects pouští
// čtení toutéž funkcí jako u řádků — viz migrace 20260902120000.
//
// Vlastní soubor kvůli stránkám: detail letu potřebuje jen jméno
// bucketu a dobu platnosti podpisu, ne celou synchronizaci s jejím
// klientem FlightHubu a čtením snímků.

export const FLIGHT_BUCKET = "lety";

/** Jak dlouho platí podepsaná adresa média. */
export const MEDIA_SIGNED_URL_TTL = 600;

/**
 * Strop na jedno médium. Video z dronu v plné kvalitě může mít
 * stovky megabajtů; nad tímhle se soubor přeskočí a zaloguje, ať
 * synchronizace nespadne na paměti uprostřed dávky.
 */
export const MAX_MEDIA_BYTES = 512 * 1024 * 1024;
