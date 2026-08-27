import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  MIN_SEGMENT_PERCENT,
  dayRange,
  isDayString,
  isMonthString,
  monthGrid,
  monthOf,
  shiftMonth,
  timelineSegments,
} from "./timeline.ts";

const PRAHA = "Europe/Prague";

describe("isDayString", () => {
  it("bere jen skutečná data", () => {
    assert.equal(isDayString("2026-08-27"), true);
    assert.equal(isDayString("2026-02-29"), false); // 2026 není přestupný
    assert.equal(isDayString("2026-13-01"), false);
    assert.equal(isDayString("2026-8-7"), false);
    assert.equal(isDayString("včera"), false);
    assert.equal(isDayString(undefined), false);
  });

  it("přestupný rok projde", () => {
    assert.equal(isDayString("2028-02-29"), true);
  });
});

describe("isMonthString a shiftMonth", () => {
  it("tvar YYYY-MM", () => {
    assert.equal(isMonthString("2026-08"), true);
    assert.equal(isMonthString("2026-00"), false);
    assert.equal(isMonthString("2026-8"), false);
  });

  it("posun přes hranici roku", () => {
    assert.equal(shiftMonth("2026-01", -1), "2025-12");
    assert.equal(shiftMonth("2026-12", 1), "2027-01");
    assert.equal(shiftMonth("2026-08", 0), "2026-08");
  });

  it("měsíc ze dne", () => {
    assert.equal(monthOf("2026-08-27"), "2026-08");
  });
});

describe("dayRange", () => {
  it("běžný den je 24 hodin od místní půlnoci", () => {
    const { from, to } = dayRange("2026-08-27", PRAHA);
    // Letní čas: půlnoc v Praze = 22:00 UTC předchozího dne.
    assert.equal(from.toISOString(), "2026-08-26T22:00:00.000Z");
    assert.equal(to.getTime() - from.getTime(), 24 * 3_600_000);
  });

  it("den přechodu na zimní čas má 25 hodin", () => {
    // Kdyby se počítalo +24 h, poslední hodina záznamů by z osy
    // vypadla — a nikdo by nepoznal proč.
    const { from, to } = dayRange("2026-10-25", PRAHA);
    assert.equal(to.getTime() - from.getTime(), 25 * 3_600_000);
  });

  it("den přechodu na letní čas má 23 hodin", () => {
    const { from, to } = dayRange("2026-03-29", PRAHA);
    assert.equal(to.getTime() - from.getTime(), 23 * 3_600_000);
  });
});

describe("monthGrid", () => {
  it("týdny začínají pondělím", () => {
    const grid = monthGrid("2026-08", new Map());
    assert.equal(grid[0].length, 7);
    // 1. 8. 2026 je sobota → týden začíná 27. 7.
    assert.equal(grid[0][0].day, "2026-07-27");
    assert.equal(grid[0][0].inMonth, false);
    assert.equal(grid[0][5].day, "2026-08-01");
    assert.equal(grid[0][5].inMonth, true);
  });

  it("počty se přiřadí ke dnům", () => {
    const grid = monthGrid("2026-08", new Map([["2026-08-27", 12]]));
    const den = grid.flat().find((d) => d.day === "2026-08-27");
    assert.equal(den?.recordings, 12);
  });

  it("dny bez záznamů mají nulu, ne undefined", () => {
    const grid = monthGrid("2026-08", new Map());
    assert.ok(grid.flat().every((d) => d.recordings === 0));
  });

  it("mřížka nemá týden složený jen z cizího měsíce", () => {
    // Únor 2027 začíná pondělím a má 28 dní — přesně čtyři týdny.
    const grid = monthGrid("2027-02", new Map());
    assert.equal(grid.length, 4);
    assert.ok(grid.every((tyden) => tyden.some((d) => d.inMonth)));
  });
});

describe("timelineSegments", () => {
  const range = dayRange("2026-08-27", PRAHA);

  const zaznam = (od: string, doKdy: string | null) => ({
    started_at: od,
    ended_at: doKdy,
  });

  it("poledne je uprostřed osy", () => {
    // 12:00 místního = 10:00 UTC.
    const [seg] = timelineSegments(
      [zaznam("2026-08-27T10:00:00Z", "2026-08-27T10:00:43Z")],
      range,
    );
    assert.ok(Math.abs(seg.left - 50) < 0.1, String(seg.left));
  });

  it("krátký záznam dostane nejmenší viditelnou šířku", () => {
    // 43 vteřin je na 24hodinové ose 0,05 % — neviditelné a netrefitelné.
    const [seg] = timelineSegments(
      [zaznam("2026-08-27T10:00:00Z", "2026-08-27T10:00:43Z")],
      range,
    );
    assert.equal(seg.width, MIN_SEGMENT_PERCENT);
  });

  it("dlouhý záznam má šířku podle délky", () => {
    // Šest hodin = čtvrtina dne.
    const [seg] = timelineSegments(
      [zaznam("2026-08-27T00:00:00Z", "2026-08-27T06:00:00Z")],
      range,
    );
    assert.ok(Math.abs(seg.width - 25) < 0.1, String(seg.width));
  });

  it("záznam přes půlnoc se ořízne na den", () => {
    // Pokračování patří dalšímu dni; kreslit ho přes okraj by lhalo
    // o tom, kdy skončil.
    const [seg] = timelineSegments(
      [zaznam("2026-08-27T21:30:00Z", "2026-08-27T23:00:00Z")],
      range,
    );
    assert.ok(seg.left + seg.width <= 100.001, `${seg.left} + ${seg.width}`);
  });

  it("záznam mimo den se nekreslí", () => {
    assert.deepEqual(
      timelineSegments([zaznam("2026-08-25T10:00:00Z", "2026-08-25T10:01:00Z")], range),
      [],
    );
  });

  it("záznam bez konce je bod, ne pruh přes celý den", () => {
    const [seg] = timelineSegments([zaznam("2026-08-27T10:00:00Z", null)], range);
    assert.equal(seg.width, MIN_SEGMENT_PERCENT);
  });

  it("nečitelný čas se přeskočí, nespadne", () => {
    assert.deepEqual(timelineSegments([zaznam("nesmysl", null)], range), []);
  });

  it("konec před začátkem nedá zápornou šířku", () => {
    const [seg] = timelineSegments(
      [zaznam("2026-08-27T10:00:00Z", "2026-08-27T09:00:00Z")],
      range,
    );
    assert.ok(seg.width > 0);
  });
});
