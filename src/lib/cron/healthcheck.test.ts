import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  healthcheckEnvName,
  healthcheckUrl,
  jobsWithoutHealthcheck,
} from "./healthcheck.ts";

// Hlídač zvenčí. Podstatné je, že se nenastavená proměnná chová tiše
// a že se do pingu nedostane adresa, které se nedá věřit.

describe("healthcheckEnvName", () => {
  it("z názvu úlohy udělá název proměnné", () => {
    assert.equal(healthcheckEnvName("patrols"), "HEALTHCHECK_URL_PATROLS");
    assert.equal(healthcheckEnvName("retention"), "HEALTHCHECK_URL_RETENTION");
  });

  it("pomlčky a tečky nahradí podtržítkem", () => {
    // Kdyby někdo pojmenoval úlohu "sync-flights", proměnná musí být
    // pořád platný název.
    assert.equal(healthcheckEnvName("sync-flights"), "HEALTHCHECK_URL_SYNC_FLIGHTS");
  });
});

describe("healthcheckUrl", () => {
  it("vrátí nastavenou adresu bez koncového lomítka", () => {
    const url = healthcheckUrl("patrols", {
      HEALTHCHECK_URL_PATROLS: "https://hc-ping.com/abc/",
    });
    assert.equal(url, "https://hc-ping.com/abc");
  });

  it("nenastavená proměnná je null, ne chyba", () => {
    // Nasazení bez healthchecks.io je dovolený stav.
    assert.equal(healthcheckUrl("patrols", {}), null);
  });

  it("prázdná hodnota se bere jako nenastavená", () => {
    assert.equal(healthcheckUrl("patrols", { HEALTHCHECK_URL_PATROLS: "   " }), null);
  });

  it("http a nesmysly se odmítnou", () => {
    // Ping jde ven ze serveru; nešifrovaná adresa by prozradila, kdy
    // co běží, komukoli po cestě.
    for (const spatna of ["http://hc-ping.com/abc", "hc-ping.com/abc", "ftp://x/y"]) {
      assert.equal(healthcheckUrl("patrols", { HEALTHCHECK_URL_PATROLS: spatna }), null, spatna);
    }
  });
});

describe("jobsWithoutHealthcheck", () => {
  it("bez proměnných nemá hlídač žádná úloha", () => {
    assert.deepEqual(jobsWithoutHealthcheck({}), [
      "patrols",
      "flights",
      "warnings",
      "retention",
    ]);
  });

  it("nastavené úlohy ze seznamu zmizí", () => {
    const chybi = jobsWithoutHealthcheck({
      HEALTHCHECK_URL_PATROLS: "https://hc-ping.com/a",
      HEALTHCHECK_URL_FLIGHTS: "https://hc-ping.com/b",
    });
    assert.deepEqual(chybi, ["warnings", "retention"]);
  });
});
