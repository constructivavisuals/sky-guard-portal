import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  isPlateReliable,
  matchPlate,
  normalizePlate,
  PLATE_CONFIDENCE_MIN,
} from "./plates.ts";

describe("normalizePlate", () => {
  it("stejná značka zapsaná různě dá týž tvar", () => {
    for (const varianta of ["1AB 2345", "1ab2345", "1AB-2345", "1.a.b/2345"]) {
      assert.equal(normalizePlate(varianta), "1AB2345", varianta);
    }
  });

  it("prázdný vstup dá prázdno", () => {
    assert.equal(normalizePlate(""), "");
    assert.equal(normalizePlate("   "), "");
    assert.equal(normalizePlate("---"), "");
  });

  it("nechává jen ASCII písmena a číslice", () => {
    // Shodně s `[^a-zA-Z0-9]` v SQL. Diakritika vypadne, ne se převede.
    assert.equal(normalizePlate("ČAU 123"), "AU123");
    assert.equal(normalizePlate("1AB 2345 🚚"), "1AB2345");
  });
});

describe("isPlateReliable", () => {
  it("nad prahem se věří", () => {
    assert.equal(isPlateReliable("1AB2345", 0.95), true);
    assert.equal(isPlateReliable("1AB2345", PLATE_CONFIDENCE_MIN), true);
  });

  it("pod prahem ne", () => {
    assert.equal(isPlateReliable("1AB2345", PLATE_CONFIDENCE_MIN - 0.01), false);
    assert.equal(isPlateReliable("1AB2345", 0), false);
  });

  it("chybějící jistota není totéž co vysoká", () => {
    assert.equal(isPlateReliable("1AB2345", null), false);
    assert.equal(isPlateReliable("1AB2345", Number.NaN), false);
  });

  it("bez značky nikdy", () => {
    assert.equal(isPlateReliable(null, 1), false);
  });
});

describe("matchPlate", () => {
  const seznam = [
    { id: "k1", plate: "1AB 2345", label: "Dodávka", list_type: "allow" as const },
    { id: "k2", plate: "9zz-0000", label: "Vyhozený subdodavatel", list_type: "deny" as const },
  ];

  it("najde známé vozidlo bez ohledu na zápis", () => {
    const m = matchPlate("1ab2345", 0.9, seznam);
    assert.equal(m.verdict, "allow");
    assert.equal(m.knownPlateId, "k1");
    assert.equal(m.knownLabel, "Dodávka");
  });

  it("najde nežádoucí i s jinak zapsanou značkou v seznamu", () => {
    assert.equal(matchPlate("9ZZ 0000", 0.9, seznam).verdict, "deny");
  });

  it("značka mimo seznam je neznámá, ne nepřečtená", () => {
    const m = matchPlate("5XY1111", 0.9, seznam);
    assert.equal(m.verdict, "unknown");
    assert.equal(m.knownPlateId, null);
  });

  it("nepřečtená značka je unread, ne unknown", () => {
    assert.equal(matchPlate(null, null, seznam).verdict, "unread");
  });

  it("nejistá značka se se seznamem nepáruje vůbec", () => {
    // I když text sedí na allow: odbavit cizí auto jako známé kvůli
    // špatnému přečtení je díra v ostraze.
    const m = matchPlate("1AB2345", 0.4, seznam);
    assert.equal(m.verdict, "unread");
    assert.equal(m.knownPlateId, null);
  });

  it("prázdný seznam dělá ze všeho neznámou značku", () => {
    assert.equal(matchPlate("1AB2345", 0.9, []).verdict, "unknown");
  });
});
