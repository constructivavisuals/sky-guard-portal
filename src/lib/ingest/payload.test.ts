import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { parseDetectionPayload } from "./payload.ts";

/** Čas serveru ve všech testech — detected_at se poměřuje proti němu. */
const NOW = new Date("2026-08-24T22:00:00Z");

function valid(overrides: Record<string, unknown> = {}) {
  return {
    camera_serial: "CAM-001",
    detected_at: "2026-08-24T22:00:00Z",
    object_class: "person",
    confidence: 0.87,
    raw: { model: "yolo-v8", boxes: [] },
    ...overrides,
  };
}

describe("parseDetectionPayload — platné vstupy", () => {
  it("úplný payload projde", () => {
    const result = parseDetectionPayload(valid(), NOW);
    assert.ok(result.ok);
    assert.equal(result.payload.cameraSerial, "CAM-001");
    assert.equal(result.payload.objectClass, "person");
    assert.equal(result.payload.confidence, 0.87);
    assert.equal(
      result.payload.detectedAt.toISOString(),
      "2026-08-24T22:00:00.000Z",
    );
  });

  it("chybějící object_class je 'unknown'", () => {
    const result = parseDetectionPayload(valid({ object_class: undefined }), NOW);
    assert.ok(result.ok);
    assert.equal(result.payload.objectClass, "unknown");
  });

  it("chybějící confidence je null, ne nula", () => {
    // Nula by znamenala "detektor si je jistý, že tam nic není".
    const result = parseDetectionPayload(valid({ confidence: undefined }), NOW);
    assert.ok(result.ok);
    assert.equal(result.payload.confidence, null);
  });

  it("chybějící raw je prázdný objekt", () => {
    const result = parseDetectionPayload(valid({ raw: undefined }), NOW);
    assert.ok(result.ok);
    assert.deepEqual(result.payload.raw, {});
  });

  it("okolní mezery v sériovém čísle se ořezávají", () => {
    const result = parseDetectionPayload(valid({ camera_serial: "  CAM-001 " }), NOW);
    assert.ok(result.ok);
    assert.equal(result.payload.cameraSerial, "CAM-001");
  });

  it("krajní hodnoty confidence 0 a 1 projdou", () => {
    for (const confidence of [0, 1]) {
      const result = parseDetectionPayload(valid({ confidence }), NOW);
      assert.ok(result.ok);
      assert.equal(result.payload.confidence, confidence);
    }
  });
});

describe("parseDetectionPayload — neplatné vstupy", () => {
  const cases: [string, unknown][] = [
    ["tělo není objekt", "CAM-001"],
    ["tělo je pole", [{ camera_serial: "CAM-001" }]],
    ["tělo je null", null],
  ];

  for (const [name, body] of cases) {
    it(`${name} → chyba`, () => {
      const result = parseDetectionPayload(body, NOW);
      assert.equal(result.ok, false);
    });
  }

  it("chybějící camera_serial → chyba", () => {
    const result = parseDetectionPayload(valid({ camera_serial: undefined }), NOW);
    assert.equal(result.ok, false);
  });

  it("prázdný camera_serial → chyba", () => {
    const result = parseDetectionPayload(valid({ camera_serial: "   " }), NOW);
    assert.equal(result.ok, false);
  });

  it("neznámá object_class → chyba", () => {
    const result = parseDetectionPayload(valid({ object_class: "drone" }), NOW);
    assert.equal(result.ok, false);
  });

  it("confidence mimo 0–1 → chyba", () => {
    assert.equal(parseDetectionPayload(valid({ confidence: 1.5 }), NOW).ok, false);
    assert.equal(parseDetectionPayload(valid({ confidence: -0.1 }), NOW).ok, false);
  });

  it("confidence jako řetězec → chyba", () => {
    const result = parseDetectionPayload(valid({ confidence: "0.9" }), NOW);
    assert.equal(result.ok, false);
  });

  it("nesmyslný detected_at → chyba", () => {
    const result = parseDetectionPayload(valid({ detected_at: "včera večer" }), NOW);
    assert.equal(result.ok, false);
  });

  it("raw jako pole → chyba", () => {
    const result = parseDetectionPayload(valid({ raw: [1, 2, 3] }), NOW);
    assert.equal(result.ok, false);
  });

  it("chyby se vracejí všechny naráz", () => {
    const result = parseDetectionPayload(
      {
        camera_serial: "",
        object_class: "drone",
        confidence: 5,
      },
      NOW,
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.errors.length, 3);
  });
});

describe("parseDetectionPayload — detected_at je jen hlášený údaj", () => {
  it("chybějící detected_at bere čas serveru, ne systémový čas", () => {
    const result = parseDetectionPayload(valid({ detected_at: undefined }), NOW);
    assert.ok(result.ok);
    assert.equal(result.payload.detectedAt.getTime(), NOW.getTime());
  });

  it("čas těsně uvnitř tolerance projde", () => {
    const at = new Date(NOW.getTime() - 299_000).toISOString();
    const result = parseDetectionPayload(valid({ detected_at: at }), NOW);
    assert.ok(result.ok);
  });

  it("čas starší než tolerance se odmítne", () => {
    const at = new Date(NOW.getTime() - 301_000).toISOString();
    const result = parseDetectionPayload(valid({ detected_at: at }), NOW);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.errors.join(" "), /detected_at/);
  });

  it("čas v budoucnosti se odmítne stejně jako v minulosti", () => {
    // Jinak by šlo poslat detekci s časem mimo hlídané okno a nechat ji
    // potlačit jako „mimo ostrý režim“.
    const at = new Date(NOW.getTime() + 3_600_000).toISOString();
    const result = parseDetectionPayload(valid({ detected_at: at }), NOW);
    assert.equal(result.ok, false);
  });

  it("odmítnutí je chyba, ne tiché přepsání na teď", () => {
    const at = new Date(NOW.getTime() - 86_400_000).toISOString();
    const result = parseDetectionPayload(valid({ detected_at: at }), NOW);
    assert.equal(result.ok, false);
  });
});
