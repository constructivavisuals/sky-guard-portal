// Serializace play() a pause() nad víc prvky <video>.
//
// ═══ Co se rozbíjelo ═══════════════════════════════════════════════
// `play()` vrací Promise, která se splní až ve chvíli, kdy se obraz
// doopravdy rozjede. Do té doby je volání ROZEHRANÉ — a když mezitím
// přijde `pause()` nebo se prvku vymění `src`, prohlížeč to volání
// ZRUŠÍ a Promise odmítne:
//
//   AbortError: The play() request was interrupted by a call to pause()
//
// U souvislého přehrávání se to potkává pravidelně, protože se střídají
// dva prvky: v jednom se rozjíždí další soubor, druhý se zastavuje.
// Zapsané jako `void prvek.play()` z toho pokaždé vznikne neodchycené
// odmítnutí v konzoli — a co hůř, přehrávání zůstane stát, protože se
// obě volání vyruší navzájem.
//
// ═══ Co s tím dělá tenhle modul ════════════════════════════════════
// Drží u každého prvku jeho rozehrané `play()` a
//
//   * `zastavit()` na něj POČKÁ, než zavolá `pause()`,
//   * zrušené volání zahodí místo aby ho nechal vybublat.
//
// Zrušené `play()` totiž NENÍ závada: znamená jen, že divák mezitím
// udělal něco jiného. Rozlišit se to ale musí od zákazu přehrávání,
// který závada svého druhu je — bez gesta uživatele prohlížeč zvuk
// nepustí a to se musí projevit na tlačítku, ne v tichu.
//
// Bez Reactu a bez DOM schválně: tohle je práce s časováním Promise
// a v prohlížeči se ladí mizerně. `MediaLike` je to jediné, co z prvku
// <video> potřebujeme, takže se dá podstrčit atrapa, která se chová
// jako prohlížeč včetně rušení.

/** To jediné, co z `<video>` potřebujeme. */
export interface MediaLike {
  readonly paused: boolean;
  play(): Promise<void> | undefined;
  pause(): void;
}

export type PlayOutcome =
  /** Rozjelo se. */
  | "hraje"
  /** Zrušil to pause() nebo nový zdroj. Není to závada. */
  | "preruseno"
  /** Prohlížeč nepustil přehrávání bez gesta uživatele. */
  | "zakazano"
  /** Cokoli jiného — stojí za to o tom vědět. */
  | "chyba";

export interface PlaybackGate {
  /** Rozehraje prvek a počká, jak to dopadlo. Nikdy nevyhodí. */
  pustit(slot: number, prvek: MediaLike | null): Promise<PlayOutcome>;
  /** Počká na rozehrané play() a teprve pak zastaví. Nikdy nevyhodí. */
  zastavit(slot: number, prvek: MediaLike | null): Promise<void>;
  /** Rozehrané volání na daném prvku, nebo null. Pro testy a ladění. */
  rozehrane(slot: number): Promise<void> | null;
}

export function createPlaybackGate(): PlaybackGate {
  /** Rozehrané play() podle prvku. Nikdy nese odmítnutou Promise. */
  const behy = new Map<number, Promise<void>>();

  async function pustit(slot: number, prvek: MediaLike | null): Promise<PlayOutcome> {
    if (!prvek) return "chyba";

    let vysledek: PlayOutcome = "hraje";

    const beh = prvek.play();
    // Starší prohlížeče vracejí undefined. Není na co čekat.
    if (!beh) return "hraje";

    // Odmítnutí se řeší TADY, ne u volajícího: kdyby se Promise
    // s odmítnutím uložila do mapy, čekání na ni v zastavit() by
    // vyrobilo druhé neodchycené odmítnutí.
    const cekani = beh.then(
      () => {},
      (chyba: unknown) => {
        const jmeno = chyba instanceof Error ? chyba.name : "";
        vysledek =
          jmeno === "AbortError"
            ? "preruseno"
            : jmeno === "NotAllowedError"
              ? "zakazano"
              : "chyba";
      },
    );

    behy.set(slot, cekani);
    await cekani;

    // Smazat jen tehdy, když mezitím nezačalo jiné volání — jinak by
    // se zapomnělo na to novější a pause() by ho zase zrušil.
    if (behy.get(slot) === cekani) behy.delete(slot);

    return vysledek;
  }

  async function zastavit(slot: number, prvek: MediaLike | null): Promise<void> {
    if (!prvek) return;

    // Tohle je celá pointa: pause() doprostřed rozehraného play() ho
    // zruší. Počká se, a teprve pak se zastavuje.
    const beh = behy.get(slot);
    if (beh) await beh;

    prvek.pause();
  }

  return { pustit, zastavit, rozehrane: (slot) => behy.get(slot) ?? null };
}
