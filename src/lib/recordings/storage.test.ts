import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  isSupportedRecordingType,
  recordingPath,
  recordingPlayback,
} from "./storage.ts";

// Cesta je bezpečnostní věc: na první složce stojí čtecí politika nad
// storage.objects. Když se rozejde s tím, co čeká databáze, buď nikdo
// neuvidí nic, nebo — hůř — uvidí cizí.

const SITE = "11111111-1111-1111-1111-111111111111";
const CAM = "22222222-2222-2222-2222-222222222222";

describe("recordingPath", () => {
  it("první složka je lokalita, druhá kamera", () => {
    const p = recordingPath({
      siteId: SITE,
      cameraId: CAM,
      startedAt: new Date("2026-08-27T10:34:53Z"),
      eventType: "motion",
      mediaType: "video/mp4",
    });
    assert.equal(p, `${SITE}/${CAM}/2026/08/27/103453-motion.mp4`);
  });

  it("skládá se v UTC, ne v místním čase", () => {
    // Cestu staví portál i relay a musí vyjít stejně. Místní den je
    // věc zobrazení, ne uložení.
    const p = recordingPath({
      siteId: SITE,
      cameraId: CAM,
      startedAt: new Date("2026-01-01T23:30:00Z"),
      eventType: "regular",
      mediaType: "video/mp4",
    });
    assert.equal(p, `${SITE}/${CAM}/2026/01/01/233000-regular.mp4`);
  });

  it("chybějící typ události nekazí cestu", () => {
    const p = recordingPath({
      siteId: SITE,
      cameraId: CAM,
      startedAt: new Date("2026-08-27T10:00:00Z"),
      eventType: null,
      mediaType: "video/mp4",
    });
    assert.ok(p?.endsWith("100000-unknown.mp4"));
  });

  it("do cesty se nedostane lomítko ani tečka z typu události", () => {
    // Kdyby kamera poslala něco jako "../../jinam", nesmí to změnit
    // složku — první složka je to jediné, na čem stojí autorizace.
    const p = recordingPath({
      siteId: SITE,
      cameraId: CAM,
      startedAt: new Date("2026-08-27T10:00:00Z"),
      eventType: "../../../etc/passwd",
      mediaType: "video/mp4",
    });
    assert.equal(p, `${SITE}/${CAM}/2026/08/27/100000-etcpasswd.mp4`);
    assert.equal(p?.split("/").length, 6);
  });

  it("prázdný typ po očištění spadne na unknown", () => {
    const p = recordingPath({
      siteId: SITE,
      cameraId: CAM,
      startedAt: new Date("2026-08-27T10:00:00Z"),
      eventType: "///",
      mediaType: "video/mp4",
    });
    assert.ok(p?.endsWith("100000-unknown.mp4"));
  });

  it("nepodporovaný typ souboru vrací null", () => {
    // Radši nenahrát než uložit pod příponou, kterou bucket odmítne.
    for (const typ of ["video/x-msvideo", "image/jpeg", "application/dav", ""]) {
      assert.equal(
        recordingPath({
          siteId: SITE,
          cameraId: CAM,
          startedAt: new Date("2026-08-27T10:00:00Z"),
          eventType: "motion",
          mediaType: typ,
        }),
        null,
        typ,
      );
    }
  });

  it("nečitelný čas vrací null, ne cestu s NaN", () => {
    assert.equal(
      recordingPath({
        siteId: SITE,
        cameraId: CAM,
        startedAt: new Date("nesmysl"),
        eventType: "motion",
        mediaType: "video/mp4",
      }),
      null,
    );
  });
});

describe("isSupportedRecordingType", () => {
  it("bere jen to, co přijme bucket", () => {
    assert.equal(isSupportedRecordingType("video/mp4"), true);
    assert.equal(isSupportedRecordingType("video/quicktime"), true);
    assert.equal(isSupportedRecordingType("image/jpeg"), false);
  });
});

describe("recordingPlayback", () => {
  const zaklad = {
    storage_path: `${SITE}/${CAM}/2026/08/27/103453-motion.mp4`,
    uploaded_at: "2026-08-27T10:35:10Z",
    video_expired_at: null as string | null,
  };

  it("nahraný a nevypršelý záznam je přehratelný", () => {
    assert.equal(recordingPlayback(zaklad), "ready");
  });

  it("po lhůtě je vypršelý, i když cesta zůstala", () => {
    // storage_path zůstává jako stopa, kde soubor byl — sám o sobě
    // tedy přehratelnost neznamená.
    assert.equal(
      recordingPlayback({ ...zaklad, video_expired_at: "2026-09-10T03:00:00Z" }),
      "expired",
    );
  });

  it("nepotvrzené nahrání se nesmí tvářit jako hotové", () => {
    assert.equal(recordingPlayback({ ...zaklad, uploaded_at: null }), "pending");
  });

  it("záznam bez cesty je něco jiného než vypršelý", () => {
    assert.equal(
      recordingPlayback({ ...zaklad, storage_path: null, uploaded_at: null }),
      "missing",
    );
  });

  it("vypršení přebíjí i chybějící potvrzení", () => {
    // Když se soubor smazal po lhůtě, je jedno, že se nikdy nepotvrdil.
    assert.equal(
      recordingPlayback({
        storage_path: "x",
        uploaded_at: null,
        video_expired_at: "2026-09-10T03:00:00Z",
      }),
      "expired",
    );
  });
});
