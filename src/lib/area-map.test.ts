import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  boundsAreUsable,
  boundsAspectRatio,
  boundsSpanMeters,
  fieldOfViewDegrees,
  projectPoint,
  projectTrack,
  sectorPath,
  trackPath,
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
  it("Vysoké Veselí má výřez zhruba 1,15 — v metrech, ne ve stupních", () => {
    // 223 × 194 m. Poměr ve stupních je 1,798; kdyby se použil ten,
    // fotka by se do rámečku vodorovně protáhla.
    assert.ok(Math.abs(boundsAspectRatio(VESELI) - 1.15) < 0.01);
  });

  it("stejný výřez je na rovníku širší než u pólu", () => {
    const span = { nwLon: 0, seLon: 0.01 };
    const rovnik = boundsAspectRatio({ ...span, nwLat: 0.001, seLat: 0 });
    const sever = boundsAspectRatio({ ...span, nwLat: 60.001, seLat: 60 });
    assert.ok(rovnik > sever);
    // Na 60° s. š. je stupeň délky přesně poloviční.
    assert.ok(Math.abs(sever / rovnik - 0.5) < 0.001);
  });

  it("na rovníku se poměr rovná poměru ve stupních", () => {
    assert.ok(
      Math.abs(boundsAspectRatio({ nwLat: 0, nwLon: 0, seLat: -1, seLon: 1 }) - 1) <
        1e-4,
    );
  });

  it("nezáleží na pořadí rohů", () => {
    assert.equal(
      boundsAspectRatio(VESELI),
      boundsAspectRatio({
        nwLat: VESELI.seLat,
        nwLon: VESELI.seLon,
        seLat: VESELI.nwLat,
        seLon: VESELI.nwLon,
      }),
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

describe("boundsSpanMeters", () => {
  it("Vysoké Veselí měří zhruba 223 × 194 m", () => {
    const span = boundsSpanMeters(VESELI);
    assert.ok(Math.abs(span.width - 223) < 2, `šířka ${span.width}`);
    assert.ok(Math.abs(span.height - 194) < 2, `výška ${span.height}`);
  });

  it("stupeň šířky je zhruba 111 km", () => {
    const span = boundsSpanMeters({ nwLat: 1, nwLon: 0, seLat: 0, seLon: 1 });
    assert.ok(Math.abs(span.height - 111_320) < 1);
  });
});

describe("fieldOfViewDegrees", () => {
  it("tabulková ohniska sedí na katalog", () => {
    assert.equal(fieldOfViewDegrees(2.8), 106);
    assert.equal(fieldOfViewDegrees(3.6), 87);
    assert.equal(fieldOfViewDegrees(6), 50);
  });

  it("mezi tabulkovými hodnotami interpoluje", () => {
    const value = fieldOfViewDegrees(3.2);
    assert.ok(value !== null && value > 87 && value < 106, `${value}`);
  });

  it("je monotónní — širší objektiv nikdy nemá užší záběr", () => {
    let previous = Infinity;
    for (let focal = 2; focal <= 12; focal += 0.2) {
      const value = fieldOfViewDegrees(focal);
      assert.ok(value !== null);
      assert.ok(value <= previous + 1e-9, `${focal} mm dalo ${value}`);
      previous = value;
    }
  });

  it("nad tabulkou navazuje spojitě", () => {
    const value = fieldOfViewDegrees(6.001);
    assert.ok(value !== null && Math.abs(value - 50) < 0.1, `${value}`);
  });

  it("pod tabulkou neextrapoluje", () => {
    assert.equal(fieldOfViewDegrees(1), 106);
  });

  it("nesmysly vrací null", () => {
    assert.equal(fieldOfViewDegrees(null), null);
    assert.equal(fieldOfViewDegrees(0), null);
    assert.equal(fieldOfViewDegrees(-6), null);
    assert.equal(fieldOfViewDegrees(Number.NaN), null);
  });
});

describe("sectorPath", () => {
  const center = { x: 100, y: 100 };

  it("výseč na sever míří nahoru", () => {
    const path = sectorPath(center, 0, 90, 10);
    assert.ok(path !== null);
    // Krajní body jsou na 315° a 45°, tedy oba nad středem.
    const numbers = path.match(/-?\d+(\.\d+)?/g)!.map(Number);
    assert.ok(numbers[1] === 100);
    // První bod oblouku: x menší než střed, y menší (výš).
    assert.ok(numbers[2] < 100 && numbers[3] < 100, path);
  });

  it("azimut 90 míří na východ", () => {
    const path = sectorPath(center, 90, 2, 10)!;
    const numbers = path.match(/-?\d+(\.\d+)?/g)!.map(Number);
    // Krajní bod je skoro přesně 10 m na východ.
    assert.ok(Math.abs(numbers[2] - 110) < 0.5, path);
    assert.ok(Math.abs(numbers[3] - 100) < 0.5, path);
  });

  it("azimut 180 míří na jih, tedy dolů", () => {
    const path = sectorPath(center, 180, 2, 10)!;
    const numbers = path.match(/-?\d+(\.\d+)?/g)!.map(Number);
    assert.ok(numbers[3] > 109, path);
  });

  it("široká výseč nastaví large-arc", () => {
    assert.match(sectorPath(center, 0, 200, 10)!, / 0 1 1 /);
    assert.match(sectorPath(center, 0, 106, 10)!, / 0 0 1 /);
  });

  it("celý kruh se kreslí dvěma oblouky", () => {
    const path = sectorPath(center, 0, 360, 10)!;
    assert.equal(path.match(/A /g)?.length, 2);
    // Bez středu — jinak by z kruhu koukal paprsek.
    assert.ok(!path.includes("L "), path);
  });

  it("nesmysly vrací null", () => {
    assert.equal(sectorPath(center, 0, 0, 10), null);
    assert.equal(sectorPath(center, 0, 90, 0), null);
    assert.equal(sectorPath(center, Number.NaN, 90, 10), null);
  });
});

describe("projectTrack", () => {
  const stred = {
    latitude: (VESELI.nwLat + VESELI.seLat) / 2,
    longitude: (VESELI.nwLon + VESELI.seLon) / 2,
  };
  const mimo = { latitude: 50.4, longitude: 15.6 };

  it("souvislá trasa je jeden úsek", () => {
    const track = projectTrack(VESELI, [
      { latitude: VESELI.nwLat, longitude: VESELI.nwLon },
      stred,
      { latitude: VESELI.seLat, longitude: VESELI.seLon },
    ]);

    assert.equal(track.segments.length, 1);
    assert.equal(track.segments[0].length, 3);
    assert.equal(track.skipped, 0);
    assert.deepEqual(track.start, { x: 0, y: 0 });
    assert.ok(track.end && Math.abs(track.end.x - 1) < 1e-9);
  });

  it("bod mimo výřez trasu rozdělí, nezkrátí", () => {
    // Kdyby se zbylé body prostě spojily, vznikla by přímka přes
    // území, kudy dron neletěl.
    const track = projectTrack(VESELI, [
      { latitude: VESELI.nwLat, longitude: VESELI.nwLon },
      stred,
      mimo,
      stred,
      { latitude: VESELI.seLat, longitude: VESELI.seLon },
    ]);

    assert.equal(track.segments.length, 2);
    assert.equal(track.skipped, 1);
  });

  it("osamocený bod úsek netvoří", () => {
    const track = projectTrack(VESELI, [stred, mimo, stred, mimo, stred]);
    assert.deepEqual(track.segments, []);
    assert.equal(track.skipped, 2);
    // Krajní body ale zůstávají — trasa výřezem prošla.
    assert.ok(track.start);
    assert.ok(track.end);
  });

  it("trasa úplně mimo výřez nekreslí nic", () => {
    const track = projectTrack(VESELI, [mimo, mimo]);
    assert.deepEqual(track.segments, []);
    assert.equal(track.start, null);
    assert.equal(track.end, null);
    assert.equal(track.skipped, 2);
  });

  it("prázdná trasa projde", () => {
    const track = projectTrack(VESELI, []);
    assert.deepEqual(track.segments, []);
    assert.equal(track.skipped, 0);
  });
});

describe("trackPath", () => {
  it("začíná M a pokračuje L v metrech", () => {
    const span = boundsSpanMeters(VESELI);
    const path = trackPath(
      [
        { x: 0, y: 0 },
        { x: 1, y: 1 },
      ],
      span,
    );

    const [prvni, druhy] = path.split(" L ");
    assert.equal(prvni, "M 0 0");
    // Druhý bod je pravý dolní roh, tedy celá šířka a výška v metrech.
    const [x, y] = druhy.split(" ").map(Number);
    assert.ok(Math.abs(x - span.width) < 0.01, `${x} vs ${span.width}`);
    assert.ok(Math.abs(y - span.height) < 0.01, `${y} vs ${span.height}`);
  });
});
