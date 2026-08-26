import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  flightTimesFromTrack,
  fromTimestamp,
  mapFlightStatus,
  mediaContentType,
  mediaKindFromSuffix,
  mediaStoragePath,
} from "./sync-rules.ts";
import type { FhTrack } from "./flighthub-tasks.ts";

function track(over: Partial<FhTrack> = {}): FhTrack {
  return {
    trackId: "t1",
    droneSn: "DRONE-1",
    flightDistance: 1234.5,
    flightDuration: 300,
    points: [],
    ...over,
  };
}

describe("mapFlightStatus", () => {
  it("mapuje známé stavy DJI", () => {
    assert.equal(mapFlightStatus("waiting", "pending"), "pending");
    assert.equal(mapFlightStatus("executing", "pending"), "in_progress");
    assert.equal(mapFlightStatus("paused", "pending"), "in_progress");
    assert.equal(mapFlightStatus("success", "in_progress"), "completed");
    assert.equal(mapFlightStatus("terminated", "in_progress"), "aborted");
    assert.equal(mapFlightStatus("timeout", "in_progress"), "aborted");
    assert.equal(mapFlightStatus("starting_failure", "pending"), "failed");
  });

  it("neznámý stav nechává let tam, kde je", () => {
    // Nová hodnota v DJI nesmí znamenat, že se let tiše prohlásí za
    // dokončený.
    assert.equal(mapFlightStatus("neco_noveho", "in_progress"), "in_progress");
    assert.equal(mapFlightStatus(null, "completed"), "completed");
  });
});

describe("mediaKindFromSuffix", () => {
  it("pozná fotku i video bez ohledu na velikost písmen a tečku", () => {
    assert.equal(mediaKindFromSuffix("JPG"), "photo");
    assert.equal(mediaKindFromSuffix(".mp4"), "video");
    assert.equal(mediaKindFromSuffix("MOV"), "video");
    assert.equal(mediaKindFromSuffix("dng"), "photo");
  });

  it("co neumíme zařadit, nestahujeme", () => {
    // DJI vrací i PPK; media_kind má jen photo a video.
    assert.equal(mediaKindFromSuffix("ppk"), null);
    assert.equal(mediaKindFromSuffix(null), null);
    assert.equal(mediaKindFromSuffix(""), null);
  });
});

describe("mediaContentType", () => {
  it("odpovídá tomu, co bucket přijme", () => {
    assert.equal(mediaContentType("jpg"), "image/jpeg");
    assert.equal(mediaContentType("mp4"), "video/mp4");
    assert.equal(mediaContentType("mov"), "video/quicktime");
    assert.equal(mediaContentType("ppk"), null);
  });
});

describe("fromTimestamp", () => {
  it("bere sekundy i milisekundy", () => {
    // DJI posílá obojí podle modelu a nikde to neříká.
    const sekundy = fromTimestamp(1_788_000_000);
    const milisekundy = fromTimestamp(1_788_000_000_000);
    assert.equal(sekundy?.toISOString(), milisekundy?.toISOString());
  });

  it("nesmysly vrací null", () => {
    assert.equal(fromTimestamp(0), null);
    assert.equal(fromTimestamp(-1), null);
    assert.equal(fromTimestamp(Number.NaN), null);
  });
});

describe("flightTimesFromTrack", () => {
  it("začátek a konec bere z krajních bodů trasy", () => {
    // Detail úlohy skutečné časy nevrací — jeho begin_at/end_at jsou
    // plánované.
    const t = flightTimesFromTrack(
      track({
        points: [
          { timestamp: 1_788_000_300, latitude: 50, longitude: 15, height: 40 },
          { timestamp: 1_788_000_000, latitude: 50, longitude: 15, height: 30 },
          { timestamp: 1_788_000_150, latitude: 50, longitude: 15, height: 35 },
        ],
      }),
    );
    assert.equal(t.startedAt?.getTime(), 1_788_000_000_000);
    assert.equal(t.endedAt?.getTime(), 1_788_000_300_000);
  });

  it("délka letu z trasy má přednost před rozdílem časů", () => {
    const t = flightTimesFromTrack(
      track({
        flightDuration: 999,
        points: [
          { timestamp: 1_788_000_000, latitude: 50, longitude: 15, height: 0 },
          { timestamp: 1_788_000_300, latitude: 50, longitude: 15, height: 0 },
        ],
      }),
    );
    assert.equal(t.durationS, 999);
  });

  it("bez délky z trasy se dopočítá z krajních bodů", () => {
    const t = flightTimesFromTrack(
      track({
        flightDuration: null,
        points: [
          { timestamp: 1_788_000_000, latitude: 50, longitude: 15, height: 0 },
          { timestamp: 1_788_000_300, latitude: 50, longitude: 15, height: 0 },
        ],
      }),
    );
    assert.equal(t.durationS, 300);
  });

  it("prázdná trasa nedá časy, ale vzdálenost ano", () => {
    const t = flightTimesFromTrack(track({ points: [], flightDuration: null }));
    assert.equal(t.startedAt, null);
    assert.equal(t.endedAt, null);
    assert.equal(t.durationS, null);
    assert.equal(t.distanceM, 1234.5);
  });

  it("záporné hodnoty se zahazují", () => {
    const t = flightTimesFromTrack(
      track({ flightDistance: -5, flightDuration: -1, points: [] }),
    );
    assert.equal(t.distanceM, null);
    assert.equal(t.durationS, null);
  });
});

describe("mediaStoragePath", () => {
  it("první složka je lokalita, druhá let", () => {
    assert.equal(
      mediaStoragePath("site-1", "flight-2", "media-3", "JPG"),
      "site-1/flight-2/media-3.jpg",
    );
  });

  it("lomítko v id se nesmí dostat do cesty", () => {
    // Jinak by soubor skončil ve složce cizí lokality a čtecí politika
    // by ho pustila komukoli, kdo na ni vidí.
    const path = mediaStoragePath("site-1", "flight-2", "../../jine/x", "jpg");
    assert.equal(path, "site-1/flight-2/jinex.jpg");
    assert.ok(!path.includes(".."));
  });

  it("bez přípony se použije bin", () => {
    assert.equal(
      mediaStoragePath("s", "f", "m", null),
      "s/f/m.bin",
    );
  });
});
