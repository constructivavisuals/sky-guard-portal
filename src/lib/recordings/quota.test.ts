import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { formatBytes } from "../format.ts";
import { DEFAULT_RECORDING_QUOTA_BYTES } from "./storage.ts";
import { formatQuotaBytes, quotaMessage, quotaState, QUOTA_WARNING_PERCENT } from "./quota.ts";

const GB = 1_000_000_000;

describe("quotaState", () => {
  it("pod stropem přijímá", () => {
    const stav = quotaState(100 * GB, 500 * GB);
    assert.equal(stav.exceeded, false);
    assert.equal(stav.warning, false);
    assert.equal(stav.percent, 20);
  });

  it("varuje od nastavené hranice, ale ještě přijímá", () => {
    const stav = quotaState(430 * GB, 500 * GB);
    assert.equal(stav.percent, 86);
    assert.ok(stav.percent >= QUOTA_WARNING_PERCENT);
    assert.equal(stav.warning, true);
    assert.equal(stav.exceeded, false);
  });

  it("na stropu už nepřijímá", () => {
    // Přesně na hranici, ne až nad ní: strop je hranice, ne doporučení.
    const stav = quotaState(500 * GB, 500 * GB);
    assert.equal(stav.exceeded, true);
    // Vyčerpaný strop se nehlásí zároveň jako varování — to je jiná věta.
    assert.equal(stav.warning, false);
  });

  it("nad stropem procenta neuřezává", () => {
    // 100 % u dvojnásobku by zakrylo, jak moc se přeteklo.
    assert.equal(quotaState(1000 * GB, 500 * GB).percent, 200);
  });

  it("nenastavený strop bere výchozí, ne nulu", () => {
    // Vynulovaný sloupec je překlep. Kdyby se bral doslova, odstavil by
    // příjem celé lokality a vypadalo by to jako porucha kamer.
    for (const strop of [null, undefined, 0, -1]) {
      const stav = quotaState(GB, strop);
      assert.equal(stav.quotaBytes, DEFAULT_RECORDING_QUOTA_BYTES);
      assert.equal(stav.exceeded, false);
    }
  });

  it("výchozí strop je 500 GB", () => {
    assert.equal(DEFAULT_RECORDING_QUOTA_BYTES, 500 * GB);
  });

  it("nesmyslné použití bere jako nulu, ne jako vyčerpáno", () => {
    for (const pouzito of [null, undefined, -5, Number.NaN]) {
      assert.equal(quotaState(pouzito, 500 * GB).exceeded, false);
    }
  });
});

describe("quotaMessage", () => {
  it("u vyčerpaného stropu řekne, že se nepřijímá", () => {
    const text = quotaMessage("Klanečná", quotaState(500 * GB, 500 * GB));
    assert.match(text, /Klanečná/);
    assert.match(text, /nepřijímají/);
  });

  it("u varování mluví o procentech, ne o zastavení", () => {
    const text = quotaMessage("Mírovka", quotaState(430 * GB, 500 * GB));
    assert.match(text, /86 %/);
    assert.doesNotMatch(text, /nepřijímají/);
  });
});

describe("formatQuotaBytes", () => {
  it("používá dekadické jednotky, ať se to dá porovnat s fakturou", () => {
    assert.equal(formatQuotaBytes(2_000_000_000_000), "2.0 TB");
    assert.equal(formatQuotaBytes(500 * GB), "500 GB");
    assert.equal(formatQuotaBytes(50_000_000), "50 MB");
  });

  it("liší se od binárního formatBytes z lib/format.ts záměrně", () => {
    // 50 000 000 B je 50 MB dekadicky, ale 47.7 MB binárně. Kdyby se
    // sem omylem naimportovala ta druhá, tenhle test to zachytí.
    assert.equal(formatQuotaBytes(50_000_000), "50 MB");
    assert.equal(formatBytes(50_000_000), "47.7 MB");
  });
});
