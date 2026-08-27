import { strict as assert } from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";

import { createFlightTask, MAX_ERROR_MESSAGE_LENGTH } from "./flighthub.ts";

// Hodnoty, které se NIKDY nesmí objevit v dispatches.response.
const TOKEN = "tajny-token-nesmi-uniknout";
const PROJECT = "tajne-project-uuid";

/** Povinné proměnné. FH_WORKFLOW_UUID mezi ně nepatří — workflow
    trigger je pryč a povinná proměnná, kterou nikdo nečte, by jen
    bránila nasazení. */
const FH_VARS = [
  "FH_HOST",
  "FH_PROJECT_UUID",
  "FH_CREATOR",
  "FH_USER_TOKEN",
] as const;

const INPUT = {
  name: "Zásah 5 — Brána sever",
  dockSn: "DOCK-1",
  waylineUuid: "wayline-1",
  timeZone: "Europe/Prague",
  taskType: "immediate" as const,
  rthAltitude: 60,
} as const;

let savedEnv: Record<string, string | undefined> = {};
let savedFetch: typeof globalThis.fetch;
let fetchCalls = 0;

beforeEach(() => {
  savedEnv = Object.fromEntries(FH_VARS.map((key) => [key, process.env[key]]));
  savedFetch = globalThis.fetch;
  fetchCalls = 0;
  // Síť se v těchhle testech nesmí použít vůbec.
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    throw new Error("fetch neměl být zavolán");
  }) as typeof globalThis.fetch;

  process.env.FH_HOST = "https://fh.example.invalid";
  process.env.FH_PROJECT_UUID = PROJECT;
  process.env.FH_CREATOR = "constructiva";
  process.env.FH_USER_TOKEN = TOKEN;
});

afterEach(() => {
  for (const key of FH_VARS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  globalThis.fetch = savedFetch;
});

describe("createFlightTask — chybějící konfigurace", () => {
  it("chybějící FH_USER_TOKEN nevyhodí, ale vrátí zapsatelný výsledek", async () => {
    delete process.env.FH_USER_TOKEN;

    const result = await createFlightTask(INPUT);

    assert.equal(result.ok, false);
    assert.equal(result.taskUuid, null);
    assert.equal(result.httpStatus, null);
    assert.equal(fetchCalls, 0, "na síť se nemá sahat");
  });

  it("konfigurační chyba je v response odlišená od nedostupné sítě", async () => {
    delete process.env.FH_USER_TOKEN;

    const { response } = await createFlightTask(INPUT);

    assert.equal(response.error, "configuration_error");
    assert.notEqual(response.error, "network_error");
    assert.notEqual(response.error, "timeout");
  });

  it("hláška pojmenuje chybějící proměnnou", async () => {
    delete process.env.FH_USER_TOKEN;

    const { response } = await createFlightTask(INPUT);

    assert.match(String(response.message), /FH_USER_TOKEN/);
  });

  it("hláška neobsahuje hodnoty proměnných", async () => {
    // Pojistka proti tomu, aby někdo rozšířil required() o výpis hodnoty
    // a token tím poslal rovnou do databáze.
    delete process.env.FH_USER_TOKEN;

    const { response } = await createFlightTask(INPUT);
    const serialized = JSON.stringify(response);

    assert.equal(serialized.includes(TOKEN), false, "unikl token");
    assert.equal(serialized.includes(PROJECT), false, "uniklo project uuid");
  });

  it("stejně se chová každá chybějící proměnná", async () => {
    for (const key of FH_VARS) {
      const saved = process.env[key];
      delete process.env[key];

      const result = await createFlightTask(INPUT);
      assert.equal(result.ok, false, `${key}: mělo selhat`);
      assert.equal(
        result.response.error,
        "configuration_error",
        `${key}: špatná kategorie chyby`,
      );

      process.env[key] = saved;
    }
    assert.equal(fetchCalls, 0);
  });

  it("prázdná hodnota se bere jako chybějící", async () => {
    process.env.FH_USER_TOKEN = "";

    const { ok, response } = await createFlightTask(INPUT);

    assert.equal(ok, false);
    assert.equal(response.error, "configuration_error");
  });

  it("hláška je useknutá na rozumnou délku", async () => {
    delete process.env.FH_USER_TOKEN;

    const { response } = await createFlightTask(INPUT);

    assert.ok(String(response.message).length <= MAX_ERROR_MESSAGE_LENGTH);
  });
});

describe("createFlightTask — tvar těla úlohy", () => {
  /** Odchytí tělo, které by šlo do FlightHubu, bez volání po síti. */
  async function telo(input: Parameters<typeof createFlightTask>[0]) {
    const puvodni = globalThis.fetch;
    let body: Record<string, unknown> = {};
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      body = JSON.parse(String(init?.body ?? "{}"));
      return new Response(JSON.stringify({ task_uuid: "t-1" }), { status: 200 });
    }) as typeof fetch;

    const puvodniEnv = { ...process.env };
    process.env.FH_HOST = "https://fh.example";
    process.env.FH_PROJECT_UUID = "p-1";
    process.env.FH_CREATOR = "portal";
    process.env.FH_USER_TOKEN = "token";
    try {
      await createFlightTask(input);
    } finally {
      globalThis.fetch = puvodni;
      process.env = puvodniEnv;
    }
    return body;
  }

  const spolecne = {
    name: "Zásah",
    dockSn: "DOCK-1",
    waylineUuid: "w-1",
    timeZone: "Europe/Prague",
    rthAltitude: 60,
  };

  it("okamžitá úloha neposílá časy vůbec", async () => {
    // begin_at v minulosti FlightHub odmítá a „hned“ se jím zapsat
    // nedá — proto se u immediate nesmí objevit ani jeden.
    const body = await telo({ ...spolecne, taskType: "immediate" });
    assert.equal(body.task_type, "immediate");
    assert.equal("begin_at" in body, false);
    assert.equal("latest_begin_at" in body, false);
  });

  it("plánovaná úloha časy posílá v sekundách", async () => {
    const beginAt = new Date("2026-08-27T22:00:00Z");
    const body = await telo({
      ...spolecne,
      taskType: "timed",
      beginAt,
      latestBeginAt: new Date(beginAt.getTime() + 300_000),
    });
    assert.equal(body.task_type, "timed");
    assert.equal(body.begin_at, Math.floor(beginAt.getTime() / 1000));
    assert.equal(body.latest_begin_at, Math.floor(beginAt.getTime() / 1000) + 300);
  });

  it("výška návratu jde z parametru, ne z konstanty", async () => {
    // Natvrdo 100 m bylo nad stropem projektu a mise se nespouštěly.
    const body = await telo({ ...spolecne, rthAltitude: 45, taskType: "immediate" });
    assert.equal(body.rth_altitude, 45);
  });

  it("dock jde do sn, ne dron", async () => {
    const body = await telo({ ...spolecne, taskType: "immediate" });
    assert.equal(body.sn, "DOCK-1");
  });
});
