import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { visibleNavItems } from "./nav.ts";
import { siteCapabilities } from "./site.ts";

// Filtr navigace a schopnosti lokality. Obojí je čisté schválně:
// volá to server (přehled) i klient (sidebar, spodní lišta), a kdyby
// to bydlelo v "use client" modulu, dostal by server jen klientskou
// referenci a spadlo by to za běhu. Přesně to se jednou stalo.

const stavba = { has_drone: false, has_cameras: true };
const areal = { has_drone: true, has_cameras: false };
const oboji = { has_drone: true, has_cameras: true };

const POLOZKY = [
  { href: "/prehled", needs: null },
  { href: "/detekce", needs: "cameras" },
  { href: "/zasahy", needs: "drone" },
  { href: "/lety", needs: "drone" },
  { href: "/arealy", needs: null },
] as const;

const hrefy = (caps: { drone: boolean; cameras: boolean }) =>
  visibleNavItems(POLOZKY, caps).map((p) => p.href);

describe("visibleNavItems", () => {
  it("stavba bez dronu nemá zásahy ani lety", () => {
    assert.deepEqual(hrefy({ drone: false, cameras: true }), [
      "/prehled",
      "/detekce",
      "/arealy",
    ]);
  });

  it("areál bez kamer nemá detekce", () => {
    assert.deepEqual(hrefy({ drone: true, cameras: false }), [
      "/prehled",
      "/zasahy",
      "/lety",
      "/arealy",
    ]);
  });

  it("s obojím projde všechno", () => {
    assert.equal(hrefy({ drone: true, cameras: true }).length, POLOZKY.length);
  });

  it("bez schopností zůstanou jen položky bez podmínky", () => {
    // Nemá nastat (CHECK v databázi to nedovolí), ale filtr se na to
    // nesmí spoléhat — jinak by při chybě zmizelo i Nastavení.
    assert.deepEqual(hrefy({ drone: false, cameras: false }), [
      "/prehled",
      "/arealy",
    ]);
  });

  it("pořadí zůstává, filtr nic nepřerovnává", () => {
    const out = hrefy({ drone: true, cameras: true });
    assert.deepEqual(out, POLOZKY.map((p) => p.href));
  });
});

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
