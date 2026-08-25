import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  base64ByteLength,
  MAX_IMAGE_BYTES,
  parsePassagePayload,
} from "./passage-payload.ts";

const NOW = new Date("2026-09-01T22:00:00Z");
const MALY_OBRAZEK = Buffer.from("x".repeat(100)).toString("base64");

function valid(overrides: Record<string, unknown> = {}) {
  return {
    camera_serial: "CAM-BRANA",
    passed_at: NOW.toISOString(),
    image: { media_type: "image/jpeg", data: MALY_OBRAZEK },
    ...overrides,
  };
}

describe("base64ByteLength", () => {
  it("odpovídá skutečné délce po dekódování", () => {
    for (const delka of [1, 2, 3, 100, 1001]) {
      const b64 = Buffer.alloc(delka).toString("base64");
      assert.equal(base64ByteLength(b64), delka, `délka ${delka}`);
    }
  });
});

describe("parsePassagePayload", () => {
  it("platný vstup projde", () => {
    const r = parsePassagePayload(valid(), NOW);
    assert.ok(r.ok);
    assert.equal(r.payload.cameraSerial, "CAM-BRANA");
    assert.equal(r.payload.image?.mediaType, "image/jpeg");
  });

  it("vjezd bez snímku je regulérní", () => {
    const r = parsePassagePayload(valid({ image: undefined }), NOW);
    assert.ok(r.ok);
    assert.equal(r.payload.image, null);
  });

  it("chybějící passed_at bere čas serveru", () => {
    const r = parsePassagePayload(valid({ passed_at: undefined }), NOW);
    assert.ok(r.ok);
    assert.equal(r.payload.passedAt.getTime(), NOW.getTime());
  });

  const bad: [string, Record<string, unknown>, RegExp][] = [
    ["chybí sériové číslo", { camera_serial: "" }, /camera_serial/],
    ["čas mimo toleranci", { passed_at: "2026-09-01T20:00:00Z" }, /passed_at/],
    ["čas v budoucnu", { passed_at: "2026-09-02T22:00:00Z" }, /passed_at/],
    ["nesmyslný čas", { passed_at: "včera" }, /passed_at/],
    [
      "nepodporovaný typ obrázku",
      { image: { media_type: "image/gif", data: MALY_OBRAZEK } },
      /media_type/,
    ],
    [
      "data URL místo čistého base64",
      { image: { media_type: "image/jpeg", data: `data:image/jpeg;base64,${MALY_OBRAZEK}` } },
      /base64/,
    ],
    [
      "prázdná data",
      { image: { media_type: "image/jpeg", data: "" } },
      /base64/,
    ],
    ["raw jako pole", { raw: [1, 2] }, /raw/],
  ];

  for (const [name, override, vzor] of bad) {
    it(`${name} → chyba`, () => {
      const r = parsePassagePayload(valid(override), NOW);
      assert.equal(r.ok, false);
      if (!r.ok) assert.match(r.errors.join(" "), vzor);
    });
  }

  it("moc velký snímek se odmítne bez dekódování", () => {
    // Řetězec se jen změří, ne dekóduje — o to celému stropu jde.
    const velky = "A".repeat(Math.ceil(((MAX_IMAGE_BYTES + 1000) * 4) / 3));
    const r = parsePassagePayload(
      valid({ image: { media_type: "image/jpeg", data: velky } }),
      NOW,
    );
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.errors.join(" "), /větší než/);
  });

  it("chyby se vracejí všechny naráz", () => {
    const r = parsePassagePayload(
      { camera_serial: "", passed_at: "nesmysl", raw: [] },
      NOW,
    );
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.errors.length, 3);
  });
});
