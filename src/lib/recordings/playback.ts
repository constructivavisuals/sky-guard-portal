import { recordingMediaHref, recordingPlayback } from "./storage.ts";

// Souvislé přehrávání dne z jednotlivých souborů.
//
// ═══ Co je tu za problém ═══════════════════════════════════════════
// Kamera nahrává po osmiminutových kusech. To je detail toho, jak se
// data vozí — klienta zajímá „co se dělo ve tři odpoledne“, ne který
// soubor to zachytil. Tenhle modul dělá překlad mezi obojím:
//
//   čas na ose  ──locateTime()──►  který soubor + kolik vteřin do něj
//   pozice v souboru ──absoluteTime()──►  skutečný čas záznamu
//
// Bez Reactu a bez DOM schválně. Aritmetika kolem hranic souborů
// a mezer mezi nimi je přesně to, na čem se dá tiše ujet o minuty,
// a v prohlížeči se to ladí mizerně.
//
// ═══ Délka z databáze je ODHAD ═════════════════════════════════════
// `ended_at - started_at` je čas, který kamera napsala do názvu
// souboru. Skutečná délka videa se od něj může o kus lišit (zahozené
// snímky, remux). Pro KRESLENÍ osy se bere odhad z databáze — musí
// sedět s tím, co ukazuje osa dne. Pro PŘEHRÁVÁNÍ se offset ořezává
// skutečnou délkou videa, jakmile ji prohlížeč zná; jinak by seek
// spadl za konec a video by se zaseklo.

export interface PlayableClip {
  id: string;
  /** Adresa do /api/media, ne podepsaná adresa úložiště. */
  src: string;
  /** Absolutní začátek, ms. */
  startsAt: number;
  /**
   * Absolutní konec podle databáze, ms. U záznamu bez `ended_at` je
   * shodný se začátkem — délku neznáme a tvrdit ji by lhalo.
   */
  endsAt: number;
  /** Délka podle databáze, s. null = neznámá. */
  durationSec: number | null;
  cameraName: string | null;
}

interface Row {
  id: string;
  started_at: string;
  ended_at: string | null;
  storage_path: string | null;
  uploaded_at: string | null;
  video_expired_at: string | null;
  cameras?: { name?: string | null } | null;
}

/**
 * Přehratelné soubory dne, seřazené od nejstaršího.
 *
 * Seznam v tabulce jde od nejnovějšího, protože tak se hledá poslední
 * dění. Přehrávání potřebuje opačné pořadí a nesmí se na to spolehnout
 * — proto se řadí tady, ne u volajícího.
 *
 * Co se přehrát nedá (nedorazilo, po lhůtě, bez cesty), se vynechá
 * úplně: v playlistu by to byla díra, na které se přehrávání zastaví.
 */
export function buildPlaylist(rows: readonly Row[]): PlayableClip[] {
  const out: PlayableClip[] = [];

  for (const row of rows) {
    if (recordingPlayback(row) !== "ready" || !row.storage_path) continue;

    const startsAt = new Date(row.started_at).getTime();
    if (!Number.isFinite(startsAt)) continue;

    const konec = row.ended_at ? new Date(row.ended_at).getTime() : Number.NaN;
    const endsAt = Number.isFinite(konec) && konec > startsAt ? konec : startsAt;
    const durationSec = endsAt > startsAt ? (endsAt - startsAt) / 1000 : null;

    out.push({
      id: row.id,
      src: recordingMediaHref(row.storage_path),
      startsAt,
      endsAt,
      durationSec,
      cameraName: row.cameras?.name ?? null,
    });
  }

  return out.sort((a, b) => a.startsAt - b.startsAt);
}

export interface Locate {
  index: number;
  /** Kam v souboru, ve vteřinách. */
  offsetSec: number;
  /**
   * Klik padl mimo záznam a musel se posunout na nejbližší.
   *
   * Přehrávač to ukazuje: bez toho vypadá skok o dvě hodiny jako vada,
   * ne jako „v tu dobu se nenatáčelo“.
   */
  snapped: boolean;
}

/**
 * Který soubor hraje v daný čas a kolik vteřin do něj.
 *
 * Mezery jsou u pohybového nahrávání pravidlo, ne výjimka, takže se
 * musí řešit výslovně:
 *
 *   uvnitř záznamu  → ten záznam, přesný offset
 *   v mezeře        → DALŠÍ záznam vpřed, od začátku
 *   za posledním    → poslední záznam, na jeho konci
 *
 * Vpřed schválně: kdo klikne do prázdna, čeká, že uvidí nejbližší
 * další dění — ne že ho to hodí zpátky do už viděného úseku.
 */
export function locateTime(
  clips: readonly PlayableClip[],
  timeMs: number,
): Locate | null {
  if (clips.length === 0) return null;

  for (let i = 0; i < clips.length; i += 1) {
    const clip = clips[i];
    // Konec je výlučný: na hranici dvou souborů patří čas tomu dalšímu.
    if (timeMs >= clip.startsAt && timeMs < clip.endsAt) {
      return { index: i, offsetSec: (timeMs - clip.startsAt) / 1000, snapped: false };
    }
    if (timeMs < clip.startsAt) {
      return { index: i, offsetSec: 0, snapped: true };
    }
  }

  const posledni = clips.length - 1;
  return {
    index: posledni,
    offsetSec: clips[posledni].durationSec ?? 0,
    snapped: true,
  };
}

/**
 * Index dalšího souboru, nebo null na konci dne.
 *
 * Mezera se přeskakuje — po dojetí souboru se navazuje hned dalším,
 * i když mezi nimi byly dvě hodiny ticha. Čas nad přehrávačem přitom
 * skočí, a to je správně: ukazuje skutečný čas záznamu, ne plynulou
 * osu, která by předstírala, že se natáčelo pořád.
 */
export function nextIndex(
  clips: readonly PlayableClip[],
  index: number,
): number | null {
  const dalsi = index + 1;
  return dalsi < clips.length ? dalsi : null;
}

/** Skutečný čas záznamu pro danou pozici v souboru. */
export function absoluteTime(clip: PlayableClip, currentTimeSec: number): number {
  const posun = Number.isFinite(currentTimeSec) ? Math.max(0, currentTimeSec) : 0;
  return clip.startsAt + posun * 1000;
}

/** Kde na ose leží daný čas, v procentech šířky dne. */
export function positionPercent(
  timeMs: number,
  range: { from: Date; to: Date },
): number | null {
  const zacatek = range.from.getTime();
  const delka = range.to.getTime() - zacatek;
  if (!Number.isFinite(delka) || delka <= 0) return null;
  if (timeMs < zacatek || timeMs > range.to.getTime()) return null;
  return ((timeMs - zacatek) / delka) * 100;
}

/** Opačný směr: kliknutí na ose na čas. */
export function timeAtPercent(
  percent: number,
  range: { from: Date; to: Date },
): number {
  const zacatek = range.from.getTime();
  const delka = range.to.getTime() - zacatek;
  const podil = Math.min(1, Math.max(0, percent / 100));
  return zacatek + podil * delka;
}

/**
 * Kolik kamer je v seznamu.
 *
 * Souvislé přehrávání dává smysl jen nad JEDNOU kamerou: dvě kamery
 * natáčejí týž čas současně, takže „co běželo ve tři“ nemá jednu
 * odpověď a segmenty na ose se překrývají. Přehrávač se podle toho
 * buď rozjede, nebo pošle uživatele vybrat kameru.
 */
export function cameraIds(rows: readonly { camera_id?: string }[]): string[] {
  return [...new Set(rows.map((row) => row.camera_id).filter(Boolean) as string[])];
}
