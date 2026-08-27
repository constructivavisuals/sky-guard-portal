import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  baseLevelFor,
  conditionsFromReason,
  explainLevel,
  levelFromReason,
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

describe("levelFromReason — z uloženého rozhodnutí", () => {
  const base = {
    object_class: "vehicle" as const,
    base_level: 2,
    level_sent: 2,
    escalated: false,
    escalation: null,
    armed: true,
    zone_enabled: true,
    cooldown_seconds: 900,
    seconds_since_last_sent: null,
    cooldown_remaining_seconds: null,
    decided_at: "2026-08-25T10:00:00Z",
  };

  it("bez eskalace vysvětlí stupeň třídou objektu", () => {
    const e = levelFromReason(base);
    assert.equal(e.escalated, false);
    assert.match(e.text, /vozidlo/i);
  });

  it("s eskalací uvede okno ze zápisu, ne z dnešní konstanty", () => {
    const e = levelFromReason({
      ...base,
      level_sent: 5,
      escalated: true,
      escalation: { reason: "person_in_other_zone", window_seconds: 45 },
    });
    assert.equal(e.escalated, true);
    assert.match(e.text, /45 s/);
  });

  it("ruční zásah bez třídy objektu se nezkomolí", () => {
    const e = levelFromReason({ ...base, object_class: null, level_sent: 3 });
    assert.equal(e.text.includes("undefined"), false);
    assert.match(e.text, /ručně/);
  });

  it("zásah z tlačítka se pozná podle zápisu, ne podle chybějící třídy", () => {
    // Bez příznaku manual by se choval jako výš: „stupeň zadaný ručně“
    // zní, jako by číslo někdo napsal do formuláře.
    const e = levelFromReason({
      ...base,
      object_class: null,
      base_level: 5,
      level_sent: 5,
      manual: { actor_id: "profil-1" },
    });
    assert.equal(e.escalated, false);
    assert.match(e.text, /ruční zásah z portálu/i);
  });
});

describe("conditionsFromReason", () => {
  const base = {
    object_class: "person" as const,
    base_level: 5,
    level_sent: 5,
    escalated: false,
    escalation: null,
    armed: true,
    zone_enabled: true,
    cooldown_seconds: 900,
    seconds_since_last_sent: 1200,
    cooldown_remaining_seconds: 0,
    decided_at: "2026-08-25T10:00:00Z",
  };

  it("ostrý režim a vyčerpaný cooldown", () => {
    const c = conditionsFromReason(base);
    assert.match(c.join(" "), /ostrém režimu/);
    assert.match(c.join(" "), /vyčerpaný/);
  });

  it("mimo režim se pozná", () => {
    assert.match(conditionsFromReason({ ...base, armed: false }).join(" "), /nestřežila/);
  });

  it("vypnutá zóna se zmíní zvlášť", () => {
    assert.match(
      conditionsFromReason({ ...base, zone_enabled: false }).join(" "),
      /[Zz]óna byla vypnutá/,
    );
  });

  it("běžící cooldown uvede, kolik zbývalo", () => {
    const c = conditionsFromReason({
      ...base,
      seconds_since_last_sent: 300,
      cooldown_remaining_seconds: 600,
    });
    assert.match(c.join(" "), /zbývalo 600 s/);
  });

  it("první zásah na lokalitě se nevydává za cooldown", () => {
    const c = conditionsFromReason({
      ...base,
      seconds_since_last_sent: null,
      cooldown_remaining_seconds: null,
    });
    assert.match(c.join(" "), /žádný zásah neodešel/);
  });
});

describe("levelFromReason — spodní hranice zóny", () => {
  const base = {
    object_class: "unknown" as const,
    base_level: 1,
    level_sent: 3,
    escalated: false,
    escalation: null,
    armed: true,
    zone_enabled: true,
    cooldown_seconds: 900,
    seconds_since_last_sent: null,
    cooldown_remaining_seconds: null,
    decided_at: "2026-08-25T10:00:00Z",
  };

  it("řekne, že stupeň zvedlo nastavení zóny", () => {
    const e = levelFromReason({
      ...base,
      zone_default_level: 3,
      zone_floor_applied: true,
    });
    assert.match(e.text, /spodní hranici 3/);
    assert.match(e.text, /neurčeno/i);
  });

  it("mlčí o hranici, která nic nezvedla", () => {
    // Věta o nastavení, které neudělalo nic, by přibyla u každého zásahu.
    const e = levelFromReason({
      ...base,
      level_sent: 1,
      zone_default_level: 1,
      zone_floor_applied: false,
    });
    assert.equal(/hranic/i.test(e.text), false);
  });

  it("u zásahu z doby před hranicí se nic nedomýšlí", () => {
    const e = levelFromReason({ ...base, level_sent: 1 });
    assert.equal(/hranic/i.test(e.text), false);
  });
});

describe("conditionsFromReason — výška návratu", () => {
  const base = {
    object_class: "person" as const,
    base_level: 5,
    level_sent: 5,
    escalated: false,
    escalation: null,
    armed: true,
    zone_enabled: true,
    cooldown_seconds: 900,
    seconds_since_last_sent: null,
    cooldown_remaining_seconds: null,
    decided_at: "2026-08-27T22:00:00Z",
  };

  it("zapsaná výška se vypíše", () => {
    // Když mise nevzlétne, je to první otázka — a strop projektu ve
    // FlightHubu není nikde v portálu vidět.
    const radky = conditionsFromReason({ ...base, rth_altitude_m: 60 });
    assert.ok(radky.some((r) => /60 m/.test(r)));
  });

  it("u zásahu z doby před sloupcem se nic nedomýšlí", () => {
    const radky = conditionsFromReason(base);
    assert.equal(radky.some((r) => /Výška návratu/.test(r)), false);
  });
});
