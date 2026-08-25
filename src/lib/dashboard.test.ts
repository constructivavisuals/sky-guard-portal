import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  cameraSilenceWarnings,
  cameraWarnings,
  dockWarnings,
  formatUntil,
  patrolWarnings,
} from "./dashboard.ts";
import type { DockState } from "./dispatch/flighthub.ts";

const ZDRAVY: DockState = {
  droneInDock: true,
  droneStatus: "power_off",
  batteryPercent: 94,
  chargeState: "idle",
  storageUsedPercent: 30,
  remainUpload: 0,
  conditions: null,
  latitude: 50.3305,
  longitude: 15.4256,
};

describe("dockWarnings", () => {
  it("zdravý dok nic nehlásí", () => {
    assert.deepEqual(dockWarnings(ZDRAVY), []);
  });

  it("vypnutý dron v doku není problém", () => {
    // power_off je běžný stav mezi lety.
    assert.deepEqual(dockWarnings({ ...ZDRAVY, droneStatus: "power_off" }), []);
  });

  it("dron mimo dok se hlásí", () => {
    const w = dockWarnings({ ...ZDRAVY, droneInDock: false });
    assert.equal(w.length, 1);
    assert.match(w[0].text, /není v doku/);
  });

  it("úložiště nad 90 %", () => {
    const w = dockWarnings({ ...ZDRAVY, storageUsedPercent: 91 });
    assert.match(w[0].text, /91 %/);
  });

  it("přesně 90 % ještě nevaruje", () => {
    assert.deepEqual(dockWarnings({ ...ZDRAVY, storageUsedPercent: 90 }), []);
  });

  it("plné úložiště zmíní i čekající soubory", () => {
    const w = dockWarnings({ ...ZDRAVY, storageUsedPercent: 96, remainUpload: 42 });
    assert.match(w[0].text, /42 souborů/);
  });

  it("baterie pod 40 %", () => {
    const w = dockWarnings({ ...ZDRAVY, batteryPercent: 39 });
    assert.match(w[0].text, /39 %/);
  });

  it("přesně 40 % ještě nevaruje", () => {
    assert.deepEqual(dockWarnings({ ...ZDRAVY, batteryPercent: 40 }), []);
  });

  it("neznámé hodnoty nevaruje, ne že by mlčky předpokládala nulu", () => {
    assert.deepEqual(
      dockWarnings({ ...ZDRAVY, batteryPercent: null, storageUsedPercent: null }),
      [],
    );
  });

  it("víc potíží naráz dá víc varování", () => {
    const w = dockWarnings({
      ...ZDRAVY,
      droneInDock: false,
      batteryPercent: 12,
      storageUsedPercent: 99,
    });
    assert.equal(w.length, 3);
  });
});

describe("patrolWarnings", () => {
  const now = new Date("2026-08-26T12:00:00Z");
  const base = { name: "Ranní obchůzka", interval_minutes: 60, since: new Date("2026-08-01T00:00:00Z") };

  it("čerstvá hlídka nic nehlásí", () => {
    const w = patrolWarnings(
      [{ ...base, lastFlightAt: new Date("2026-08-26T11:30:00Z") }],
      now,
    );
    assert.deepEqual(w, []);
  });

  it("přesně dvojnásobek intervalu ještě projde", () => {
    const w = patrolWarnings(
      [{ ...base, lastFlightAt: new Date("2026-08-26T10:00:00Z") }],
      now,
    );
    assert.deepEqual(w, []);
  });

  it("nad dvojnásobek se hlásí", () => {
    const w = patrolWarnings(
      [{ ...base, lastFlightAt: new Date("2026-08-26T09:00:00Z") }],
      now,
    );
    assert.equal(w.length, 1);
    assert.match(w[0].text, /Ranní obchůzka/);
    assert.match(w[0].text, /3 h/);
  });

  it("hlídka, která nikdy neletěla", () => {
    const w = patrolWarnings([{ ...base, lastFlightAt: null }], now);
    assert.equal(w.length, 1);
    assert.match(w[0].text, /nikdy neletěla/);
  });

  it("delší prodleva se počítá ve dnech", () => {
    const w = patrolWarnings(
      [{ ...base, lastFlightAt: new Date("2026-08-23T12:00:00Z") }],
      now,
    );
    assert.match(w[0].text, /3 dní/);
  });

  it("víc hlídek dá víc varování", () => {
    const w = patrolWarnings(
      [
        { ...base, lastFlightAt: new Date("2026-08-20T12:00:00Z") },
        { ...base, name: "Noční", lastFlightAt: new Date("2026-08-20T12:00:00Z") },
      ],
      now,
    );
    assert.equal(w.length, 2);
  });
});

describe("formatUntil", () => {
  const now = new Date("2026-08-26T12:00:00Z");

  it("minuty", () => {
    assert.equal(formatUntil(new Date("2026-08-26T12:45:00Z"), now), "za 45 min");
  });

  it("hodiny s minutami", () => {
    assert.equal(formatUntil(new Date("2026-08-26T15:12:00Z"), now), "za 3 h 12 min");
  });

  it("celé hodiny bez minut", () => {
    assert.equal(formatUntil(new Date("2026-08-26T18:00:00Z"), now), "za 6 h");
  });

  it("dny", () => {
    assert.equal(formatUntil(new Date("2026-08-29T18:00:00Z"), now), "za 3 dní 6 h");
  });

  it("minulost vrací null místo záporného času", () => {
    assert.equal(formatUntil(new Date("2026-08-26T11:00:00Z"), now), null);
  });

  it("právě teď taky null", () => {
    assert.equal(formatUntil(now, now), null);
  });
});

describe("patrolWarnings — vadná data", () => {
  const now = new Date("2026-08-26T12:00:00Z");

  it("neplatné datum nedá NaN, ale ticho", () => {
    const w = patrolWarnings(
      [
        {
          name: "Rozbitá",
          interval_minutes: 60,
          lastFlightAt: null,
          since: new Date("nesmysl"),
        },
      ],
      now,
    );
    assert.deepEqual(w, []);
  });

  it("nulový interval taky nevaruje", () => {
    const w = patrolWarnings(
      [
        {
          name: "Bez intervalu",
          interval_minutes: 0,
          lastFlightAt: new Date("2020-01-01T00:00:00Z"),
          since: new Date("2020-01-01T00:00:00Z"),
        },
      ],
      now,
    );
    assert.deepEqual(w, []);
  });
});

describe("cameraWarnings", () => {
  it("mlčí, když mají všechny kamery zónu", () => {
    assert.deepEqual(cameraWarnings({ total: 5, withoutZone: 0 }), []);
  });

  it("mlčí i bez kamer", () => {
    assert.deepEqual(cameraWarnings({ total: 0, withoutZone: 0 }), []);
  });

  it("část kamer bez zóny", () => {
    const [warning] = cameraWarnings({ total: 5, withoutZone: 2 });
    assert.match(warning.text, /2 kamer nemá/);
    assert.ok(!warning.text.includes("žádný zásah"));
  });

  it("jedna kamera se skloňuje", () => {
    const [warning] = cameraWarnings({ total: 5, withoutZone: 1 });
    assert.match(warning.text, /^Jedna kamera nemá/);
  });

  it("když je bez zóny úplně všechno, řekne to natvrdo", () => {
    const [warning] = cameraWarnings({ total: 5, withoutZone: 5 });
    assert.match(warning.text, /nevznikne žádný zásah/);
  });
});

describe("cameraSilenceWarnings", () => {
  const now = new Date("2026-08-31T12:00:00Z");
  const pred = (minut: number) => new Date(now.getTime() - minut * 60_000);

  it("mlčí, když se všechny ozvaly nedávno", () => {
    assert.deepEqual(
      cameraSilenceWarnings(
        [{ name: "Brána", lastSeenAt: pred(10), online: true }],
        now,
      ),
      [],
    );
  });

  it("upozorní na kameru, která mlčí přes hodinu", () => {
    const [w] = cameraSilenceWarnings(
      [{ name: "Brána", lastSeenAt: pred(61), online: true }],
      now,
    );
    assert.match(w.text, /Brána/);
  });

  it("těsně pod prahem ještě nehlásí", () => {
    assert.deepEqual(
      cameraSilenceWarnings(
        [{ name: "Brána", lastSeenAt: pred(59), online: true }],
        now,
      ),
      [],
    );
  });

  it("kamera, která se nikdy neozvala, není rozbitá — jen nezapojená", () => {
    assert.deepEqual(
      cameraSilenceWarnings(
        [{ name: "Nová", lastSeenAt: null, online: true }],
        now,
      ),
      [],
    );
  });

  it("kamera vedená jako offline se nehlásí — o tom se ví jinak", () => {
    assert.deepEqual(
      cameraSilenceWarnings(
        [{ name: "Vypnutá", lastSeenAt: pred(500), online: false }],
        now,
      ),
      [],
    );
  });

  it("víc kamer se sloučí do jedné hlášky se jmény", () => {
    const [w] = cameraSilenceWarnings(
      [
        { name: "Brána", lastSeenAt: pred(90), online: true },
        { name: "Dvůr", lastSeenAt: pred(200), online: true },
      ],
      now,
    );
    assert.match(w.text, /2 kamer/);
    assert.match(w.text, /Brána, Dvůr/);
  });

  it("neplatné datum mlčí, ne aby hlásilo nesmysl", () => {
    assert.deepEqual(
      cameraSilenceWarnings(
        [{ name: "Rozbitá", lastSeenAt: new Date("nesmysl"), online: true }],
        now,
      ),
      [],
    );
  });
});
