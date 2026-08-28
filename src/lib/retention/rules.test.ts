import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  arrivalAnonymization,
  batches,
  clipRetentionCutoff,
  cutoffDateISO,
  DEFAULT_CLIP_RETENTION_DAYS,
  DEFAULT_RETENTION_DAYS,
  expiredPaths,
  passageAnonymization,
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

describe("passageAnonymization", () => {
  const NOW = new Date("2026-08-27T10:00:00Z");

  it("smaže značku, jistotu i jméno ze seznamu", () => {
    const z = passageAnonymization(NOW);
    assert.equal(z.plate, null);
    assert.equal(z.confidence, null);
    assert.equal(z.known_label, null);
    assert.equal(z.known_plate_id, null);
    assert.equal(z.anonymized_at, NOW.toISOString());
  });

  it("list_match a plate_source nechává být", () => {
    // Rozpad na známé a neznámé musí v měsíčním reportu platit i po
    // lhůtě — a ani jeden z těch sloupců neříká nic o osobě.
    const z = passageAnonymization(NOW) as Record<string, unknown>;
    assert.equal("list_match" in z, false);
    assert.equal("plate_source" in z, false);
  });

  it("storage_path nemaže — o snímek se stará mazání souborů", () => {
    const z = passageAnonymization(NOW) as Record<string, unknown>;
    assert.equal("storage_path" in z, false);
  });
});

describe("arrivalAnonymization", () => {
  it("smaže značku i volnou poznámku", () => {
    // V poznámce od řidiče může být cokoli včetně jména.
    const z = arrivalAnonymization(new Date("2026-08-27T10:00:00Z"));
    assert.equal(z.plate, null);
    assert.equal(z.note, null);
    assert.ok(z.anonymized_at);
  });

  it("night_ok ani datum nemaže — bez nich by řádek nedával smysl", () => {
    const z = arrivalAnonymization(new Date()) as Record<string, unknown>;
    assert.equal("night_ok" in z, false);
    assert.equal("arrival_date" in z, false);
  });
});

describe("cutoffDateISO", () => {
  it("z času udělá kalendářní datum", () => {
    assert.equal(cutoffDateISO(new Date("2026-05-30T22:15:00Z")), "2026-05-30");
  });

  it("hodí se přímo na porovnání s arrival_date", () => {
    // Ohlášení nemá čas, jen datum, takže se lhůta musí porovnat taky
    // datem — jinak by textové porovnání nikdy nesedělo.
    assert.match(cutoffDateISO(retentionCutoff(90, new Date("2026-08-27T00:00:00Z"))), /^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("clipRetentionCutoff", () => {
  it("bere clip_retention_days, ne retention_days", () => {
    const now = new Date("2026-08-28T12:00:00Z");
    const cutoff = clipRetentionCutoff(14, now);
    assert.equal(cutoff.toISOString(), "2026-08-14T12:00:00.000Z");
  });

  it("nenastavená lhůta padá na 14 dní, ne na 90", () => {
    // Kdyby padala na DEFAULT_RETENTION_DAYS, drželo by se v Hetzneru
    // šestinásobek videa — u 300 GB denně je to 27 TB navíc.
    const now = new Date("2026-08-28T12:00:00Z");
    assert.equal(
      clipRetentionCutoff(null, now).toISOString(),
      "2026-08-14T12:00:00.000Z",
    );
    assert.equal(DEFAULT_CLIP_RETENTION_DAYS, 14);
    assert.notEqual(
      clipRetentionCutoff(null, now).getTime(),
      retentionCutoff(null, now).getTime(),
    );
  });

  it("nesmyslná lhůta nemaže všechno hned", () => {
    const now = new Date("2026-08-28T12:00:00Z");
    for (const dny of [0, -3]) {
      assert.ok(clipRetentionCutoff(dny, now) < now);
      assert.equal(
        clipRetentionCutoff(dny, now).toISOString(),
        "2026-08-14T12:00:00.000Z",
      );
    }
  });
});
