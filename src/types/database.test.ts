// Testy vyhodnocení ostrého režimu. Spuštění:
//   npm test
// Node stripuje typy nativně, žádný test runner se neinstaluje.
//
// Protějšek SQL funkce site_is_armed() v migraci
// supabase/migrations/20260824120000_perimeter_schema.sql — když se
// mění pravidla, musí se měnit obě implementace.

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { isSiteArmed, isCooldownElapsed, type Site } from "./database.ts";

type ArmedInput = Pick<
  Site,
  "timezone" | "armed_from" | "armed_to" | "armed_days"
>;

/** Noční ostraha v pracovní dny, 18:00–06:00 pražského času. */
const NIGHT_SHIFT: ArmedInput = {
  timezone: "Europe/Prague",
  armed_from: "18:00:00",
  armed_to: "06:00:00",
  armed_days: [1, 2, 3, 4, 5],
};

/** Denní okno o víkendu, 08:00–17:00. */
const WEEKEND_DAY: ArmedInput = {
  timezone: "Europe/Prague",
  armed_from: "08:00:00",
  armed_to: "17:00:00",
  armed_days: [6, 7],
};

describe("isSiteArmed — okno přes půlnoc", () => {
  const cases: [string, string, boolean][] = [
    ["pátek 20:00 je v okně", "2026-08-28T20:00:00+02:00", true],
    ["sobota 02:00 patří k pátku", "2026-08-29T02:00:00+02:00", true],
    ["sobota 20:00 — sobota není v armed_days", "2026-08-29T20:00:00+02:00", false],
    ["neděle 02:00 patří k sobotě, tedy mimo", "2026-08-30T02:00:00+02:00", false],
    ["pondělí 02:00 patří k neděli, tedy mimo", "2026-08-31T02:00:00+02:00", false],
    ["pondělí 12:00 je mimo okno", "2026-08-31T12:00:00+02:00", false],
    ["pondělí 18:00 — dolní hranice je v okně", "2026-08-31T18:00:00+02:00", true],
    ["úterý 06:00 — horní hranice už v okně není", "2026-09-01T06:00:00+02:00", false],
  ];

  for (const [name, iso, expected] of cases) {
    it(name, () => {
      assert.equal(isSiteArmed(NIGHT_SHIFT, new Date(iso)), expected);
    });
  }
});

describe("isSiteArmed — denní okno", () => {
  it("sobota 12:00 je v okně", () => {
    assert.equal(isSiteArmed(WEEKEND_DAY, new Date("2026-08-29T12:00:00+02:00")), true);
  });

  it("sobota 20:00 je mimo okno", () => {
    assert.equal(isSiteArmed(WEEKEND_DAY, new Date("2026-08-29T20:00:00+02:00")), false);
  });

  it("pátek 12:00 — pátek není v armed_days", () => {
    assert.equal(isSiteArmed(WEEKEND_DAY, new Date("2026-08-28T12:00:00+02:00")), false);
  });
});

describe("isSiteArmed — letní a zimní čas", () => {
  // Stejný okamžik v UTC dopadne v Praze různě podle části roku:
  // v CEST (UTC+2) je 16:30Z už 18:30, v CET (UTC+1) teprve 17:30.
  // Fixní offset by tenhle pár nerozlišil.
  it("16:30Z v červenci je 18:30 CEST — v okně", () => {
    assert.equal(isSiteArmed(NIGHT_SHIFT, new Date("2026-07-15T16:30:00Z")), true);
  });

  it("16:30Z v lednu je 17:30 CET — mimo okno", () => {
    assert.equal(isSiteArmed(NIGHT_SHIFT, new Date("2026-01-15T16:30:00Z")), false);
  });

  it("17:00Z v lednu je 18:00 CET — dolní hranice okna", () => {
    assert.equal(isSiteArmed(NIGHT_SHIFT, new Date("2026-01-15T17:00:00Z")), true);
  });

  // Přechody EU času padají vždy na neděli, takže sama noční směna
  // Po–Pá je nepokrývá — pro test posunu hodin je potřeba okno na celý
  // týden. Že se směna Po–Pá na přechod netrefí, hlídá test níž.
  const ALL_WEEK_NIGHT: ArmedInput = {
    ...NIGHT_SHIFT,
    armed_days: [1, 2, 3, 4, 5, 6, 7],
  };

  // Přechod na letní čas: v noci na neděli 2026-03-29 skáčou hodiny
  // z 02:00 na 03:00, ranní část nočního okna se tím zkracuje.
  it("00:30Z v noci přechodu na letní čas je 01:30 CET — ještě v okně", () => {
    assert.equal(isSiteArmed(ALL_WEEK_NIGHT, new Date("2026-03-29T00:30:00Z")), true);
  });

  it("01:30Z tutéž noc je už 03:30 CEST — hodina se přeskočila, okno platí dál", () => {
    assert.equal(isSiteArmed(ALL_WEEK_NIGHT, new Date("2026-03-29T01:30:00Z")), true);
  });

  it("04:30Z v noci přechodu je 06:30 CEST — okno skončilo", () => {
    assert.equal(isSiteArmed(ALL_WEEK_NIGHT, new Date("2026-03-29T04:30:00Z")), false);
  });

  // Přechod na zimní čas: v noci na neděli 2026-10-25 se hodina
  // 02:00–03:00 opakuje. Oba průchody mají stejné nástěnné hodiny
  // a musí spadnout do okna stejně.
  it("00:30Z při návratu na zimní čas je 02:30 CEST — první průchod", () => {
    assert.equal(isSiteArmed(ALL_WEEK_NIGHT, new Date("2026-10-25T00:30:00Z")), true);
  });

  it("01:30Z tutéž noc je 02:30 CET — druhý průchod stejné hodiny", () => {
    assert.equal(isSiteArmed(ALL_WEEK_NIGHT, new Date("2026-10-25T01:30:00Z")), true);
  });

  it("05:30Z při návratu na zimní čas je 06:30 CET — už mimo okno", () => {
    assert.equal(isSiteArmed(ALL_WEEK_NIGHT, new Date("2026-10-25T05:30:00Z")), false);
  });

  it("směna Po–Pá nedělní přechod nepokrývá — ranní část patří sobotě", () => {
    assert.equal(isSiteArmed(NIGHT_SHIFT, new Date("2026-03-29T00:30:00Z")), false);
    assert.equal(isSiteArmed(NIGHT_SHIFT, new Date("2026-10-25T00:30:00Z")), false);
  });
});

describe("isSiteArmed — timezone se skutečně respektuje", () => {
  const newYork: ArmedInput = { ...NIGHT_SHIFT, timezone: "America/New_York" };

  it("22:00Z ve čtvrtek je 18:00 EDT — v okně newyorské lokality", () => {
    assert.equal(isSiteArmed(newYork, new Date("2026-08-27T22:00:00Z")), true);
  });

  it("tentýž okamžik je v Praze pátek 00:00 — patří ke čtvrtku, taky v okně", () => {
    assert.equal(isSiteArmed(NIGHT_SHIFT, new Date("2026-08-27T22:00:00Z")), true);
  });

  it("16:00Z v neděli je 12:00 EDT — mimo okno, den ani čas nesedí", () => {
    assert.equal(isSiteArmed(newYork, new Date("2026-08-30T16:00:00Z")), false);
  });

  it("neplatná zóna vyhodí RangeError", () => {
    assert.throws(
      () => isSiteArmed({ ...NIGHT_SHIFT, timezone: "Europe/Neexistuje" }, new Date()),
      RangeError,
    );
  });
});

describe("isSiteArmed — prázdné okno", () => {
  it("armed_from = armed_to znamená nikdy, ne nepřetržitě", () => {
    const never: ArmedInput = {
      ...NIGHT_SHIFT,
      armed_from: "00:00:00",
      armed_to: "00:00:00",
    };
    assert.equal(isSiteArmed(never, new Date("2026-08-31T12:00:00+02:00")), false);
    assert.equal(isSiteArmed(never, new Date("2026-08-31T00:00:00+02:00")), false);
  });
});

describe("isCooldownElapsed", () => {
  it("bez předchozího zásahu je cooldown vždy uplynulý", () => {
    assert.equal(isCooldownElapsed({ cooldown_seconds: 900 }, null), true);
  });

  it("20 minut po zásahu je cooldown 15 minut pryč", () => {
    assert.equal(
      isCooldownElapsed(
        { cooldown_seconds: 900 },
        "2026-08-24T10:00:00Z",
        new Date("2026-08-24T10:20:00Z"),
      ),
      true,
    );
  });

  it("5 minut po zásahu cooldown ještě běží", () => {
    assert.equal(
      isCooldownElapsed(
        { cooldown_seconds: 900 },
        "2026-08-24T10:00:00Z",
        new Date("2026-08-24T10:05:00Z"),
      ),
      false,
    );
  });

  it("přesně na hranici je cooldown uplynulý", () => {
    assert.equal(
      isCooldownElapsed(
        { cooldown_seconds: 900 },
        "2026-08-24T10:00:00Z",
        new Date("2026-08-24T10:15:00Z"),
      ),
      true,
    );
  });
});
