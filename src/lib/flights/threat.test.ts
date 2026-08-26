import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  combineThreatReadings,
  parseThreatReading,
  THREAT_CONFIDENCE_MIN,
  type ThreatReading,
} from "./threat.ts";

function cteni(over: Partial<ThreatReading> = {}): ThreatReading {
  return { threat: false, note: null, confidence: 0.9, ...over };
}

describe("parseThreatReading", () => {
  it("přečte jistou kladnou odpověď", () => {
    const r = parseThreatReading(
      '{"threat": true, "note": "Muž u plotu", "confidence": 0.93}',
    );
    assert.deepEqual(r, { threat: true, note: "Muž u plotu", confidence: 0.93 });
  });

  it("přečte jistou zápornou odpověď", () => {
    const r = parseThreatReading('{"threat": false, "note": "Prázdný dvůr", "confidence": 0.88}');
    assert.equal(r?.threat, false);
  });

  it("pod prahem jistoty je výsledek null, ne false", () => {
    // Tohle je celý smysl prahu: „asi tam nikdo není“ se nesmí
    // zobrazit stejně jako „prošli jsme to a nikdo tam není“.
    const r = parseThreatReading('{"threat": false, "note": "Tma", "confidence": 0.4}');
    assert.equal(r?.threat, null);
    assert.equal(r?.confidence, 0.4);
  });

  it("pod prahem se zahazuje i kladná odpověď", () => {
    const r = parseThreatReading('{"threat": true, "note": "Možná stín", "confidence": 0.3}');
    assert.equal(r?.threat, null);
  });

  it("práh je včetně", () => {
    const r = parseThreatReading(
      `{"threat": true, "note": "x", "confidence": ${THREAT_CONFIDENCE_MIN}}`,
    );
    assert.equal(r?.threat, true);
  });

  it("chybějící jistota je totéž co nejistota", () => {
    const r = parseThreatReading('{"threat": true, "note": "Auto"}');
    assert.equal(r?.threat, null);
    assert.equal(r?.confidence, null);
  });

  it("jistota v uvozovkách se nebere", () => {
    // Model má vracet číslo. Řetězec je rozbitá odpověď, ne hodnota
    // k dopočítání.
    const r = parseThreatReading('{"threat": true, "confidence": "0.95", "note": "Auto"}');
    assert.equal(r?.confidence, null);
    assert.equal(r?.threat, null);
  });

  it("threat jiné než boolean je rozbitá odpověď", () => {
    assert.equal(parseThreatReading('{"threat": "ano", "confidence": 0.9}'), null);
    assert.equal(parseThreatReading('{"threat": 1, "confidence": 0.9}'), null);
    assert.equal(parseThreatReading('{"confidence": 0.9}'), null);
  });

  it("umí odpověď zabalenou v markdownu", () => {
    const r = parseThreatReading(
      '```json\n{"threat": true, "note": "Dodávka", "confidence": 0.8}\n```',
    );
    assert.equal(r?.threat, true);
  });

  it("jistota mimo rozsah se ořízne", () => {
    assert.equal(
      parseThreatReading('{"threat": true, "confidence": 4, "note": "x"}')?.confidence,
      1,
    );
    assert.equal(
      parseThreatReading('{"threat": true, "confidence": -2, "note": "x"}')?.confidence,
      0,
    );
  });

  it("nesmysl místo JSONu je null", () => {
    assert.equal(parseThreatReading("Na snímku vidím auto."), null);
    assert.equal(parseThreatReading(""), null);
    assert.equal(parseThreatReading("[]"), null);
    assert.equal(parseThreatReading("null"), null);
  });

  it("prázdná poznámka je null, ne prázdný řetězec", () => {
    const r = parseThreatReading('{"threat": false, "note": "   ", "confidence": 0.9}');
    assert.equal(r?.note, null);
  });
});

describe("combineThreatReadings", () => {
  it("jeden jistý nález potvrdí celý let", () => {
    // Dron obletí místo z různých úhlů; že člověk není vidět na
    // ostatních snímcích, o ničem nesvědčí.
    const v = combineThreatReadings([
      cteni(),
      cteni({ threat: true, note: "Osoba u haly" }),
      cteni(),
    ]);
    assert.equal(v.confirmed, true);
    assert.match(v.note, /1 z 3/);
    assert.match(v.note, /Osoba u haly/);
  });

  it("samé jisté nenálezy dají false", () => {
    const v = combineThreatReadings([cteni(), cteni(), cteni()]);
    assert.equal(v.confirmed, false);
    assert.match(v.note, /3 snímcích/);
  });

  it("jediný nejistý snímek shodí závěr na null", () => {
    // Nepřečtený snímek je přesně to místo, kde ten člověk může být.
    const v = combineThreatReadings([cteni(), cteni(), cteni({ threat: null })]);
    assert.equal(v.confirmed, null);
    assert.match(v.note, /nepodařilo/);
  });

  it("přeskočené snímky se počítají jako nejisté", () => {
    const v = combineThreatReadings([cteni()], { skipped: 2 });
    assert.equal(v.confirmed, null);
    assert.match(v.note, /2/);
  });

  it("nález přebíjí i přeskočené snímky", () => {
    const v = combineThreatReadings([cteni({ threat: true })], { skipped: 5 });
    assert.equal(v.confirmed, true);
  });

  it("žádné snímky nedají žádné tvrzení", () => {
    const v = combineThreatReadings([]);
    assert.equal(v.confirmed, null);
    assert.match(v.note, /žádné fotky/);
  });

  it("samé nejisté snímky nejsou 'nic tam není'", () => {
    const v = combineThreatReadings([cteni({ threat: null }), cteni({ threat: null })]);
    assert.equal(v.confirmed, null);
    assert.match(v.note, /spolehlivě/);
  });
});
