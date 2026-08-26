import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { distanceMeters, parsePointEwkbHex } from "./geo.ts";

// Fixtury odpovídají tomu, co vrací PostgREST pro geography(Point, 4326).
// Praha, Staroměstské náměstí: 50.0755 N, 14.4378 E.
const PRAHA_LE = "0101000020E6100000AA60545227E02C408B6CE7FBA9094940";
const PRAHA_BE = "0020000001000010E6402CE027525460AA404909A9FBE76C8B";
const PRAHA_LE_BEZ_SRID = "0101000000AA60545227E02C408B6CE7FBA9094940";
const NULOVY_OSTROV = "0101000020E610000000000000000000000000000000000000";

describe("parsePointEwkbHex — platné body", () => {
  it("little-endian se SRID", () => {
    const point = parsePointEwkbHex(PRAHA_LE);
    assert.ok(point);
    assert.ok(Math.abs(point.latitude - 50.0755) < 1e-9);
    assert.ok(Math.abs(point.longitude - 14.4378) < 1e-9);
  });

  it("big-endian se SRID", () => {
    const point = parsePointEwkbHex(PRAHA_BE);
    assert.ok(point);
    assert.ok(Math.abs(point.latitude - 50.0755) < 1e-9);
    assert.ok(Math.abs(point.longitude - 14.4378) < 1e-9);
  });

  it("bez SRID příznaku (holý WKB)", () => {
    const point = parsePointEwkbHex(PRAHA_LE_BEZ_SRID);
    assert.deepEqual(point, { latitude: 50.0755, longitude: 14.4378 });
  });

  it("malá písmena v hexu", () => {
    const point = parsePointEwkbHex(PRAHA_LE.toLowerCase());
    assert.ok(point);
  });

  it("nula je platná souřadnice, ne chybějící hodnota", () => {
    assert.deepEqual(parsePointEwkbHex(NULOVY_OSTROV), {
      latitude: 0,
      longitude: 0,
    });
  });

  it("X je délka a Y šířka, ne naopak", () => {
    // Prohozené pořadí by u Prahy prošlo rozsahovou kontrolou
    // (14 i 50 jsou platné šířky), tak to ověřujeme explicitně.
    const point = parsePointEwkbHex(PRAHA_LE);
    assert.ok(point);
    assert.ok(point.latitude > point.longitude);
  });
});

describe("parsePointEwkbHex — neplatné vstupy", () => {
  const cases: [string, string | null][] = [
    ["null", null],
    ["prázdný řetězec", ""],
    ["lichý počet znaků", "0101000020E610000"],
    ["nehexadecimální znaky", "ZZ01000020E6100000".padEnd(50, "0")],
    ["příliš krátký buffer", "0101000020E6100000"],
    ["neznámé pořadí bajtů", `02${PRAHA_LE.slice(2)}`],
    ["LineString místo Pointu", "0102000020E6100000AA60545227E02C408B6CE7FBA9094940"],
  ];

  for (const [name, value] of cases) {
    it(`${name} vrací null`, () => {
      assert.equal(parsePointEwkbHex(value), null);
    });
  }

  it("šířka mimo rozsah vrací null", () => {
    // 500° — poškozená data se nesmí dostat do FlightHubu jako waypoint.
    assert.equal(
      parsePointEwkbHex("0101000020E610000000000000000000000000000000407F40"),
      null,
    );
  });

  it("délka mimo rozsah vrací null", () => {
    assert.equal(
      parsePointEwkbHex("0101000020E610000000000000000079400000000000000000"),
      null,
    );
  });
});

describe("distanceMeters", () => {
  it("stejný bod je nula", () => {
    const a = { latitude: 50.3182, longitude: 15.4283 };
    assert.equal(distanceMeters(a, a), 0);
  });

  it("setina stupně šířky je zhruba 1112 m", () => {
    const a = { latitude: 50.3182, longitude: 15.4283 };
    const b = { latitude: 50.3282, longitude: 15.4283 };
    const d = distanceMeters(a, b);
    assert.ok(d !== null && Math.abs(d - 1112) < 5, `vyšlo ${d}`);
  });

  it("stupeň délky je na 50° kratší než stupeň šířky", () => {
    // Poledníky se sbíhají — bez kosinu šířky by obojí vyšlo stejně.
    const stred = { latitude: 50.3182, longitude: 15.4283 };
    const naSever = { latitude: 50.4182, longitude: 15.4283 };
    const naVychod = { latitude: 50.3182, longitude: 15.5283 };
    const sever = distanceMeters(stred, naSever)!;
    const vychod = distanceMeters(stred, naVychod)!;
    assert.ok(vychod < sever * 0.7, `${vychod} vs ${sever}`);
  });

  it("je symetrická", () => {
    const a = { latitude: 50.3182, longitude: 15.4283 };
    const b = { latitude: 50.3199, longitude: 15.4301 };
    assert.equal(distanceMeters(a, b), distanceMeters(b, a));
  });

  it("nesmyslný vstup je null, ne NaN", () => {
    const a = { latitude: 50.3182, longitude: 15.4283 };
    assert.equal(distanceMeters(a, { latitude: NaN, longitude: 0 }), null);
  });
});
