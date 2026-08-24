import { strict as assert } from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";

import { MAX_ERROR_MESSAGE_LENGTH, triggerWorkflow } from "./flighthub.ts";

// Hodnoty, které se NIKDY nesmí objevit v dispatches.response.
const TOKEN = "tajny-token-nesmi-uniknout";
const PROJECT = "tajne-project-uuid";

const FH_VARS = [
  "FH_HOST",
  "FH_PROJECT_UUID",
  "FH_WORKFLOW_UUID",
  "FH_CREATOR",
  "FH_USER_TOKEN",
] as const;

const INPUT = {
  workflowUuid: "wf-uuid",
  name: "Perimetr — Brána sever",
  latitude: 50.0755,
  longitude: 14.4378,
  level: 5,
  desc: "Osoba v zóně Brána sever",
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
  process.env.FH_WORKFLOW_UUID = "wf";
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

describe("triggerWorkflow — chybějící konfigurace", () => {
  it("chybějící FH_USER_TOKEN nevyhodí, ale vrátí zapsatelný výsledek", async () => {
    delete process.env.FH_USER_TOKEN;

    const result = await triggerWorkflow(INPUT);

    assert.equal(result.ok, false);
    assert.equal(result.incidentUuid, null);
    assert.equal(result.httpStatus, null);
    assert.equal(fetchCalls, 0, "na síť se nemá sahat");
  });

  it("konfigurační chyba je v response odlišená od nedostupné sítě", async () => {
    delete process.env.FH_USER_TOKEN;

    const { response } = await triggerWorkflow(INPUT);

    assert.equal(response.error, "configuration_error");
    assert.notEqual(response.error, "network_error");
    assert.notEqual(response.error, "timeout");
  });

  it("hláška pojmenuje chybějící proměnnou", async () => {
    delete process.env.FH_USER_TOKEN;

    const { response } = await triggerWorkflow(INPUT);

    assert.match(String(response.message), /FH_USER_TOKEN/);
  });

  it("hláška neobsahuje hodnoty proměnných", async () => {
    // Pojistka proti tomu, aby někdo rozšířil required() o výpis hodnoty
    // a token tím poslal rovnou do databáze.
    delete process.env.FH_USER_TOKEN;

    const { response } = await triggerWorkflow(INPUT);
    const serialized = JSON.stringify(response);

    assert.equal(serialized.includes(TOKEN), false, "unikl token");
    assert.equal(serialized.includes(PROJECT), false, "uniklo project uuid");
  });

  it("stejně se chová každá chybějící proměnná", async () => {
    for (const key of FH_VARS) {
      const saved = process.env[key];
      delete process.env[key];

      const result = await triggerWorkflow(INPUT);
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

    const { ok, response } = await triggerWorkflow(INPUT);

    assert.equal(ok, false);
    assert.equal(response.error, "configuration_error");
  });

  it("hláška je useknutá na rozumnou délku", async () => {
    delete process.env.FH_USER_TOKEN;

    const { response } = await triggerWorkflow(INPUT);

    assert.ok(String(response.message).length <= MAX_ERROR_MESSAGE_LENGTH);
  });
});
