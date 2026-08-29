// Čtení hlavičky MP4.
//
// Jen tolik, kolik je potřeba k tomu poznat a přepsat čtyřznakový kód
// video stopy. Ne parser MP4 — na to by byla závislost, a tohle je
// jeden box.

/** Kde v souboru leží čtyřznakový kód a jaký je. */
export interface Fourcc {
  offset: number;
  kod: string;
}

/**
 * Najde čtyřznakový kód v popisu vzorků (`stsd`).
 *
 * ═══ Proč se to parsuje a nehledá bajtově ══════════════════════════
 * Řetězec `hvc1` se v souboru může objevit i v datech obrazu. Přepsat
 * ho jinde než v popisu vzorků by soubor rozbilo — a nepoznalo by se to
 * dřív než při přehrávání.
 *
 * Tvar boxu: velikost(4) typ(4) verze+příznaky(4) počet položek(4),
 * a pak první položka: velikost(4) typ(4). Kód je tedy 16 bajtů za
 * začátkem řetězce „stsd“.
 *
 * ═══ Boxů stsd je v souboru VÍC ═══════════════════════════════════
 * Jeden na stopu. Když kamera nahrává i zvuk, je v souboru druhý
 * s kódem `mp4a` — a nezaručeně až za obrazovým. Brát první nalezený
 * znamenalo, že se u záznamu se zvukem první v pořadí trefil zvuk
 * a přepis se tiše neprovedl.
 *
 * Proto `ocekavany`: prohledají se všechny a vrátí se ten, který sedí.
 * Bez něj se vrací první, což se hodí jen na zprávu o stavu.
 */
export function najdiFourcc(buf: Buffer, ocekavany?: string): Fourcc | null {
  let i = 0;
  for (;;) {
    const stsd = buf.indexOf("stsd", i, "latin1");
    if (stsd < 0 || stsd + 20 > buf.length) return null;
    const offset = stsd + 16;
    const kod = buf.toString("latin1", offset, offset + 4);
    if (ocekavany === undefined || kod === ocekavany) return { offset, kod };
    i = stsd + 4;
  }
}

/** Zapíše jiný čtyřznakový kód na místo, které našel `najdiFourcc`. */
export function prepisFourcc(buf: Buffer, nalez: Fourcc, kod: string): void {
  if (kod.length !== 4) throw new Error(`kód musí mít 4 znaky: ${kod}`);
  buf.write(kod, nalez.offset, "latin1");
}
