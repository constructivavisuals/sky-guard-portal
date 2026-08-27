import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  checkDockReadiness,
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

  it("plné úložiště let NEBLOKUJE", () => {
    // Ověřeno u doku: dron vzlétne i s plnou kartou. Zaplněné úložiště
    // znamená, že se nemusí uložit záznam — ne že se nedá letět.
    // Neodletěný zásah je horší ztráta než nepořízená nahrávka.
    for (const zaplneni of [95, 99, 100]) {
      assert.equal(
        checkDockReadiness(dock({ storageUsedPercent: zaplneni })).ok,
        true,
        `${zaplneni} %`,
      );
    }
  });

  it("plné úložiště nezachrání vybitou baterii", () => {
    // Baterie blokuje dál — tam dron opravdu nedoletí.
    assert.equal(
      checkDockReadiness(dock({ storageUsedPercent: 100, batteryPercent: 10 }))
        .reason,
      "low_battery",
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
