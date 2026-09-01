import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  liveSocketUrl,
  playbackSocketUrl,
  playbackStreamName,
  streamName,
} from "./stream.ts";

const SERIAL = "BK024AAPAGB5592";

describe("streamName", () => {
  it("vždycky vedlejší proud — hlavní se přes tunel rozpadá", () => {
    assert.equal(streamName(SERIAL), `${SERIAL}_sub`);
  });
});

describe("playbackStreamName", () => {
  // Zkopírováno z JMENO_RE v playback.py. Kdyby se obě strany rozešly,
  // projeví se to jako „neplatný lístek“ — tedy stejně jako špatné
  // tajemství, a hledalo by se to v prostředí místo v kódu.
  const RELAY_RE = /^([A-Za-z0-9_-]{1,64})-pb-(\d{9,12})$/;

  it("tvar sedí s tím, co relay rozebírá", () => {
    const jmeno = playbackStreamName(SERIAL, 1788000000);
    assert.equal(jmeno, `${SERIAL}-pb-1788000000`);
    assert.match(jmeno, RELAY_RE);
  });

  it("epocha se ořízne na celé sekundy", () => {
    // Milisekundy by daly jiné jméno při každém překreslení a lístek
    // by se přestal trefovat do už otevřeného proudu.
    assert.equal(
      playbackStreamName(SERIAL, 1788000000.987),
      `${SERIAL}-pb-1788000000`,
    );
  });

  it("jiný čas je jiné jméno — na tom stojí platnost lístku", () => {
    assert.notEqual(
      playbackStreamName(SERIAL, 1788000000),
      playbackStreamName(SERIAL, 1788000001),
    );
  });

  it("živý proud se za přehrávání nevydá", () => {
    assert.doesNotMatch(streamName(SERIAL), RELAY_RE);
  });
});

describe("liveSocketUrl", () => {
  it("z https udělá wss", () => {
    // Pod HTTPS portálem prohlížeč nešifrované spojení nepustí.
    const url = liveSocketUrl({
      baseUrl: "https://kamery.sky-guard.cz",
      stream: "CAM1",
      token: "1.a",
    });
    assert.ok(url.startsWith("wss://kamery.sky-guard.cz/api/ws?"));
  });

  it("z http udělá ws — pro dočasné prostředí bez certifikátu", () => {
    const url = liveSocketUrl({
      baseUrl: "http://100.72.12.109:8080",
      stream: "CAM1",
      token: "1.a",
    });
    assert.ok(url.startsWith("ws://100.72.12.109:8080/api/ws?"));
  });

  it("koncové lomítko nezdvojí cestu", () => {
    const url = liveSocketUrl({
      baseUrl: "https://kamery.sky-guard.cz/",
      stream: "CAM1",
      token: "1.a",
    });
    assert.ok(url.startsWith("wss://kamery.sky-guard.cz/api/ws?"));
  });
});

describe("playbackSocketUrl", () => {
  it("jde pod prefix /zaznam — tam sedí druhá instance go2rtc", () => {
    const url = playbackSocketUrl({
      baseUrl: "https://kamery.sky-guard.cz",
      stream: `${SERIAL}-pb-1788000000`,
      token: "1.a",
    });
    assert.ok(url.startsWith("wss://kamery.sky-guard.cz/zaznam/api/ws?"));
  });

  it("jméno proudu i lístek jdou v dotazu", () => {
    const url = new URL(
      playbackSocketUrl({
        baseUrl: "https://k.cz",
        stream: "CAM1-pb-1788000000",
        token: "999.abc",
      }).replace("wss:", "https:"),
    );
    assert.equal(url.searchParams.get("src"), "CAM1-pb-1788000000");
    assert.equal(url.searchParams.get("token"), "999.abc");
  });
});
