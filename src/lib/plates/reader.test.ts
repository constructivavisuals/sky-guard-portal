import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { parseReading } from "./reader.ts";

describe("parseReading", () => {
  it("čistý JSON projde", () => {
    assert.deepEqual(parseReading('{"plate":"1AB2345","confidence":0.93}'), {
      plate: "1AB2345",
      confidence: 0.93,
    });
  });

  it("JSON v markdown bloku taky", () => {
    assert.deepEqual(
      parseReading('```json\n{"plate":"1AB2345","confidence":0.9}\n```'),
      { plate: "1AB2345", confidence: 0.9 },
    );
  });

  it("značka se znormalizuje, i když ji model vrátí po svém", () => {
    // Prompt říká „bez mezer a pomlček“, ale spoléhat se na to nebudeme.
    assert.equal(parseReading('{"plate":"1ab 2345","confidence":0.9}')?.plate, "1AB2345");
  });

  it("nečitelná značka je regulérní výsledek, ne chyba", () => {
    assert.deepEqual(parseReading('{"plate":null,"confidence":0}'), {
      plate: null,
      confidence: null,
    });
  });

  it("prázdná značka se bere jako nepřečtená", () => {
    assert.deepEqual(parseReading('{"plate":"   ","confidence":0.8}'), {
      plate: null,
      confidence: null,
    });
  });

  it("jistota se ořezává do rozsahu 0–1", () => {
    assert.equal(parseReading('{"plate":"1AB2345","confidence":5}')?.confidence, 1);
    assert.equal(parseReading('{"plate":"1AB2345","confidence":-2}')?.confidence, 0);
  });

  it("chybějící jistota je null, ne nula", () => {
    // Nula by znamenala „přečetl jsem a vůbec si nejsem jistý“, což je
    // jiné tvrzení než „jistotu nevrátil“.
    assert.equal(parseReading('{"plate":"1AB2345"}')?.confidence, null);
    assert.equal(parseReading('{"plate":"1AB2345","confidence":"vysoká"}')?.confidence, null);
  });

  it("rozbitá odpověď vrací null", () => {
    assert.equal(parseReading("tohle není JSON"), null);
    assert.equal(parseReading(""), null);
    assert.equal(parseReading("[]"), null);
    assert.equal(parseReading("null"), null);
  });

  it("odpověď bez značky vrací nepřečteno, ne null", () => {
    assert.deepEqual(parseReading('{"confidence":0.5}'), {
      plate: null,
      confidence: null,
    });
  });
});
