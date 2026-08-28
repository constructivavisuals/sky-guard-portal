import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isStreamQuality, liveSocketUrl, streamName } from "./stream.ts";

describe("streamName", () => {
  it("hlavní proud je holé sériové číslo", () => {
    assert.equal(streamName("BK024AAPAGB5592", "main"), "BK024AAPAGB5592");
  });

  it("vedlejší má příponu _sub — musí sedět s live.py", () => {
    assert.equal(streamName("BK024AAPAGB5592", "sub"), "BK024AAPAGB5592_sub");
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

  it("koncové lomítko v základu nezdvojí cestu", () => {
    const url = liveSocketUrl({
      baseUrl: "https://kamery.sky-guard.cz/",
      stream: "CAM1",
      token: "1.a",
    });
    assert.ok(!url.includes("//api/ws"));
  });

  it("jméno proudu i lístek se kódují", () => {
    // Sériové číslo se znakem, který by v adrese ukončil parametr.
    const url = liveSocketUrl({
      baseUrl: "https://k.cz",
      stream: "a&b=c",
      token: "1.a+b",
    });
    const params = new URL(url.replace("wss:", "https:")).searchParams;
    assert.equal(params.get("src"), "a&b=c");
    assert.equal(params.get("token"), "1.a+b");
  });
});

describe("isStreamQuality", () => {
  it("pustí jen známé hodnoty", () => {
    assert.equal(isStreamQuality("main"), true);
    assert.equal(isStreamQuality("sub"), true);
    for (const spatne of ["", "MAIN", "hlavni", null, undefined, 1]) {
      assert.equal(isStreamQuality(spatne), false, String(spatne));
    }
  });
});
