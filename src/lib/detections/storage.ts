// Úložiště snímků od kamer.
//
// Bucket je privátní: na snímku je člověk na cizím pozemku. Adresa se
// podepisuje a podpis platí krátce. První složka v cestě je UUID
// lokality, takže politika nad storage.objects pouští čtení toutéž
// funkcí jako u řádků — viz migrace 20260908120000.

export const DETECTION_BUCKET = "detekce";

/** Jak dlouho platí podepsaná adresa snímku. */
export const SIGNED_URL_TTL_SECONDS = 300;
