import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { computeSignature } from "./signature.ts";
import { verifyRelay } from "./verify-relay.ts";

const NOVE = "relay-nove";
const STARE = "relay-stare";
const NOW = new Date("2026-08-27T10:00:00Z");
const TS = String(Math.floor(NOW.getTime() / 1000));
const BODY = '{"camera_serial":"BK024AAPAGB5592"}';

const overit = (secrets: string[], signature: string, rawBody = BODY) =>
  verifyRelay({ rawBody, signature, timestamp: TS, now: NOW, secrets });

describe("verifyRelay", () => {
  it("projde na aktuální tajemství", () => {
    const r = overit([NOVE, STARE], computeSignature(NOVE, TS, BODY));
    assert.equal(r.valid, true);
    assert.equal(r.valid && r.usedPrevious, false);
  });

  it("během rotace projde i na předchozí a je to poznat", () => {
    // Bez tohohle příznaku by nešlo zjistit, kdy se smí stará hodnota
    // smazat — a mazalo by se poslepu.
    const r = overit([NOVE, STARE], computeSignature(STARE, TS, BODY));
    assert.equal(r.valid, true);
    assert.equal(r.valid && r.usedPrevious, true);
  });

  it("bez tajemství neprojde nic", () => {
    assert.equal(overit([], computeSignature(NOVE, TS, BODY)).valid, false);
  });

  it("změněné tělo podpis neunese", () => {
    // Podepisuje se `${timestamp}.${tělo}`, ne jen čas — jinak by šel
    // odchycený podpis nalepit na cizí obsah.
    const r = overit([NOVE], computeSignature(NOVE, TS, BODY), '{"camera_serial":"JINA"}');
    assert.equal(r.valid, false);
  });

  it("prázdné tělo se podepsat dá — konfigurace se tahá GETem", () => {
    const r = overit([NOVE], computeSignature(NOVE, TS, ""), "");
    assert.equal(r.valid, true);
  });
});
