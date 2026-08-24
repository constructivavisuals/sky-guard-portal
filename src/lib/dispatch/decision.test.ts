// Testy rozhodovací logiky výjezdu — ostrý režim, cooldown, eskalace
// stupně. Bez databáze i bez FlightHubu, protože decision.ts je čistý.

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  PERSON_ESCALATION_WINDOW_SECONDS,
  decideDispatch,
  resolveDispatchLevel,
  type DispatchDecisionInput,
} from "./decision.ts";

const AT = new Date("2026-08-24T22:00:00Z");

function input(overrides: Partial<DispatchDecisionInput> = {}): DispatchDecisionInput {
  return {
    armed: true,
    cooldownSeconds: 900,
    lastSentAt: null,
    at: AT,
    ...overrides,
  };
}

/** Čas o `seconds` dřív než AT. */
function secondsBefore(seconds: number): Date {
  return new Date(AT.getTime() - seconds * 1_000);
}

describe("decideDispatch — ostrý režim", () => {
  it("mimo ostrý režim se výjezd potlačí", () => {
    assert.deepEqual(decideDispatch(input({ armed: false })), {
      send: false,
      outcome: "suppressed_disarmed",
    });
  });

  it("v ostrém režimu bez předchozího výjezdu se odesílá", () => {
    assert.deepEqual(decideDispatch(input()), { send: true });
  });

  it("ostrý režim má přednost před cooldownem", () => {
    // Obě podmínky platí naráz — důvodem musí být ten hlavní, aby
    // v dispatches nestálo 'cooldown' u lokality, která vůbec nehlídá.
    const decision = decideDispatch(
      input({ armed: false, lastSentAt: secondsBefore(10) }),
    );
    assert.deepEqual(decision, { send: false, outcome: "suppressed_disarmed" });
  });
});

describe("decideDispatch — cooldown", () => {
  it("výjezd v cooldownu se potlačí", () => {
    const decision = decideDispatch(
      input({ lastSentAt: secondsBefore(300), cooldownSeconds: 900 }),
    );
    assert.deepEqual(decision, { send: false, outcome: "suppressed_cooldown" });
  });

  it("po uplynutí cooldownu se odesílá", () => {
    const decision = decideDispatch(
      input({ lastSentAt: secondsBefore(901), cooldownSeconds: 900 }),
    );
    assert.deepEqual(decision, { send: true });
  });

  it("přesně na hranici cooldownu se už odesílá", () => {
    const decision = decideDispatch(
      input({ lastSentAt: secondsBefore(900), cooldownSeconds: 900 }),
    );
    assert.deepEqual(decision, { send: true });
  });

  it("o sekundu dřív než hranice se ještě potlačí", () => {
    const decision = decideDispatch(
      input({ lastSentAt: secondsBefore(899), cooldownSeconds: 900 }),
    );
    assert.deepEqual(decision, { send: false, outcome: "suppressed_cooldown" });
  });

  it("cooldown 0 nikdy nepotlačí", () => {
    const decision = decideDispatch(
      input({ lastSentAt: AT, cooldownSeconds: 0 }),
    );
    assert.deepEqual(decision, { send: true });
  });

  it("výjezd s časem v budoucnu cooldown neaktivuje", () => {
    // Rozjeté hodiny na kameře nesmí zablokovat další výjezdy —
    // záporný uplynulý čas je menší než cooldown, takže by potlačil.
    const decision = decideDispatch(
      input({ lastSentAt: new Date(AT.getTime() + 60_000) }),
    );
    assert.deepEqual(decision, { send: false, outcome: "suppressed_cooldown" });
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
  it("potlačený výjezd si stupeň spočítá stejně", () => {
    // Stupeň se ukládá i u potlačeného výjezdu — v dispatches pak jde
    // dohledat, jak vážná situace se nevyjela.
    const level = resolveDispatchLevel("person", false);
    const decision = decideDispatch(input({ armed: false }));
    assert.equal(level, 5);
    assert.equal(decision.send, false);
  });
});
