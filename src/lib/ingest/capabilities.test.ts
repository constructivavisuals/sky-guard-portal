import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  classIsExpected,
  normalizeReported,
  planPlateRead,
  type CameraCapabilities,
} from "./capabilities.ts";
import { markUnexpectedClass, unexpectedNote } from "./unexpected.ts";
import type { Json } from "../../types/database.ts";

// Schopnosti kamery. Podstatné je chování ve chvíli, kdy je portál
// nasazený, ale migrace ještě neproběhla — tam se nesmí nic tvrdit.

const PERIMETR: CameraCapabilities = {
  detectsPerson: true,
  detectsVehicle: false,
  readsPlate: false,
};

const BRANA: CameraCapabilities = {
  detectsPerson: true,
  detectsVehicle: true,
  readsPlate: true,
};

const NEZNAME: CameraCapabilities = {
  detectsPerson: null,
  detectsVehicle: null,
  readsPlate: null,
};

describe("classIsExpected", () => {
  it("perimetrová kamera osobu umí, vozidlo ne", () => {
    assert.equal(classIsExpected(PERIMETR, "person"), true);
    assert.equal(classIsExpected(PERIMETR, "vehicle"), false);
  });

  it("brána umí obojí", () => {
    assert.equal(classIsExpected(BRANA, "vehicle"), true);
    assert.equal(classIsExpected(BRANA, "person"), true);
  });

  it("neurčený objekt je očekávaný vždycky", () => {
    // Je to třída „něco se hnulo“, kterou hlásí i kamera, co nic
    // dalšího nerozlišuje.
    assert.equal(classIsExpected(PERIMETR, "unknown"), true);
  });

  it("neznámé schopnosti nic nehlásí", () => {
    // Nasazený kód, nenasazená migrace: jinak by po nasazení každá
    // detekce vozidla vypadala jako závada.
    for (const trida of ["person", "vehicle", "unknown"] as const) {
      assert.equal(classIsExpected(NEZNAME, trida), true, trida);
    }
  });
});

describe("markUnexpectedClass", () => {
  it("očekávanou detekci nechá být", () => {
    const { raw, note } = markUnexpectedClass({
      raw: { model: "yolo" },
      capabilities: PERIMETR,
      objectClass: "person",
    });
    assert.equal(note, null);
    assert.deepEqual(raw, { model: "yolo" });
  });

  it("neočekávanou označí a původní data zachová", () => {
    const { raw, note } = markUnexpectedClass({
      raw: { model: "yolo" },
      capabilities: PERIMETR,
      objectClass: "vehicle",
    });
    assert.equal(note?.unexpected_class, "vehicle");
    assert.equal((raw as Record<string, unknown>).model, "yolo");
    assert.deepEqual(unexpectedNote(raw), {
      unexpected_class: "vehicle",
      camera_can: { person: true, vehicle: false },
    });
  });

  it("raw, které není objekt, se nezahodí", () => {
    // Typ Json slibuje objekt, ale hodnota jde z těla požadavku
    // a z databáze — v běhu tam může být cokoli.
    const { raw } = markUnexpectedClass({
      raw: [1, 2, 3] as unknown as Json,
      capabilities: PERIMETR,
      objectClass: "vehicle",
    });
    assert.deepEqual((raw as Record<string, unknown>).camera_raw, [1, 2, 3]);
    assert.ok(unexpectedNote(raw));
  });

  it("z čistého raw se poznámka nevyčte", () => {
    assert.equal(unexpectedNote({ model: "yolo" }), null);
    assert.equal(unexpectedNote(null), null);
    assert.equal(unexpectedNote("nic"), null);
    // Kamera si může do raw napsat cokoli; poznámka portálu musí mít
    // správný tvar, jinak se ignoruje.
    assert.equal(unexpectedNote({ portal: { unexpected_class: "auto" } }), null);
  });
});

describe("planPlateRead", () => {
  const jista = { plate: "1AB2345", confidence: 0.95 };
  const nejista = { plate: "1AB2345", confidence: 0.4 };

  it("jistá značka od brány stačí, model se nevolá", () => {
    const plan = planPlateRead({
      capabilities: BRANA,
      reported: jista,
      hasImage: true,
    });
    assert.equal(plan.use, "camera");
    assert.equal(plan.use === "camera" && plan.plate, "1AB2345");
  });

  it("nejistá značka pošle věc modelu", () => {
    // Práh je týž, pod kterým se značka nepáruje se seznamem — dvě
    // hranice by znamenaly značku dost dobrou na uložení a málo dobrou
    // na rozhodnutí.
    const plan = planPlateRead({
      capabilities: BRANA,
      reported: nejista,
      hasImage: true,
    });
    assert.equal(plan.use, "model");
    assert.deepEqual(plan.use === "model" && plan.fallback, nejista);
  });

  it("značka bez jistoty se bere jako nejistá", () => {
    const plan = planPlateRead({
      capabilities: BRANA,
      reported: { plate: "1AB2345", confidence: null },
      hasImage: true,
    });
    assert.equal(plan.use, "model");
  });

  it("od kamery bez reads_plate se značka NEBERE", () => {
    // Jinak by šlo z ovládnuté kamery poslat vjezd s vymyšlenou allow
    // značkou a nechat se odbavit.
    const plan = planPlateRead({
      capabilities: PERIMETR,
      reported: jista,
      hasImage: true,
    });
    assert.equal(plan.use, "model");
    assert.equal(plan.use === "model" && plan.fallback, null);
  });

  it("neznámé schopnosti se chovají jako dřív — čte model", () => {
    const plan = planPlateRead({
      capabilities: NEZNAME,
      reported: jista,
      hasImage: true,
    });
    assert.equal(plan.use, "model");
    assert.equal(plan.use === "model" && plan.fallback, null);
  });

  it("bez snímku a bez značky není co číst", () => {
    const plan = planPlateRead({
      capabilities: BRANA,
      reported: null,
      hasImage: false,
    });
    assert.equal(plan.use, "none");
  });

  it("bez snímku je i nejistá značka od brány lepší než nic", () => {
    const plan = planPlateRead({
      capabilities: BRANA,
      reported: nejista,
      hasImage: false,
    });
    assert.equal(plan.use, "model");
    assert.deepEqual(plan.use === "model" && plan.fallback, nejista);
  });

  it("perimetrová kamera bez snímku nemá co nabídnout", () => {
    const plan = planPlateRead({
      capabilities: PERIMETR,
      reported: jista,
      hasImage: false,
    });
    assert.equal(plan.use, "none");
  });
});

describe("normalizeReported", () => {
  it("mezery a pomlčky mizí, písmena jdou na velká", () => {
    // Kamera, která pošle „1ab 2345“, nesmí skončit jinde než model,
    // co přečte totéž.
    assert.deepEqual(normalizeReported("1ab 2345", 0.9), {
      plate: "1AB2345",
      confidence: 0.9,
    });
  });

  it("značka bez písmen a číslic je nic", () => {
    assert.equal(normalizeReported("---", 0.9), null);
    assert.equal(normalizeReported("", 0.9), null);
  });

  it("nesmyslná jistota se zahodí, značka zůstane", () => {
    assert.deepEqual(normalizeReported("1AB2345", "hodně"), {
      plate: "1AB2345",
      confidence: null,
    });
  });

  it("co není řetězec, není značka", () => {
    assert.equal(normalizeReported(12345, 0.9), null);
    assert.equal(normalizeReported(null, null), null);
  });
});
