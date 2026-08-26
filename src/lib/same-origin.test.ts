import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { checkSameOrigin } from "./same-origin.ts";

/** Hlavičky, jak je pošle prohlížeč z portálu za proxy. */
function headers(over: Record<string, string | null> = {}): Headers {
  const base: Record<string, string> = {
    origin: "https://portal.sky-guard.cz",
    host: "portal.sky-guard.cz",
    "x-forwarded-proto": "https",
  };
  const h = new Headers();
  for (const [key, value] of Object.entries({ ...base, ...over })) {
    if (value !== null) h.set(key, value);
  }
  return h;
}

describe("checkSameOrigin", () => {
  it("vlastní původ projde", () => {
    assert.deepEqual(checkSameOrigin(headers()), {
      ok: true,
      reason: "same_origin",
    });
  });

  it("cizí doména neprojde", () => {
    const r = checkSameOrigin(headers({ origin: "https://zly.example" }));
    assert.equal(r.ok, false);
    assert.equal(r.reason, "cross_origin");
  });

  it("podobná doména neprojde", () => {
    // portal.sky-guard.cz.zly.example je cizí, i když tak nevypadá.
    assert.equal(
      checkSameOrigin(headers({ origin: "https://portal.sky-guard.cz.zly.example" })).ok,
      false,
    );
  });

  it("jiný port neprojde", () => {
    assert.equal(
      checkSameOrigin(headers({ origin: "https://portal.sky-guard.cz:8443" })).ok,
      false,
    );
  });

  it("se známým schématem neprojde http varianta", () => {
    assert.equal(
      checkSameOrigin(headers({ origin: "http://portal.sky-guard.cz" })).ok,
      false,
    );
  });

  it("bez X-Forwarded-Proto se schéma neřeší — jinak by nešel vývoj", () => {
    // Lokálně běží portál na http a hlavičku nikdo nedoplňuje.
    const r = checkSameOrigin(
      headers({
        origin: "http://127.0.0.1:3100",
        host: "127.0.0.1:3100",
        "x-forwarded-proto": null,
      }),
    );
    assert.equal(r.ok, true);
  });

  it("X-Forwarded-Host přebíjí Host", () => {
    // Za proxy nese skutečnou doménu on, ne Host.
    const r = checkSameOrigin(
      headers({ host: "vnitrni-jmeno.local", "x-forwarded-host": "portal.sky-guard.cz" }),
    );
    assert.equal(r.ok, true);
  });

  it("seznam v hlavičce se čte po první hodnotě", () => {
    // Řetěz proxy umí poslat „https, https“.
    const r = checkSameOrigin(
      headers({
        "x-forwarded-proto": "https, https",
        "x-forwarded-host": "portal.sky-guard.cz, vnitrni.local",
      }),
    );
    assert.equal(r.ok, true);
  });

  it("chybějící Origin se bere jako cizí", () => {
    const r = checkSameOrigin(headers({ origin: null }));
    assert.equal(r.ok, false);
    assert.equal(r.reason, "missing_origin");
  });

  it("„null“ jako Origin neprojde", () => {
    // Tohle posílá sandboxovaný iframe — tedy přesně ten útok.
    const r = checkSameOrigin(headers({ origin: "null" }));
    assert.equal(r.ok, false);
    assert.equal(r.reason, "malformed_origin");
  });

  it("bez hostitele se nedá porovnávat", () => {
    const r = checkSameOrigin(headers({ host: null, "x-forwarded-host": null }));
    assert.equal(r.ok, false);
    assert.equal(r.reason, "missing_host");
  });
});
