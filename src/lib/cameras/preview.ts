// Statický náhled kamery — jeden snímek, obnovovaný cronem.
//
// ═══ K čemu je ═════════════════════════════════════════════════════
// Aby se v seznamu kamer poznalo, kam která kouká. Jméno KL_03 to
// neřekne nikomu, kdo po té stavbě nechodí.
//
// ═══ Není to živý obraz a nesmí tak vypadat ════════════════════════
// Snímek je starý až týden. Ukazuje se proto vždycky s datem pořízení
// (viz `preview_captured_at`) — bez něj by tvrdil, že tak ta stavba
// vypadá teď, což u bezpečnostního produktu není kosmetický rozdíl.
//
// Živý obraz zůstává tam, kde byl: v detailu jedné kamery.

/** Privátní bucket s náhledy. Zakládá ho migrace 20260921120000. */
export const PREVIEW_BUCKET = "nahledy";

/**
 * Jak dlouho platí podepsaná adresa náhledu.
 *
 * Delší než u snímku detekce (5 min): náhledů je na stránce devět
 * naráz a stránka může zůstat otevřená. Kratší než hodina, protože je
 * to pořád obraz z cizího pozemku.
 */
export const PREVIEW_SIGNED_URL_TTL = 900;

/**
 * Na jakou šířku se snímek zmenší.
 *
 * Z kamery chodí snímek v rozlišení hlavního proudu, tedy klidně
 * 2560 px a přes megabajt. V seznamu se kreslí na 96 px, na retině
 * 192 px — 640 px je s rezervou dost i pro větší náhled v detailu
 * a vejde se do desítek kilobajtů.
 */
export const PREVIEW_WIDTH = 640;

/** Kvalita JPEG po zmenšení. */
export const PREVIEW_JPEG_QUALITY = 70;

/**
 * Strop na snímek PŘIJATÝ z relaye, než se zmenší.
 *
 * Pojistka proti tomu, aby se do funkce natáhlo něco, co tam nepatří —
 * `/api/frame.jpeg` vrací jeden snímek, ne proud, ale kdyby se to na
 * relayi jednou změnilo, nemá to portálu sníst paměť.
 */
export const PREVIEW_MAX_SOURCE_BYTES = 8 * 1024 * 1024;

/**
 * Jak dlouho se čeká na snímek z jedné kamery.
 *
 * go2rtc musí nejdřív otevřít RTSP spojení na kameru přes tunel, takže
 * první snímek trvá sekundy, ne milisekundy. Dvacet vteřin je konec
 * trpělivosti: kamera, která do té doby nedá snímek, spíš nejede,
 * a běh nemá kvůli jedné kameře dojet do časového limitu funkce.
 */
export const PREVIEW_FETCH_TIMEOUT_MS = 20_000;

/**
 * Cesta náhledu v úložišti.
 *
 * První složka je URČUJÍCÍ pro přístup: politika nad storage.objects
 * z ní bere UUID lokality a pouští jen toho, kdo na lokalitu vidí.
 * Kdyby se pořadí obrátilo, četl by náhledy kdokoli přihlášený.
 *
 * Jméno souboru je UUID kamery a je bez data schválně — náhled je
 * jeden a přepisuje se. Historie náhledů by znamenala úklid navíc
 * a nikdo ji nechce; od toho jsou záznamy.
 */
export function previewPath(siteId: string, cameraId: string): string {
  return `${siteId}/${cameraId}.jpg`;
}
