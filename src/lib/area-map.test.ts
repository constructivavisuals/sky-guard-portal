import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  boundsAreUsable,
  boundsAspectRatio,
  projectPoint,
  type MapBounds,
} from "./area-map.ts";

// Vysoké Veselí
const VESELI: MapBounds = {
  nwLat: 50.331201,
  nwLon: 15.424061,
  seLat: 50.329457,
  seLon: 15.427197,
};

describe("projectPoint — rohy a střed", () => {
  it("severozápadní roh je vlevo nahoře", () => {
    assert.deepEqual(projectPoint(VESELI, VESELI.nwLat, VESELI.nwLon), { x: 0, y: 0 });
  });

  it("jihovýchodní roh je vpravo dole", () => {
    const p = projectPoint(VESELI, VESELI.seLat, VESELI.seLon);
    assert.ok(p);
    assert.ok(Math.abs(p.x - 1) < 1e-9);
    assert.ok(Math.abs(p.y - 1) < 1e-9);
  });

  it("střed výřezu je uprostřed", () => {
    const p = projectPoint(
      VESELI,
      (VESELI.nwLat + VESELI.seLat) / 2,
      (VESELI.nwLon + VESELI.seLon) / 2,
    );
    assert.ok(p);
    assert.ok(Math.abs(p.x - 0.5) < 1e-9);
    assert.ok(Math.abs(p.y - 0.5) < 1e-9);
  });

  it("severovýchodní roh je vpravo nahoře", () => {
    const p = projectPoint(VESELI, VESELI.nwLat, VESELI.seLon);
    assert.ok(p);
    assert.ok(Math.abs(p.x - 1) < 1e-9);
    assert.equal(p.y, 0);
  });

  it("vyšší zeměpisná šířka je výš, ne níž", () => {
    // Na severní polokouli roste šířka na sever, ale y roste dolů.
    const sever = projectPoint(VESELI, 50.3310, 15.4256);
    const jih = projectPoint(VESELI, 50.3296, 15.4256);
    assert.ok(sever && jih);
    assert.ok(sever.y < jih.y);
  });
});

describe("projectPoint — body mimo výřez", () => {
  const mimo: [string, number, number][] = [
    ["severně nad výřezem", 50.3320, 15.4256],
    ["jižně pod výřezem", 50.3290, 15.4256],
    ["západně vlevo", 50.3305, 15.4230],
    ["východně vpravo", 50.3305, 15.4280],
    ["úplně jinde", 50.0755, 14.4378],
  ];

  for (const [name, lat, lon] of mimo) {
    it(`${name} se nevykreslí`, () => {
      assert.equal(projectPoint(VESELI, lat, lon), null);
    });
  }

  it("nesmyslné souřadnice taky ne", () => {
    assert.equal(projectPoint(VESELI, Number.NaN, 15.4256), null);
    assert.equal(projectPoint(VESELI, 50.3305, Number.POSITIVE_INFINITY), null);
  });
});

describe("boundsAspectRatio", () => {
  it("Vysoké Veselí má výřez zhruba 1,80", () => {
    assert.ok(Math.abs(boundsAspectRatio(VESELI) - 1.798) < 0.01);
  });

  it("čtvercový výřez dá 1", () => {
    assert.equal(
      boundsAspectRatio({ nwLat: 1, nwLon: 0, seLat: 0, seLon: 1 }),
      1,
    );
  });
});

describe("boundsAreUsable", () => {
  it("platné rohy projdou", () => {
    assert.equal(boundsAreUsable(VESELI), true);
  });

  it("chybějící rohy neprojdou", () => {
    assert.equal(boundsAreUsable(null), false);
  });

  it("nulový rozsah by dělil nulou", () => {
    assert.equal(
      boundsAreUsable({ nwLat: 50, nwLon: 15, seLat: 50, seLon: 16 }),
      false,
    );
    assert.equal(
      boundsAreUsable({ nwLat: 50, nwLon: 15, seLat: 49, seLon: 15 }),
      false,
    );
  });

  it("nečíselné hodnoty neprojdou", () => {
    assert.equal(
      boundsAreUsable({ nwLat: Number.NaN, nwLon: 15, seLat: 49, seLon: 16 }),
      false,
    );
  });
});
