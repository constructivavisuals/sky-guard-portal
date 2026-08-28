import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  issueLiveToken,
  verifyLiveToken,
  LIVE_TOKEN_TTL_SECONDS,
} from "./token.ts";

const SECRET = "testovaci-tajemstvi-zivy-obraz";
const STREAM = "BK024AAPAGB5592";
const TED = new Date("2026-08-28T12:00:00Z");

describe("issueLiveToken", () => {
  it("vydá lístek s dobou platnosti a podpisem", () => {
    const { token, expiresIn } = issueLiveToken({ stream: STREAM, secret: SECRET, now: TED });
    assert.equal(expiresIn, LIVE_TOKEN_TTL_SECONDS);
    assert.match(token, /^\d+\.[0-9a-f]{64}$/);
  });

  it("platí krátce — jen na navázání spojení", () => {
    // Běžící proud drží socket, ne lístek. Delší platnost by jen
    // znamenala, že uniklý lístek jde dlouho použít.
    assert.ok(LIVE_TOKEN_TTL_SECONDS <= 300);
  });
});

describe("verifyLiveToken", () => {
  const { token } = issueLiveToken({ stream: STREAM, secret: SECRET, now: TED });

  it("vlastní lístek projde", () => {
    const check = verifyLiveToken({ stream: STREAM, token, secret: SECRET, now: TED });
    assert.equal(check.valid, true);
  });

  it("lístek na JINOU kameru neprojde", () => {
    // Tohle je celá pointa: bez jména proudu v podpisu by lístek na
    // vlastní kameru otevřel i kameru na cizí stavbě.
    const check = verifyLiveToken({
      stream: "JINA-KAMERA-0001",
      token,
      secret: SECRET,
      now: TED,
    });
    assert.deepEqual(check, { valid: false, reason: "bad_signature" });
  });

  it("po vypršení neprojde", () => {
    const pozde = new Date(TED.getTime() + (LIVE_TOKEN_TTL_SECONDS + 1) * 1000);
    const check = verifyLiveToken({ stream: STREAM, token, secret: SECRET, now: pozde });
    assert.deepEqual(check, { valid: false, reason: "expired" });
  });

  it("na hranici platnosti už neprojde", () => {
    const hranice = new Date(TED.getTime() + LIVE_TOKEN_TTL_SECONDS * 1000);
    assert.equal(
      verifyLiveToken({ stream: STREAM, token, secret: SECRET, now: hranice }).valid,
      false,
    );
  });

  it("cizí tajemství neprojde", () => {
    const check = verifyLiveToken({ stream: STREAM, token, secret: "cizi", now: TED });
    assert.deepEqual(check, { valid: false, reason: "bad_signature" });
  });

  it("zmršený lístek se pozná jako zmršený, ne jako špatný podpis", () => {
    // Rozdíl je v logu na relayi: „malformed“ je pokus, „bad_signature“
    // může být i rozejité tajemství mezi portálem a relayem.
    for (const zmetek of [
      null, undefined, "", "   ", "bez-tecky",
      ".jenpodpis", "0." + "a".repeat(64), "abc.def",
      `${Math.floor(TED.getTime() / 1000) + 60}.kratkypodpis`,
      `${Math.floor(TED.getTime() / 1000) + 60}.` + "A".repeat(64),
    ]) {
      const check = verifyLiveToken({ stream: STREAM, token: zmetek, secret: SECRET, now: TED });
      assert.equal(check.valid, false, String(zmetek));
      if (!check.valid) assert.equal(check.reason, "malformed", String(zmetek));
    }
  });

  it("podvržená doba platnosti neprojde", () => {
    // Prodloužit si lístek posunutím čísla nejde: doba je v podpisu.
    const [exp, sig] = token.split(".");
    const delsi = `${Number(exp) + 3600}.${sig}`;
    const check = verifyLiveToken({ stream: STREAM, token: delsi, secret: SECRET, now: TED });
    assert.deepEqual(check, { valid: false, reason: "bad_signature" });
  });

  it("dva lístky na tutéž kameru v tutéž vteřinu jsou shodné", () => {
    // Není v tom náhoda: relay nemá stav a nesmí být na pořadí vydání
    // závislý.
    const a = issueLiveToken({ stream: STREAM, secret: SECRET, now: TED });
    const b = issueLiveToken({ stream: STREAM, secret: SECRET, now: TED });
    assert.equal(a.token, b.token);
  });
});
