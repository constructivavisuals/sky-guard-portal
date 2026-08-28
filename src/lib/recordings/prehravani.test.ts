import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createPlaybackGate, type MediaLike } from "./prehravani.ts";

/**
 * Atrapa `<video>`, která se chová jako prohlížeč.
 *
 * Podstatné je jediné: `play()` se splní až tehdy, když se obraz
 * rozjede, a `pause()` do té doby to volání ZRUŠÍ odmítnutím
 * s AbortError. Přesně tohle dělá prohlížeč a přesně tohle nám padalo
 * do konzole.
 */
function atrapa() {
  let splnit: (() => void) | null = null;
  let odmitnout: ((chyba: Error) => void) | null = null;

  const prvek = {
    paused: true,
    playCalls: 0,
    pauseCalls: 0,

    play() {
      this.playCalls += 1;
      this.paused = false;
      return new Promise<void>((res, rej) => {
        splnit = res;
        odmitnout = rej;
      });
    },

    pause() {
      this.pauseCalls += 1;
      this.paused = true;
      // Rozehrané play() se ruší — jako v prohlížeči.
      if (odmitnout) {
        const chyba = new Error(
          "The play() request was interrupted by a call to pause()",
        );
        chyba.name = "AbortError";
        odmitnout(chyba);
        odmitnout = null;
        splnit = null;
      }
    },

    /** Obraz se rozjel. */
    rozjeloSe() {
      splnit?.();
      splnit = null;
      odmitnout = null;
    },

    /** Přehrávání skončilo chybou daného druhu. */
    selhalo(jmeno: string) {
      const chyba = new Error(`play() selhalo: ${jmeno}`);
      chyba.name = jmeno;
      odmitnout?.(chyba);
      odmitnout = null;
      splnit = null;
      this.paused = true;
    },

    /** Prohlížeč přehrávání zakázal (chybí gesto uživatele). */
    zakazano() {
      this.selhalo("NotAllowedError");
    },
  };

  return prvek as typeof prvek & MediaLike;
}

describe("createPlaybackGate", () => {
  it("rozehrané přehrávání dojde do konce", async () => {
    const gate = createPlaybackGate();
    const video = atrapa();

    const beh = gate.pustit(0, video);
    video.rozjeloSe();

    assert.equal(await beh, "hraje");
    assert.equal(video.playCalls, 1);
  });

  it("zrušené play() se ZAHODÍ, nevybublá", async () => {
    // Bez tohohle je v konzoli „Uncaught (in promise) AbortError“ při
    // každé hranici souboru.
    const gate = createPlaybackGate();
    const video = atrapa();

    const beh = gate.pustit(0, video);
    video.pause();

    assert.equal(await beh, "preruseno");
  });

  it("zastavit() POČKÁ na rozehrané play(), takže ho nezruší", async () => {
    // Tohle je jádro opravy. Bez čekání se obě volání vyruší a obraz
    // zůstane stát — „po kliknutí na play se nestane nic“.
    const gate = createPlaybackGate();
    const video = atrapa();

    const beh = gate.pustit(0, video);
    const stop = gate.zastavit(0, video);

    // Dokud se přehrávání nerozjelo, pause() se nesmí stát.
    await Promise.resolve();
    assert.equal(video.pauseCalls, 0, "pause() přišel doprostřed play()");

    video.rozjeloSe();

    assert.equal(await beh, "hraje");
    await stop;
    assert.equal(video.pauseCalls, 1);
    assert.equal(video.paused, true);
  });

  it("zastavení bez rozehraného play() nečeká na nic", async () => {
    const gate = createPlaybackGate();
    const video = atrapa();

    await gate.zastavit(0, video);
    assert.equal(video.pauseCalls, 1);
  });

  it("prvky se drží zvlášť — play na jednom nečeká na druhý", async () => {
    // Dva <video> se u souvislého přehrávání střídají. Kdyby se jejich
    // rozehraná volání pletla, zastavení dojetého souboru by zdrželo
    // rozjezd toho dalšího a na hranici by byla pauza.
    const gate = createPlaybackGate();
    const prvni = atrapa();
    const druhy = atrapa();

    const behPrvni = gate.pustit(0, prvni);
    const behDruhy = gate.pustit(1, druhy);

    druhy.rozjeloSe();
    assert.equal(await behDruhy, "hraje");
    // První pořád visí, druhý je hotový.
    assert.notEqual(gate.rozehrane(0), null);
    assert.equal(gate.rozehrane(1), null);

    prvni.rozjeloSe();
    assert.equal(await behPrvni, "hraje");
  });

  it("zakázané přehrávání se odliší od zrušeného", async () => {
    // Zrušené je důsledek toho, že divák udělal něco jiného. Zakázané
    // znamená, že se bez kliknutí nerozjede nic — a to musí být vidět
    // na tlačítku, ne jen v tichu.
    const gate = createPlaybackGate();
    const video = atrapa();

    const beh = gate.pustit(0, video);
    video.zakazano();

    assert.equal(await beh, "zakazano");
  });

  it("neznámá chyba se nezamete pod koberec", async () => {
    // Zrušení a zákaz jsou očekávané stavy. Cokoli jiného — třeba
    // formát, který dekodér nevezme — se nesmí ztratit v téže větvi,
    // jinak vypadá vadný soubor jako „divák udělal něco jiného“.
    const gate = createPlaybackGate();
    const video = atrapa();

    const beh = gate.pustit(0, video);
    video.selhalo("NotSupportedError");

    assert.equal(await beh, "chyba");
  });

  it("chybějící prvek nespadne", async () => {
    const gate = createPlaybackGate();
    assert.equal(await gate.pustit(0, null), "chyba");
    await gate.zastavit(0, null);
  });

  it("prohlížeč bez Promise z play() se bere jako rozjetý", async () => {
    // Starší prohlížeče vracejí undefined. Není na co čekat a není co
    // rušit.
    const gate = createPlaybackGate();
    const stary: MediaLike = {
      paused: true,
      play: () => undefined,
      pause: () => {},
    };
    assert.equal(await gate.pustit(0, stary), "hraje");
    assert.equal(gate.rozehrane(0), null);
  });
});
