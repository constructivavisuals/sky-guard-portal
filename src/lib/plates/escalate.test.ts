import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { planPlateAction } from "./escalate.ts";
import type { ArrivalVerdict } from "../arrivals/rules.ts";

const OHLASENI = {
  id: "oh1",
  plate: "1AB 2345",
  arrival_date: "2026-08-26",
  night_ok: false,
  cancelled_at: null,
};

const KRYJE: ArrivalVerdict = { covered: true, arrival: OHLASENI, reason: "disarmed" };
const NEKRYJE: ArrivalVerdict = {
  covered: false,
  arrival: OHLASENI,
  reason: "night_not_allowed",
};
const ZADNE: ArrivalVerdict = { covered: false, arrival: null, reason: "no_match" };

describe("planPlateAction — bez ohlášení", () => {
  it("nežádoucí značka eskaluje", () => {
    assert.deepEqual(planPlateAction("deny", ZADNE), { action: "escalate" });
  });

  it("známá, neznámá ani nepřečtená značka nic nespouští", () => {
    // První zásah za VOZIDLO už dávno rozhodl sám a nečekal na značku.
    for (const verdict of ["allow", "unknown", "unread"] as const) {
      assert.deepEqual(planPlateAction(verdict, ZADNE), { action: "none" }, verdict);
    }
  });
});

describe("planPlateAction — ohlášení kryje", () => {
  it("nežádoucí značka se zapíše jako potlačená ohlášením", () => {
    // Ohlásit příjezd smí jen ten, komu administrátor dal odkaz —
    // takže ohlášení přebíjí i deny seznam.
    assert.deepEqual(planPlateAction("deny", KRYJE), { action: "announced_suppress" });
  });

  it("u ostatních značek se nic nezapisuje", () => {
    // Řádek „neodeslali jsme, co jsme stejně neposílali“ by z evidence
    // zásahů udělal seznam neudálostí.
    for (const verdict of ["allow", "unknown", "unread"] as const) {
      assert.deepEqual(planPlateAction(verdict, KRYJE), { action: "none" }, verdict);
    }
  });
});

describe("planPlateAction — ohlášení nekryje", () => {
  it("denní ohlášení v noci nezastaví eskalaci", () => {
    // Ohlásit denní rozvoz nesmí být zadní vrátka na noc.
    assert.deepEqual(planPlateAction("deny", NEKRYJE), { action: "escalate" });
  });

  it("a u ostatních značek se chová jako bez ohlášení", () => {
    assert.deepEqual(planPlateAction("unknown", NEKRYJE), { action: "none" });
  });
});
