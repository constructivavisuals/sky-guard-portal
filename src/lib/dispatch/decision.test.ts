// Testy rozhodovací logiky zásahu — ostrý režim, cooldown, eskalace
// stupně. Bez databáze i bez FlightHubu, protože decision.ts je čistý.

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  PERSON_ESCALATION_WINDOW_SECONDS,
  applyZoneFloor,
  decideDispatch,
  resolveDispatchLevel,
  type DispatchDecisionInput,
} from "./decision.ts";

const AT = new Date("2026-08-24T22:00:00Z");

function input(overrides: Partial<DispatchDecisionInput> = {}): DispatchDecisionInput {
  return {
    armed: true,
    cooldownSeconds: 900,
    lastSent: { known: true, at: null },
    at: AT,
    ...overrides,
  };
}

/** Čas o `seconds` dřív než AT. */
function secondsBefore(seconds: number): Date {
  return new Date(AT.getTime() - seconds * 1_000);
}

describe("decideDispatch — ostrý režim", () => {
  it("mimo ostrý režim se zásah potlačí", () => {
    assert.deepEqual(decideDispatch(input({ armed: false })), {
      send: false,
      outcome: "suppressed_disarmed",
      cause: "disarmed",
    });
  });

  it("v ostrém režimu bez předchozího zásahu se odesílá", () => {
    assert.deepEqual(decideDispatch(input()), { send: true });
  });

  it("ostrý režim má přednost před cooldownem", () => {
    // Obě podmínky platí naráz — důvodem musí být ten hlavní, aby
    // v dispatches nestálo 'cooldown' u lokality, která vůbec nehlídá.
    const decision = decideDispatch(
      input({ armed: false, lastSent: { known: true, at: secondsBefore(10) } }),
    );
    assert.deepEqual(decision, { send: false, outcome: "suppressed_disarmed", cause: "disarmed" });
  });
});

describe("decideDispatch — cooldown", () => {
  it("zásah v cooldownu se potlačí", () => {
    const decision = decideDispatch(
      input({ lastSent: { known: true, at: secondsBefore(300) }, cooldownSeconds: 900 }),
    );
    assert.deepEqual(decision, { send: false, outcome: "suppressed_cooldown", cause: "cooldown" });
  });

  it("po uplynutí cooldownu se odesílá", () => {
    const decision = decideDispatch(
      input({ lastSent: { known: true, at: secondsBefore(901) }, cooldownSeconds: 900 }),
    );
    assert.deepEqual(decision, { send: true });
  });

  it("přesně na hranici cooldownu se už odesílá", () => {
    const decision = decideDispatch(
      input({ lastSent: { known: true, at: secondsBefore(900) }, cooldownSeconds: 900 }),
    );
    assert.deepEqual(decision, { send: true });
  });

  it("o sekundu dřív než hranice se ještě potlačí", () => {
    const decision = decideDispatch(
      input({ lastSent: { known: true, at: secondsBefore(899) }, cooldownSeconds: 900 }),
    );
    assert.deepEqual(decision, { send: false, outcome: "suppressed_cooldown", cause: "cooldown" });
  });

  it("cooldown 0 nikdy nepotlačí", () => {
    const decision = decideDispatch(
      input({ lastSent: { known: true, at: AT }, cooldownSeconds: 0 }),
    );
    assert.deepEqual(decision, { send: true });
  });

  it("zásah s časem v budoucnu cooldown neaktivuje", () => {
    // Rozjeté hodiny na kameře nesmí zablokovat další zásahy —
    // záporný uplynulý čas je menší než cooldown, takže by potlačil.
    const decision = decideDispatch(
      input({ lastSent: { known: true, at: new Date(AT.getTime() + 60_000) } }),
    );
    assert.deepEqual(decision, { send: false, outcome: "suppressed_cooldown", cause: "cooldown" });
  });
});

describe("resolveDispatchLevel — základní stupně", () => {
  it("osoba jede na 5", () => {
    assert.equal(resolveDispatchLevel("person", false), 5);
  });

  it("vozidlo jede na 2", () => {
    assert.equal(resolveDispatchLevel("vehicle", false), 2);
  });

  it("neurčený objekt jede na 1", () => {
    assert.equal(resolveDispatchLevel("unknown", false), 1);
  });
});

describe("resolveDispatchLevel — eskalace podle jiné zóny", () => {
  it("vozidlo eskaluje na 5, když byla osoba v jiné zóně", () => {
    assert.equal(resolveDispatchLevel("vehicle", true), 5);
  });

  it("neurčený objekt eskaluje na 5", () => {
    assert.equal(resolveDispatchLevel("unknown", true), 5);
  });

  it("osoba zůstává na 5, eskalace ji nepřebíjí", () => {
    assert.equal(resolveDispatchLevel("person", true), 5);
  });

  it("okno eskalace je 60 s", () => {
    assert.equal(PERSON_ESCALATION_WINDOW_SECONDS, 60);
  });
});

describe("rozhodnutí a stupeň jsou nezávislé", () => {
  it("potlačený zásah si stupeň spočítá stejně", () => {
    // Stupeň se ukládá i u potlačeného zásahu — v dispatches pak jde
    // dohledat, jak vážná situace se nevyjela.
    const level = resolveDispatchLevel("person", false);
    const decision = decideDispatch(input({ armed: false }));
    assert.equal(level, 5);
    assert.equal(decision.send, false);
  });
});

describe("decideDispatch — nezjištěné vstupy", () => {
  it("neznámý režim střežení není „nestřeží“", () => {
    // Dřív se z chyby dotazu stalo suppressed_disarmed a detail zásahu
    // pak tvrdil o areálu něco, co se nikdy nezjišťovalo.
    const decision = decideDispatch(input({ armed: null }));
    assert.deepEqual(decision, {
      send: false,
      outcome: "suppressed_unknown",
      cause: "armed_unknown",
    });
  });

  it("nezjištěný cooldown zásah zastaví (fail-closed)", () => {
    // Bez něj nevíme, jestli dron nevzlétl před minutou. Duplicitní
    // zásah znamená vyčerpanou baterii pro to, co přijde potom.
    const decision = decideDispatch(input({ lastSent: { known: false, at: null } }));
    assert.deepEqual(decision, {
      send: false,
      outcome: "suppressed_unknown",
      cause: "cooldown_unknown",
    });
  });

  it("neznámý režim má přednost před neznámým cooldownem", () => {
    const decision = decideDispatch(
      input({ armed: null, lastSent: { known: false, at: null } }),
    );
    assert.equal(decision.send === false && decision.cause, "armed_unknown");
  });

  it("mimo režim se cooldown neřeší, ani když je neznámý", () => {
    const decision = decideDispatch(
      input({ armed: false, lastSent: { known: false, at: null } }),
    );
    assert.equal(decision.send === false && decision.cause, "disarmed");
  });

  it("neznámá eskalace zásah NEZASTAVÍ", () => {
    // Fail-open: nižší stupeň je pořád zásah. Eskalace do rozhodnutí
    // o odeslání vůbec nevstupuje, jen do stupně.
    assert.deepEqual(decideDispatch(input()), { send: true });
    assert.equal(resolveDispatchLevel("person", null), 5);
    assert.equal(resolveDispatchLevel("vehicle", null), 2);
  });

  it("neznámá eskalace nezvedne stupeň vozidla", () => {
    // Kdyby null propadlo jako pravda, vozidlo by jelo na pětce.
    assert.equal(resolveDispatchLevel("vehicle", null), 2);
    assert.equal(resolveDispatchLevel("vehicle", true), 5);
    assert.equal(resolveDispatchLevel("vehicle", false), 2);
  });
});

describe("applyZoneFloor — spodní hranice zóny", () => {
  it("zvedne nižší stupeň na hranici zóny", () => {
    // Neznámý objekt u hlavní brány není totéž co neznámý objekt na
    // kraji pozemku, i když detektor vidí v obou případech totéž.
    assert.equal(applyZoneFloor(1, 3), 3);
  });

  it("vyšší stupeň nesnižuje", () => {
    // Eskalace na 5 musí projít i ze zóny s hranicí 2.
    assert.equal(applyZoneFloor(5, 2), 5);
  });

  it("hranice 1 nemění nic", () => {
    assert.equal(applyZoneFloor(2, 1), 2);
  });

  it("nezjištěná hranice se ignoruje", () => {
    assert.equal(applyZoneFloor(2, null), 2);
  });

  it("hodnota mimo rozsah se ignoruje, netvrdí se nic", () => {
    // Poškozený řádek nesmí poslat zásah na stupeň, který schéma
    // nepřipouští.
    for (const nesmysl of [0, -3, 6, 99, 2.5, Number.NaN]) {
      assert.equal(applyZoneFloor(2, nesmysl), 2, String(nesmysl));
    }
  });
});
