import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  baseLevelFor,
  explainLevel,
  explainOutcome,
  mapUrl,
  wasEscalated,
} from "./explain.ts";

describe("baseLevelFor a wasEscalated", () => {
  it("základní stupně odpovídají pravidlům rozhodování", () => {
    assert.equal(baseLevelFor("person"), 5);
    assert.equal(baseLevelFor("vehicle"), 2);
    assert.equal(baseLevelFor("unknown"), 1);
  });

  it("vozidlo na stupni 5 je eskalace", () => {
    assert.equal(wasEscalated("vehicle", 5), true);
  });

  it("neurčený objekt na stupni 1 eskalace není", () => {
    assert.equal(wasEscalated("unknown", 1), false);
  });

  it("osoba na stupni 5 eskalace není — je to její základ", () => {
    assert.equal(wasEscalated("person", 5), false);
  });
});

describe("explainLevel", () => {
  it("bez eskalace vysvětlí stupeň třídou objektu", () => {
    const e = explainLevel("vehicle", 2);
    assert.equal(e.escalated, false);
    assert.equal(e.base, 2);
    assert.match(e.text, /vozidlo/i);
  });

  it("s eskalací zmíní pohyb v okolních zónách", () => {
    const e = explainLevel("unknown", 5);
    assert.equal(e.escalated, true);
    assert.equal(e.base, 1);
    assert.match(e.text, /osoba/i);
  });

  it("ruční zásah bez detekce se netváří, že něco odvodil", () => {
    const e = explainLevel(null, 3);
    assert.equal(e.escalated, false);
    assert.match(e.text, /ručně/i);
  });
});

describe("explainOutcome", () => {
  it("potlačení mimo režim uvede nastavené okno", () => {
    const e = explainOutcome("suppressed_disarmed", {
      armedWindow: "18:00–06:00",
      armedDays: "Po–Pá",
    });
    assert.equal(e.tone, "warning");
    assert.match(e.text, /18:00–06:00/);
    assert.match(e.text, /Po–Pá/);
  });

  it("bez znalosti okna hlášku nezkomolí", () => {
    const e = explainOutcome("suppressed_disarmed", {});
    assert.match(e.text, /nestřežila/);
    assert.equal(e.text.includes("undefined"), false);
  });

  it("cooldown uvede počet sekund", () => {
    const e = explainOutcome("suppressed_cooldown", { cooldownSeconds: 900 });
    assert.match(e.text, /900/);
  });

  it("cooldown 0 se nevydává za chybějící hodnotu", () => {
    const e = explainOutcome("suppressed_cooldown", { cooldownSeconds: 0 });
    assert.match(e.text, /0 s/);
  });

  it("selhání zdůrazní, že detekce zůstala", () => {
    const e = explainOutcome("failed", {});
    assert.equal(e.tone, "danger");
    assert.match(e.text, /[Dd]etekce/);
  });

  it("odeslaný zásah je zelený", () => {
    assert.equal(explainOutcome("sent", {}).tone, "success");
  });
});

describe("mapUrl", () => {
  it("pořadí je délka, šířka — ne naopak", () => {
    const url = mapUrl(50.0755, 14.4378);
    assert.match(url, /id=14\.4378,50\.0755/);
    assert.match(url, /x=14\.4378/);
    assert.match(url, /y=50\.0755/);
  });

  it("záporné souřadnice projdou", () => {
    assert.match(mapUrl(-33.86, -70.66), /id=-70\.66,-33\.86/);
  });
});
