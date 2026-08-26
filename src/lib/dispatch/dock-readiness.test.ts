import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  checkDockReadiness,
  MAX_STORAGE_PERCENT,
  MIN_BATTERY_PERCENT,
} from "./dock-readiness.ts";
import type { DockState } from "./flighthub.ts";

function dock(over: Partial<DockState> = {}): DockState {
  return {
    droneInDock: true,
    droneStatus: "power_off",
    batteryPercent: 96,
    chargeState: "idle",
    storageUsedPercent: 40,
    remainUpload: 0,
    conditions: null,
    latitude: 50.3305,
    longitude: 15.4256,
    ...over,
  };
}

describe("checkDockReadiness", () => {
  it("nabitý dron v doku smí letět", () => {
    assert.deepEqual(checkDockReadiness(dock()), { ok: true, reason: null });
  });

  it("vypnutý dron není překážka", () => {
    // „power_off“ je běžný stav mezi lety, probouzí ho úloha.
    assert.equal(checkDockReadiness(dock({ droneStatus: "power_off" })).ok, true);
  });

  it("dron mimo dok nemá odkud vzlétnout", () => {
    const r = checkDockReadiness(dock({ droneInDock: false }));
    assert.equal(r.ok, false);
    assert.equal(r.reason, "drone_not_in_dock");
  });

  it("blokuje pod hranicí baterie, na hranici ne", () => {
    assert.equal(
      checkDockReadiness(dock({ batteryPercent: MIN_BATTERY_PERCENT - 1 })).reason,
      "low_battery",
    );
    assert.equal(
      checkDockReadiness(dock({ batteryPercent: MIN_BATTERY_PERCENT })).ok,
      true,
    );
  });

  it("blokuje nad hranicí zaplnění, na hranici ne", () => {
    assert.equal(
      checkDockReadiness(dock({ storageUsedPercent: MAX_STORAGE_PERCENT + 0.1 }))
        .reason,
      "storage_full",
    );
    assert.equal(
      checkDockReadiness(dock({ storageUsedPercent: MAX_STORAGE_PERCENT })).ok,
      true,
    );
  });

  it("neznámé nabití ani zaplnění let neblokuje", () => {
    // Vynechaný let kvůli nečitelnému údaji je horší než let
    // s nejistou baterií.
    assert.equal(
      checkDockReadiness(dock({ batteryPercent: null, storageUsedPercent: null })).ok,
      true,
    );
  });

  it("dron mimo dok přebíjí i vybitou baterii", () => {
    // Důvod má být ten hlavní, ne ten, na který se dřív narazilo.
    const r = checkDockReadiness(dock({ droneInDock: false, batteryPercent: 3 }));
    assert.equal(r.reason, "drone_not_in_dock");
  });
});
