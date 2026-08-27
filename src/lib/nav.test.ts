import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { siteCapabilities } from "./site.ts";

// Schopnosti lokality řídí navigaci i dlaždice na přehledu. Chyba tady
// znamená buď menu s odkazy, které pro lokalitu nic neukážou, nebo —
// hůř — schovanou půlku portálu někomu, kdo na ni má nárok.

const stavba = { has_drone: false, has_cameras: true };
const areal = { has_drone: true, has_cameras: false };
const oboji = { has_drone: true, has_cameras: true };

describe("siteCapabilities", () => {
  it("u vybrané lokality platí její schopnosti", () => {
    assert.deepEqual(siteCapabilities([stavba, areal], stavba), {
      drone: false,
      cameras: true,
    });
    assert.deepEqual(siteCapabilities([stavba, areal], areal), {
      drone: true,
      cameras: false,
    });
  });

  it("„všechny lokality“ jsou sjednocení", () => {
    // Kdo má stavbu i areál, musí v menu vidět obojí — jinak se
    // k půlce portálu nedostane jinak než přepnutím.
    assert.deepEqual(siteCapabilities([stavba, areal], null), {
      drone: true,
      cameras: true,
    });
  });

  it("sjednocení jedné lokality je ta lokalita", () => {
    assert.deepEqual(siteCapabilities([stavba], null), {
      drone: false,
      cameras: true,
    });
  });

  it("bez lokalit se nic neschovává", () => {
    // Prázdný portál, který navíc schová menu, vypadá jako rozbitý.
    assert.deepEqual(siteCapabilities([], null), { drone: true, cameras: true });
  });

  it("lokalita s obojím má obojí", () => {
    assert.deepEqual(siteCapabilities([oboji], oboji), {
      drone: true,
      cameras: true,
    });
  });
});
