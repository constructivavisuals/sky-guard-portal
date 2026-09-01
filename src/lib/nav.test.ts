import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { NAV_NEEDS, routeNeeds, visibleNavItems, visibleRoutes } from "./nav.ts";
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
  { href: "/zaznamy", needs: "cameras" },
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
      "/zaznamy",
      "/arealy",
    ]);
  });

  it("areál bez kamer nemá záznamy", () => {
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

describe("Záznamy v navigaci", () => {
  // Regrese na to, že se sekce po montáži nezobrazí tam, kde má.
  const POLOZKY_ZAZNAMU = [
    { href: "/zaznamy", needs: "cameras" },
    { href: "/zasahy", needs: "drone" },
  ] as const;

  it("stavba bez dronu Záznamy vidí", () => {
    const out = visibleNavItems(POLOZKY_ZAZNAMU, { drone: false, cameras: true });
    assert.deepEqual(out.map((p) => p.href), ["/zaznamy"]);
  });

  it("areál bez kamer je nevidí", () => {
    const out = visibleNavItems(POLOZKY_ZAZNAMU, { drone: true, cameras: false });
    assert.deepEqual(out.map((p) => p.href), ["/zasahy"]);
  });
});

// ═══ Skutečná tabulka ══════════════════════════════════════════════
// Testy výš jedou na fixture, takže ověřují FILTR, ne pravidla. Přesně
// v té mezeře se rozešly tři kopie tabulky: detekce zmizely areálu bez
// kamer, fixture o tom nic nevěděla a 800 testů zůstalo zelených.

const cesty = (caps: { drone: boolean; cameras: boolean }) =>
  visibleRoutes(
    Object.keys(NAV_NEEDS).map((href) => ({ href })),
    caps,
  ).map((p) => p.href);

describe("Stránky s obrazem", () => {
  // Živý obraz, časová osa i záznamy stojí na kamerách. Kdyby některá
  // z nich v NAV_NEEDS chyběla, routeNeeds() vrátí null a položka se
  // ukáže i areálu bez kamer — tiše, protože výchozí hodnota míří na
  // „radši navíc než chybět". Právě takhle se na /osa zapomnělo.
  for (const href of ["/kamery", "/zive", "/osa", "/zaznamy"]) {
    it(`${href} je vázaná na kamery`, () => {
      assert.equal(routeNeeds(href), "cameras");
    });

    it(`${href} má pravidlo vypsané, ne odvozené z výchozí hodnoty`, () => {
      assert.ok(
        Object.hasOwn(NAV_NEEDS, href),
        `${href} chybí v NAV_NEEDS — ukáže se všude`,
      );
    });
  }
});

describe("NAV_NEEDS", () => {
  it("stavba bez dronu nemá zásahy, lety ani hlídky", () => {
    const out = cesty(siteCapabilities([stavba], stavba));
    for (const href of ["/zasahy", "/lety", "/hlidky"]) {
      assert.equal(out.includes(href), false, `${href} má být skrytá`);
    }
  });

  it("stavba bez dronu detekce má — kamera detekuje člověka sama", () => {
    assert.equal(cesty(siteCapabilities([stavba], stavba)).includes("/detekce"), true);
  });

  it("areál bez kamer detekce má taky — dron je při hlídce pořizuje", () => {
    // Tohle byla ta chyba: detekce visely na kamerách, takže areál
    // s dronem neměl v menu položku, na které jsou jeho vlastní
    // dronové detekce.
    assert.equal(cesty(siteCapabilities([areal], areal)).includes("/detekce"), true);
  });

  it("areál bez kamer nemá záznamy ani bránu", () => {
    const out = cesty(siteCapabilities([areal], areal));
    assert.equal(out.includes("/zaznamy"), false);
    assert.equal(out.includes("/brana"), false);
  });

  it("napříč lokalitami se sjednocuje, nic se neztratí", () => {
    // Klient se stavbou i areálem musí v „všech lokalitách“ vidět
    // obojí — jinak se k půlce portálu nedostane jinak než přepnutím.
    assert.deepEqual(
      cesty(siteCapabilities([stavba, areal], null)),
      Object.keys(NAV_NEEDS),
    );
  });

  it("nastavení a přehled nezmizí ani při nesmyslných schopnostech", () => {
    const out = cesty({ drone: false, cameras: false });
    assert.equal(out.includes("/prehled"), true);
    assert.equal(out.includes("/nastaveni"), true);
  });

  it("neznámá cesta se ukazuje — chybějící položka je horší než přebytečná", () => {
    // Zapomenutý zápis v tabulce nesmí položku schovat: skrytá stránka
    // vypadá jako rozbitý portál a nikdo ji nemá jak najít, kdežto
    // přebytečná je nanejvýš prázdná.
    assert.equal(routeNeeds("/neco-noveho"), null);
    assert.deepEqual(cesty({ drone: false, cameras: false }).length > 0, true);
  });
});

describe("visibleNavItems na dlaždicích", () => {
  it("dlaždice si pravidlo nesou samy — nejsou to cesty", () => {
    const dlazdice = [
      { label: "Detekcí", needs: null },
      { label: "Letů", needs: "drone" as const },
      { label: "Neznámých značek", needs: "cameras" as const },
    ];
    assert.deepEqual(
      visibleNavItems(dlazdice, { drone: false, cameras: true }).map((d) => d.label),
      ["Detekcí", "Neznámých značek"],
    );
  });
});
