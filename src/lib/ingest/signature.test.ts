import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  DEFAULT_TOLERANCE_SECONDS,
  computeSignature,
  signedPayload,
  verifySignature,
  publicFailureReason,
} from "./signature.ts";

const SECRET = "0123456789abcdef0123456789abcdef";
const BODY = JSON.stringify({ camera_serial: "CAM-001", object_class: "person" });
const NOW = new Date("2026-08-24T22:00:00Z");
const TIMESTAMP = String(Math.floor(NOW.getTime() / 1000));

function verify(overrides: Partial<Parameters<typeof verifySignature>[0]> = {}) {
  return verifySignature({
    rawBody: BODY,
    timestamp: TIMESTAMP,
    signature: computeSignature(SECRET, TIMESTAMP, BODY),
    secret: SECRET,
    now: NOW,
    ...overrides,
  });
}

describe("verifySignature — platný požadavek", () => {
  it("správný podpis projde", () => {
    assert.deepEqual(verify(), { valid: true });
  });

  it("prefix sha256= je povolený", () => {
    const signature = `sha256=${computeSignature(SECRET, TIMESTAMP, BODY)}`;
    assert.deepEqual(verify({ signature }), { valid: true });
  });

  it("velká písmena v hexu projdou", () => {
    const signature = computeSignature(SECRET, TIMESTAMP, BODY).toUpperCase();
    assert.deepEqual(verify({ signature }), { valid: true });
  });

  it("podepisuje se timestamp i tělo, ne jen tělo", () => {
    assert.equal(signedPayload(TIMESTAMP, BODY), `${TIMESTAMP}.${BODY}`);
  });
});

describe("verifySignature — chybějící a poškozené hlavičky", () => {
  it("bez podpisu neprojde", () => {
    assert.deepEqual(verify({ signature: null }), {
      valid: false,
      reason: "missing_signature",
    });
  });

  it("bez časového razítka neprojde", () => {
    assert.deepEqual(verify({ timestamp: null }), {
      valid: false,
      reason: "missing_timestamp",
    });
  });

  it("nečíselné razítko neprojde", () => {
    assert.deepEqual(verify({ timestamp: "2026-08-24T22:00:00Z" }), {
      valid: false,
      reason: "malformed_timestamp",
    });
  });

  it("podpis jiné délky neprojde", () => {
    assert.deepEqual(verify({ signature: "abcd" }), {
      valid: false,
      reason: "malformed_signature",
    });
  });

  it("podpis mimo hex neprojde", () => {
    assert.deepEqual(verify({ signature: "z".repeat(64) }), {
      valid: false,
      reason: "malformed_signature",
    });
  });
});

describe("verifySignature — ochrana proti replay", () => {
  it("požadavek těsně pod hranicí projde", () => {
    const now = new Date(NOW.getTime() + (DEFAULT_TOLERANCE_SECONDS - 1) * 1_000);
    assert.deepEqual(verify({ now }), { valid: true });
  });

  it("požadavek starší než 5 minut neprojde", () => {
    const now = new Date(NOW.getTime() + (DEFAULT_TOLERANCE_SECONDS + 1) * 1_000);
    assert.deepEqual(verify({ now }), {
      valid: false,
      reason: "stale_timestamp",
    });
  });

  it("razítko příliš v budoucnu taky neprojde", () => {
    // Jinak by stačilo poslat razítko z roku 2099 a podpis by platil věčně.
    const now = new Date(NOW.getTime() - (DEFAULT_TOLERANCE_SECONDS + 1) * 1_000);
    assert.deepEqual(verify({ now }), {
      valid: false,
      reason: "stale_timestamp",
    });
  });

  it("přehraný podpis s novým razítkem neprojde", () => {
    // Jádro důvodu, proč se podepisuje `timestamp.body`: útočník odchytí
    // platný požadavek a zkusí ho poslat znovu s čerstvým razítkem.
    const capturedSignature = computeSignature(SECRET, TIMESTAMP, BODY);
    const freshTimestamp = String(Number.parseInt(TIMESTAMP, 10) + 600);
    const now = new Date(NOW.getTime() + 600_000);

    assert.deepEqual(
      verify({ signature: capturedSignature, timestamp: freshTimestamp, now }),
      { valid: false, reason: "signature_mismatch" },
    );
  });
});

describe("verifySignature — neplatné podpisy", () => {
  it("jiný secret neprojde", () => {
    const signature = computeSignature("jiny-secret", TIMESTAMP, BODY);
    assert.deepEqual(verify({ signature }), {
      valid: false,
      reason: "signature_mismatch",
    });
  });

  it("změněné tělo neprojde", () => {
    const tampered = JSON.stringify({
      camera_serial: "CAM-999",
      object_class: "person",
    });
    assert.deepEqual(verify({ rawBody: tampered }), {
      valid: false,
      reason: "signature_mismatch",
    });
  });

  it("i jediný přehozený znak v těle neprojde", () => {
    assert.deepEqual(verify({ rawBody: `${BODY} ` }), {
      valid: false,
      reason: "signature_mismatch",
    });
  });

  it("porovnání nespadne na podpisu správné délky ale jiné hodnotě", () => {
    // timingSafeEqual vyhazuje na různě dlouhé buffery — délku proto
    // řešíme dřív a tenhle případ musí vrátit výsledek, ne výjimku.
    assert.deepEqual(verify({ signature: "0".repeat(64) }), {
      valid: false,
      reason: "signature_mismatch",
    });
  });
});

describe("publicFailureReason — co smí ven z 401", () => {
  it("dokud razítko není platné, konkrétní důvod ven nejde", () => {
    // Rozdíl mezi „staré razítko“ a „špatný podpis“ je pro
    // nepřihlášeného volajícího návod, kde končí tolerance.
    assert.equal(publicFailureReason("stale_timestamp"), null);
    assert.equal(publicFailureReason("missing_timestamp"), null);
    assert.equal(publicFailureReason("malformed_timestamp"), null);
  });

  it("za platným razítkem už důvod nic neprozradí", () => {
    assert.equal(publicFailureReason("signature_mismatch"), "signature_mismatch");
    assert.equal(publicFailureReason("missing_signature"), "missing_signature");
    assert.equal(publicFailureReason("malformed_signature"), "malformed_signature");
  });
});

describe("verifySignature — pořadí kontrol", () => {
  it("staré razítko se pozná dřív než chybějící podpis", () => {
    // Kdyby se dřív hlásil chybějící podpis, útočník by přehráním
    // starého požadavku bez hlavičky zjistil, že do okna trefil.
    const stary = String(Math.floor(NOW.getTime() / 1000) - 10_000);
    const result = verify({ timestamp: stary, signature: null });
    assert.equal(result.valid, false);
    assert.equal(result.valid === false && result.reason, "stale_timestamp");
    assert.equal(publicFailureReason("stale_timestamp"), null);
  });

  it("s čerstvým razítkem se chybějící podpis přizná", () => {
    const result = verify({ signature: null });
    assert.equal(result.valid === false && result.reason, "missing_signature");
  });

  it("vadné razítko přebije i vadný podpis", () => {
    const result = verify({ timestamp: "abc", signature: "nesmysl" });
    assert.equal(result.valid === false && result.reason, "malformed_timestamp");
  });
});
