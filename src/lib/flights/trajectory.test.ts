import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { arrivalAt, maxHeight, trajectoryPoints } from "./trajectory.ts";
import type { Json } from "../../types/database.ts";

/** Vysoké Veselí, zhruba střed areálu. */
const ZONE = { latitude: 50.3182, longitude: 15.4283 };

function point(over: Record<string, unknown> = {}) {
  return {
    timestamp: 1_756_000_000,
    latitude: ZONE.latitude,
    longitude: ZONE.longitude,
    height: 40,
    ...over,
  };
}

function trajectory(points: unknown[]): Json {
  return { track_id: "t1", points } as unknown as Json;
}

describe("trajectoryPoints", () => {
  it("čte body a řadí je v čase", () => {
    const points = trajectoryPoints(
      trajectory([
        point({ timestamp: 300, height: 10 }),
        point({ timestamp: 100, height: 30 }),
        point({ timestamp: 200, height: 20 }),
      ]),
    );

    assert.deepEqual(
      points.map((p) => p.timestamp),
      [100, 200, 300],
    );
  });

  it("zahazuje body bez času nebo souřadnic", () => {
    const points = trajectoryPoints(
      trajectory([
        point(),
        point({ timestamp: null }),
        point({ latitude: undefined }),
        point({ longitude: "sem" }),
        { neco: "jineho" },
        null,
        "text",
      ]),
    );

    assert.equal(points.length, 1);
  });

  it("zahazuje souřadnice mimo rozsah", () => {
    const points = trajectoryPoints(
      trajectory([point({ latitude: 91 }), point({ longitude: -181 })]),
    );
    assert.equal(points.length, 0);
  });

  it("chybějící výška zůstává null, ne nula", () => {
    // Nula je platná výška (dron na zemi). Kdyby chybějící údaj
    // spadl na nulu, maximum by z toho vyšlo stejně, ale „letěl
    // v nule“ je jiné tvrzení než „nevíme“.
    const [p] = trajectoryPoints(trajectory([point({ height: undefined })]));
    assert.equal(p.height, null);
  });

  it("snese cokoli místo trajektorie", () => {
    assert.deepEqual(trajectoryPoints(null), []);
    assert.deepEqual(trajectoryPoints("text" as unknown as Json), []);
    assert.deepEqual(trajectoryPoints([] as unknown as Json), []);
    assert.deepEqual(trajectoryPoints({} as unknown as Json), []);
    assert.deepEqual(trajectoryPoints({ points: "ne" } as unknown as Json), []);
  });
});

describe("maxHeight", () => {
  it("bere nejvyšší hlášenou výšku", () => {
    const points = trajectoryPoints(
      trajectory([
        point({ timestamp: 1, height: 12 }),
        point({ timestamp: 2, height: 48.5 }),
        point({ timestamp: 3, height: 30 }),
      ]),
    );
    assert.equal(maxHeight(points), 48.5);
  });

  it("bez hlášené výšky vrací null", () => {
    const points = trajectoryPoints(
      trajectory([point({ timestamp: 1, height: null })]),
    );
    assert.equal(maxHeight(points), null);
  });

  it("záporná výška se neusekává na nule", () => {
    const points = trajectoryPoints(
      trajectory([point({ timestamp: 1, height: -3 })]),
    );
    assert.equal(maxHeight(points), -3);
  });

  it("prázdná trasa je null", () => {
    assert.equal(maxHeight([]), null);
  });
});

describe("arrivalAt", () => {
  // Zhruba 111 m na setinu stupně šířky.
  const daleko = { latitude: ZONE.latitude + 0.005, longitude: ZONE.longitude };
  const blizko = { latitude: ZONE.latitude + 0.0003, longitude: ZONE.longitude };

  it("vrací čas prvního bodu v okruhu", () => {
    const points = trajectoryPoints(
      trajectory([
        point({ timestamp: 1_756_000_000, ...daleko }),
        point({ timestamp: 1_756_000_060, ...blizko }),
        point({ timestamp: 1_756_000_120, ...ZONE }),
      ]),
    );

    const arrival = arrivalAt(points, ZONE);
    assert.equal(arrival?.toISOString(), new Date(1_756_000_060_000).toISOString());
  });

  it("nejbližší bod nepřebíjí první v okruhu", () => {
    // Na zpáteční cestě proletí dron zónou znovu a může být blíž.
    // Zajímá nás okamžik doletu, ne rekord v přiblížení.
    const points = trajectoryPoints(
      trajectory([
        point({ timestamp: 10, ...blizko }),
        point({ timestamp: 20, ...daleko }),
        point({ timestamp: 30, ...ZONE }),
      ]),
    );
    assert.equal(arrivalAt(points, ZONE)?.getTime(), 10_000);
  });

  it("bez doletu vrací null", () => {
    const points = trajectoryPoints(
      trajectory([point({ timestamp: 10, ...daleko })]),
    );
    assert.equal(arrivalAt(points, ZONE), null);
  });

  it("okruh jde nastavit", () => {
    const points = trajectoryPoints(
      trajectory([point({ timestamp: 10, ...daleko })]),
    );
    assert.equal(arrivalAt(points, ZONE, 20), null);
    assert.notEqual(arrivalAt(points, ZONE, 1000), null);
  });

  it("milisekundová razítka nespadnou do roku 1970", () => {
    const points = trajectoryPoints(
      trajectory([point({ timestamp: 1_756_000_000_000, ...ZONE })]),
    );
    assert.equal(arrivalAt(points, ZONE)?.getUTCFullYear(), 2025);
  });
});
