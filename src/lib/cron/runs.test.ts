import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  CRON_JOBS,
  CRON_STALE_MULTIPLIER,
  cronWarnings,
  type CronJob,
} from "./runs.ts";

const NOW = new Date("2026-08-26T12:00:00Z");
const pred = (minut: number) => new Date(NOW.getTime() - minut * 60_000);

const JOBS: CronJob[] = [
  { name: "patrols", label: "Plánování hlídek", intervalMinutes: 5 },
  { name: "flights", label: "Dotahování letů z DJI", intervalMinutes: 15 },
];

describe("cronWarnings", () => {
  it("čerstvé běhy mlčí", () => {
    const w = cronWarnings(
      [
        { name: "patrols", lastRunAt: pred(3) },
        { name: "flights", lastRunAt: pred(10) },
      ],
      NOW,
      JOBS,
    );
    assert.deepEqual(w, []);
  });

  it("jeden vynechaný běh ještě není problém", () => {
    // Restart nebo timeout se stane; teprve tři po sobě znamenají,
    // že se něco zaseklo.
    const w = cronWarnings([{ name: "patrols", lastRunAt: pred(11) }], NOW, [JOBS[0]]);
    assert.deepEqual(w, []);
  });

  it("nad trojnásobkem intervalu se ozve", () => {
    const w = cronWarnings([{ name: "patrols", lastRunAt: pred(20) }], NOW, [JOBS[0]]);
    assert.equal(w.length, 1);
    assert.match(w[0].text, /Plánování hlídek/);
    assert.match(w[0].text, /každých 5 min/);
  });

  it("přesně na hranici ještě mlčí", () => {
    const prah = JOBS[0].intervalMinutes * CRON_STALE_MULTIPLIER;
    assert.deepEqual(cronWarnings([{ name: "patrols", lastRunAt: pred(prah) }], NOW, [JOBS[0]]), []);
    assert.equal(cronWarnings([{ name: "patrols", lastRunAt: pred(prah + 1) }], NOW, [JOBS[0]]).length, 1);
  });

  it("úloha bez jediného běhu se hlásí zvlášť", () => {
    // Prázdná tabulka není v pořádku — znamená, že cron nikdo
    // nenastavil.
    const w = cronWarnings([], NOW, [JOBS[0]]);
    assert.equal(w.length, 1);
    assert.match(w[0].text, /nikdy neproběhla/);
    assert.equal(w[0].key, "cron_never_patrols");
  });

  it("null jako čas běhu je totéž co žádný běh", () => {
    const w = cronWarnings([{ name: "patrols", lastRunAt: null }], NOW, [JOBS[0]]);
    assert.match(w[0].text, /nikdy neproběhla/);
  });

  it("každá úloha má vlastní interval", () => {
    // 20 min je pro hlídky (5 min) problém, pro lety (15 min) ne.
    const w = cronWarnings(
      [
        { name: "patrols", lastRunAt: pred(20) },
        { name: "flights", lastRunAt: pred(20) },
      ],
      NOW,
      JOBS,
    );
    assert.equal(w.length, 1);
    assert.match(w[0].text, /Plánování hlídek/);
  });

  it("nečitelné razítko varování neschová", () => {
    // NaN projde každým porovnáním jako false — bez výslovné větve by
    // tiše zmizelo právě to varování, kvůli kterému evidence vznikla.
    const w = cronWarnings(
      [{ name: "patrols", lastRunAt: new Date("nesmysl") }],
      NOW,
      [JOBS[0]],
    );
    assert.equal(w.length, 1);
    assert.match(w[0].text, /nedá přečíst/);
  });

  it("stáří se píše po lidsku", () => {
    assert.match(cronWarnings([{ name: "patrols", lastRunAt: pred(45) }], NOW, [JOBS[0]])[0].text, /45 min/);
    assert.match(cronWarnings([{ name: "patrols", lastRunAt: pred(180) }], NOW, [JOBS[0]])[0].text, /3 h/);
    assert.match(cronWarnings([{ name: "patrols", lastRunAt: pred(60 * 72) }], NOW, [JOBS[0]])[0].text, /3 dní/);
  });

  it("výchozí seznam pokrývá všechny hlídané endpointy", () => {
    // Když přibude cron, musí přibýt i tady — jinak by se jeho výpadek
    // nikde neprojevil.
    assert.deepEqual(
      CRON_JOBS.map((job) => job.name).sort(),
      ["flights", "patrols", "retention", "warnings"],
    );
  });
});
