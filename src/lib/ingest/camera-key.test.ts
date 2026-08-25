import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  cameraKeyFingerprint,
  deriveCameraKey,
  INITIAL_KEY_VERSION,
} from "./camera-key.ts";

const MASTER = "hlavni-tajemstvi-jen-pro-testy";

describe("deriveCameraKey", () => {
  it("je stabilní — stejné vstupy dají stejný klíč", () => {
    assert.equal(
      deriveCameraKey(MASTER, "CAM-VV-01"),
      deriveCameraKey(MASTER, "CAM-VV-01"),
    );
  });

  it("dvě kamery dostanou různý klíč", () => {
    assert.notEqual(
      deriveCameraKey(MASTER, "CAM-VV-01"),
      deriveCameraKey(MASTER, "CAM-VV-02"),
    );
  });

  it("vyšší verze zneplatní klíč jen té jedné kamery", () => {
    const stary = deriveCameraKey(MASTER, "CAM-VV-01", 1);
    const novy = deriveCameraKey(MASTER, "CAM-VV-01", 2);
    assert.notEqual(stary, novy);
    // Soused zůstal beze změny.
    assert.equal(
      deriveCameraKey(MASTER, "CAM-VV-02", 1),
      deriveCameraKey(MASTER, "CAM-VV-02", 1),
    );
  });

  it("jiné hlavní tajemství dá jiný klíč", () => {
    assert.notEqual(
      deriveCameraKey(MASTER, "CAM-VV-01"),
      deriveCameraKey(`${MASTER}-jine`, "CAM-VV-01"),
    );
  });

  it("klíč neobsahuje hlavní tajemství", () => {
    const key = deriveCameraKey(MASTER, "CAM-VV-01");
    assert.ok(!key.includes(MASTER));
    assert.match(key, /^[0-9a-f]{64}$/);
  });

  it("tečka v sériovém čísle se odmítne — jinak by šly splést verze", () => {
    // "CAM-1" + verze 2.1 vs "CAM-1.2" + verze 1 by daly stejný vstup.
    assert.throws(() => deriveCameraKey(MASTER, "CAM-1.2"));
  });

  it("nesmyslná verze se odmítne", () => {
    assert.throws(() => deriveCameraKey(MASTER, "CAM-1", 0));
    assert.throws(() => deriveCameraKey(MASTER, "CAM-1", 1.5));
    assert.throws(() => deriveCameraKey(MASTER, "CAM-1", -1));
  });

  it("výchozí verze je 1", () => {
    assert.equal(
      deriveCameraKey(MASTER, "CAM-1"),
      deriveCameraKey(MASTER, "CAM-1", INITIAL_KEY_VERSION),
    );
  });
});

describe("cameraKeyFingerprint", () => {
  it("otisk je hex SHA-256 a neprozradí klíč", () => {
    const key = deriveCameraKey(MASTER, "CAM-VV-01");
    const otisk = cameraKeyFingerprint(key);
    assert.match(otisk, /^[0-9a-f]{64}$/);
    assert.notEqual(otisk, key);
  });

  it("různé klíče mají různý otisk", () => {
    assert.notEqual(
      cameraKeyFingerprint(deriveCameraKey(MASTER, "CAM-1")),
      cameraKeyFingerprint(deriveCameraKey(MASTER, "CAM-2")),
    );
  });
});
