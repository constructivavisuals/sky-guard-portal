import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { najdiFourcc, prepisFourcc } from "./mp4.ts";

/**
 * Kousek MP4 s boxem stsd a jednou položkou.
 *
 * Rozvržení (od začátku vzorku, bez předsazení):
 *   0   velikost boxu
 *   4   „stsd“
 *   8   verze + příznaky
 *   12  počet položek
 *   16  velikost položky
 *   20  čtyřznakový kód   ← sem míří najdiFourcc
 */
function vzorek(kod: string, predsazene = ""): Buffer {
  return Buffer.concat([
    Buffer.from(predsazene, "latin1"),
    Buffer.from([0, 0, 0, 40]), // velikost stsd
    Buffer.from("stsd", "latin1"),
    Buffer.from([0, 0, 0, 0]), // verze + příznaky
    Buffer.from([0, 0, 0, 1]), // počet položek
    Buffer.from([0, 0, 0, 24]), // velikost položky
    Buffer.from(kod, "latin1"),
    Buffer.alloc(16),
  ]);
}

describe("najdiFourcc", () => {
  it("přečte kód z popisu vzorků", () => {
    assert.deepEqual(najdiFourcc(vzorek("hvc1")), { offset: 20, kod: "hvc1" });
  });

  it("posun v souboru nevadí", () => {
    const nalez = najdiFourcc(vzorek("hev1", "x".repeat(100)));
    assert.equal(nalez?.kod, "hev1");
    assert.equal(nalez?.offset, 120);
  });

  it("NEplete si to s výskytem v datech obrazu", () => {
    // Přepsat `hvc1` kdekoli jinde než v popisu vzorků soubor rozbije
    // a poznalo by se to až při přehrávání.
    const nalez = najdiFourcc(vzorek("hev1", "hvc1 nekde v datech "));
    assert.equal(nalez?.kod, "hev1");
    assert.notEqual(nalez?.offset, 0);
  });

  it("bez stsd vrátí null, ne nesmysl", () => {
    assert.equal(najdiFourcc(Buffer.from("tady zadny box neni")), null);
  });

  it("useknutá hlavička vrátí null", () => {
    const orezany = vzorek("hvc1").subarray(0, 18);
    assert.equal(najdiFourcc(orezany), null);
  });
});

describe("prepisFourcc", () => {
  it("přepíše jen ty čtyři bajty", () => {
    const buf = vzorek("hvc1");
    const puvodni = Buffer.from(buf);
    prepisFourcc(buf, najdiFourcc(buf)!, "hev1");

    assert.equal(najdiFourcc(buf)?.kod, "hev1");
    assert.equal(buf.length, puvodni.length);
    // Všechno kolem zůstalo netknuté.
    assert.deepEqual(buf.subarray(0, 20), puvodni.subarray(0, 20));
    assert.deepEqual(buf.subarray(24), puvodni.subarray(24));
  });

  it("jiná délka než čtyři znaky se odmítne", () => {
    const buf = vzorek("hvc1");
    const nalez = najdiFourcc(buf)!;
    assert.throws(() => prepisFourcc(buf, nalez, "hev"), /4 znaky/);
    assert.throws(() => prepisFourcc(buf, nalez, "hevc1"), /4 znaky/);
  });
});
