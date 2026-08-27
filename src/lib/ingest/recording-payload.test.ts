import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  MAX_RECORDING_AGE_DAYS,
  mayIssueUploadUrl,
  parseRecordingAnnounce,
  parseRecordingConfirm,
} from "./recording-payload.ts";

const NOW = new Date("2026-08-27T12:00:00Z");

function valid(prepis: Record<string, unknown> = {}) {
  return {
    camera_serial: "BK024AAPAGB5592",
    sd_file_path: "cam-stavba-01/2026-08-27/001/dav/10/10.00.00-10.00.43[M][0@0][0].dav",
    started_at: "2026-08-27T10:00:00Z",
    ended_at: "2026-08-27T10:00:43Z",
    event_type: "motion",
    media_type: "video/mp4",
    ...prepis,
  };
}

describe("parseRecordingAnnounce", () => {
  it("platné ohlášení projde", () => {
    const r = parseRecordingAnnounce(valid(), NOW);
    assert.ok(r.ok);
    assert.equal(r.payload.cameraSerial, "BK024AAPAGB5592");
    assert.equal(r.payload.eventType, "motion");
    assert.equal(r.payload.endedAt?.toISOString(), "2026-08-27T10:00:43.000Z");
  });

  it("záznam bez konce projde — kamera ho poslat nemusí", () => {
    const r = parseRecordingAnnounce(valid({ ended_at: undefined }), NOW);
    assert.ok(r.ok);
    assert.equal(r.payload.endedAt, null);
  });

  it("starý záznam projde, na rozdíl od detekce", () => {
    // Soubor leží ve frontě relaye, dokud se nenahraje. Odmítnout ho
    // kvůli stáří by znamenalo zahodit záznam, který existuje.
    const predTydnem = new Date(NOW.getTime() - 7 * 86_400_000).toISOString();
    const r = parseRecordingAnnounce(valid({ started_at: predTydnem }), NOW);
    assert.ok(r.ok);
  });

  const spatne: [string, Record<string, unknown>, RegExp][] = [
    ["chybí sériové číslo", { camera_serial: "" }, /camera_serial/],
    ["chybí cesta", { sd_file_path: "" }, /sd_file_path/],
    ["cesta s ..", { sd_file_path: "a/../b.dav" }, /sd_file_path/],
    ["chybí začátek", { started_at: undefined }, /started_at/],
    ["nesmyslný začátek", { started_at: "včera" }, /started_at/],
    ["začátek v budoucnu", { started_at: "2026-08-27T13:00:00Z" }, /budoucnost/],
    [
      "příliš starý začátek",
      { started_at: new Date(NOW.getTime() - (MAX_RECORDING_AGE_DAYS + 1) * 86_400_000).toISOString() },
      /starší/,
    ],
    ["konec před začátkem", { ended_at: "2026-08-27T09:00:00Z" }, /ended_at/],
    ["nepodporovaný typ", { media_type: "video/x-msvideo" }, /media_type/],
    ["chybějící typ", { media_type: undefined }, /media_type/],
  ];

  for (const [nazev, prepis, vzor] of spatne) {
    it(`odmítne: ${nazev}`, () => {
      const r = parseRecordingAnnounce(valid(prepis), NOW);
      assert.equal(r.ok, false, nazev);
      assert.ok(
        r.ok === false && r.errors.some((e) => vzor.test(e)),
        r.ok === false ? r.errors.join(" | ") : "",
      );
    });
  }

  it("tělo, které není objekt, se odmítne", () => {
    assert.equal(parseRecordingAnnounce("nic", NOW).ok, false);
    assert.equal(parseRecordingAnnounce([1, 2], NOW).ok, false);
  });
});

describe("parseRecordingConfirm", () => {
  it("UUID projde", () => {
    const r = parseRecordingConfirm({
      recording_id: "dddddddd-0000-0000-0000-00000000f005",
    });
    assert.ok(r.ok);
  });

  it("cokoli jiného ne", () => {
    for (const id of ["", "123", undefined, 42]) {
      assert.equal(parseRecordingConfirm({ recording_id: id }).ok, false, String(id));
    }
  });
});

describe("mayIssueUploadUrl", () => {
  it("nedokončený pokus se smí zopakovat", () => {
    assert.equal(mayIssueUploadUrl("pending"), true);
    assert.equal(mayIssueUploadUrl("missing"), true);
  });

  it("na hotový ani vypršelý záznam se adresa nevystaví", () => {
    // Odchycené ohlášení by jinak dalo možnost přepsat existující
    // soubor — levný způsob, jak zaměnit důkaz.
    assert.equal(mayIssueUploadUrl("ready"), false);
    assert.equal(mayIssueUploadUrl("expired"), false);
  });
});
