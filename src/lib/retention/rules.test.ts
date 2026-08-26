import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  batches,
  DEFAULT_RETENTION_DAYS,
  expiredPaths,
  retentionCutoff,
} from "./rules.ts";

const NOW = new Date("2026-08-26T12:00:00Z");
const pred = (dnu: number) =>
  new Date(NOW.getTime() - dnu * 86_400_000).toISOString();

describe("retentionCutoff", () => {
  it("odečte zadaný počet dní", () => {
    assert.equal(retentionCutoff(30, NOW).toISOString(), "2026-07-27T12:00:00.000Z");
  });

  it("bez nastavení bere výchozí lhůtu", () => {
    for (const value of [null, undefined, 0, -5, Number.NaN]) {
      assert.equal(
        retentionCutoff(value as number, NOW).getTime(),
        NOW.getTime() - DEFAULT_RETENTION_DAYS * 86_400_000,
        `hodnota ${String(value)}`,
      );
    }
  });
});

describe("expiredPaths", () => {
  const cutoff = retentionCutoff(90, NOW);

  it("bere jen soubory starší než lhůta", () => {
    const paths = expiredPaths(
      [
        { storage_path: "a.jpg", at: pred(100) },
        { storage_path: "b.jpg", at: pred(89) },
        { storage_path: "c.jpg", at: pred(91) },
      ],
      cutoff,
    );
    assert.deepEqual(paths, ["a.jpg", "c.jpg"]);
  });

  it("řádek bez cesty se přeskočí", () => {
    assert.deepEqual(expiredPaths([{ storage_path: null, at: pred(999) }], cutoff), []);
  });

  it("řádek bez času se NEMAŽE", () => {
    // Bez razítka se stáří nedá spočítat a mazat „pro jistotu“ je
    // přesně to, co se nemá dít.
    assert.deepEqual(expiredPaths([{ storage_path: "a.jpg", at: null }], cutoff), []);
  });

  it("nečitelné razítko taky ne", () => {
    assert.deepEqual(expiredPaths([{ storage_path: "a.jpg", at: "nesmysl" }], cutoff), []);
  });

  it("přesně na hranici se nemaže", () => {
    const at = new Date(cutoff.getTime()).toISOString();
    assert.deepEqual(expiredPaths([{ storage_path: "a.jpg", at }], cutoff), []);
  });

  it("prázdný vstup dá prázdno", () => {
    assert.deepEqual(expiredPaths([], cutoff), []);
  });
});

describe("batches", () => {
  it("rozdělí po zadané velikosti", () => {
    assert.deepEqual(batches([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  });

  it("kratší seznam je jedna dávka", () => {
    assert.deepEqual(batches([1, 2], 50), [[1, 2]]);
  });

  it("prázdný seznam nedá žádnou dávku", () => {
    // Prázdná dávka by znamenala volání úložiště pro nic.
    assert.deepEqual(batches([], 50), []);
  });
});
