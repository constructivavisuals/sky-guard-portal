import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { currentMonth, monthPeriod, parseMonth } from "./data.ts";

const PRAHA = "Europe/Prague";

describe("parseMonth", () => {
  it("bere jen YYYY-MM", () => {
    assert.equal(parseMonth("2026-08"), "2026-08");
    assert.equal(parseMonth("2026-8"), null);
    assert.equal(parseMonth("2026-08-01"), null);
    assert.equal(parseMonth("srpen"), null);
    assert.equal(parseMonth(null), null);
    assert.equal(parseMonth(""), null);
  });

  it("odmítá nesmyslný měsíc", () => {
    assert.equal(parseMonth("2026-00"), null);
    assert.equal(parseMonth("2026-13"), null);
  });

  it("odmítá roky mimo rozumný rozsah", () => {
    // Report za rok 1900 by jen zbytečně projel celou tabulku.
    assert.equal(parseMonth("1900-05"), null);
    assert.equal(parseMonth("2999-05"), null);
  });
});

describe("monthPeriod", () => {
  it("hranice se počítají v pásmu lokality, ne v UTC", () => {
    // Srpen v Praze začíná 31. 7. ve 22:00 UTC (letní čas, UTC+2).
    const p = monthPeriod("2026-08", PRAHA);
    assert.equal(p.from.toISOString(), "2026-07-31T22:00:00.000Z");
    assert.equal(p.to.toISOString(), "2026-08-31T22:00:00.000Z");
  });

  it("v zimě je posun jiný", () => {
    // Leden je UTC+1, takže hranice je v 23:00.
    const p = monthPeriod("2026-01", PRAHA);
    assert.equal(p.from.toISOString(), "2025-12-31T23:00:00.000Z");
  });

  it("prosinec přetéká do dalšího roku", () => {
    const p = monthPeriod("2026-12", PRAHA);
    assert.equal(p.to.toISOString(), "2026-12-31T23:00:00.000Z");
  });

  it("délka měsíce sedí včetně přestupného února", () => {
    assert.equal(monthPeriod("2026-02", PRAHA).days, 28);
    assert.equal(monthPeriod("2028-02", PRAHA).days, 29);
    assert.equal(monthPeriod("2026-04", PRAHA).days, 30);
    assert.equal(monthPeriod("2026-08", PRAHA).days, 31);
  });

  it("popisek je česky", () => {
    assert.equal(monthPeriod("2026-08", PRAHA).label, "srpen 2026");
    assert.equal(monthPeriod("2026-01", PRAHA).label, "leden 2026");
    assert.equal(monthPeriod("2026-12", PRAHA).label, "prosinec 2026");
  });

  it("okno měsíce na sebe navazuje bez díry", () => {
    // Konec srpna musí být přesně začátek září, jinak by detekce
    // z půlnoci vypadly z obou reportů.
    assert.equal(
      monthPeriod("2026-08", PRAHA).to.toISOString(),
      monthPeriod("2026-09", PRAHA).from.toISOString(),
    );
  });
});

describe("currentMonth", () => {
  it("bere měsíc v pásmu lokality", () => {
    // 31. 8. ve 22:30 UTC je v Praze už 1. 9.
    assert.equal(
      currentMonth(PRAHA, new Date("2026-08-31T22:30:00Z")),
      "2026-09",
    );
    assert.equal(
      currentMonth(PRAHA, new Date("2026-08-31T21:30:00Z")),
      "2026-08",
    );
  });

  it("vrací tvar, který bere parseMonth", () => {
    assert.equal(parseMonth(currentMonth(PRAHA, new Date())), currentMonth(PRAHA, new Date()));
  });
});
