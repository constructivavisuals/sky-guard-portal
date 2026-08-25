import { strict as assert } from "node:assert";
import { beforeEach, describe, it } from "node:test";

import { clearDockStateCache, getDockStateCached } from "./dock-cache.ts";
import type { DockStateResult } from "./flighthub.ts";

const OK: DockStateResult = {
  ok: true,
  state: {
    droneInDock: true,
    droneStatus: "power_off",
    batteryPercent: 94,
    chargeState: "idle",
    storageUsedPercent: 30,
    remainUpload: 0,
    conditions: null,
  },
};

function counter(result: DockStateResult = OK) {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    fetcher: async () => {
      calls += 1;
      return result;
    },
  };
}

describe("getDockStateCached", () => {
  beforeEach(() => {
    clearDockStateCache();
  });

  it("první volání sáhne na FlightHub", async () => {
    const c = counter();
    const out = await getDockStateCached("DOCK-1", { fetcher: c.fetcher, now: () => 0 });
    assert.equal(c.calls, 1);
    assert.equal(out.ageMs, 0);
    assert.deepEqual(out.result, OK);
  });

  it("druhé volání v minutě už ne", async () => {
    const c = counter();
    await getDockStateCached("DOCK-1", { fetcher: c.fetcher, now: () => 0 });
    const out = await getDockStateCached("DOCK-1", { fetcher: c.fetcher, now: () => 59_000 });
    assert.equal(c.calls, 1);
    assert.equal(out.ageMs, 59_000);
  });

  it("po minutě se ptá znovu", async () => {
    const c = counter();
    await getDockStateCached("DOCK-1", { fetcher: c.fetcher, now: () => 0 });
    await getDockStateCached("DOCK-1", { fetcher: c.fetcher, now: () => 60_000 });
    assert.equal(c.calls, 2);
  });

  it("každý dok má vlastní záznam", async () => {
    const c = counter();
    await getDockStateCached("DOCK-1", { fetcher: c.fetcher, now: () => 0 });
    await getDockStateCached("DOCK-2", { fetcher: c.fetcher, now: () => 0 });
    assert.equal(c.calls, 2);
  });

  it("chyba se cachuje taky — nedostupný FlightHub neznamená volání na každé načtení", async () => {
    const c = counter({ ok: false, message: "timeout" });
    await getDockStateCached("DOCK-1", { fetcher: c.fetcher, now: () => 0 });
    const out = await getDockStateCached("DOCK-1", { fetcher: c.fetcher, now: () => 30_000 });
    assert.equal(c.calls, 1);
    assert.equal(out.result.ok, false);
  });

  it("stáří roste, dokud záznam platí", async () => {
    const c = counter();
    await getDockStateCached("DOCK-1", { fetcher: c.fetcher, now: () => 1_000 });
    const out = await getDockStateCached("DOCK-1", { fetcher: c.fetcher, now: () => 41_000 });
    assert.equal(out.ageMs, 40_000);
  });
});
