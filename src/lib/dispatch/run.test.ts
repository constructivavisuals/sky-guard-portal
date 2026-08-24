import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { runDispatch, type DispatchDeps, type DispatchRow } from "./run.ts";
import type { DispatchContext } from "./run.ts";

// Testy zaručují hlavní slib orchestrace: každý pokus o výjezd nechá
// v dispatches řádek. Závislosti se podstrkávají, takže neběží ani
// databáze, ani FlightHub.

// Praha — geography(Point,4326) tak, jak ho vrací PostgREST.
const LOCATION = "0101000020E6100000AA60545227E02C408B6CE7FBA9094940";

function context(overrides: Partial<DispatchContext> = {}): DispatchContext {
  return {
    detectionId: "detection-1",
    siteId: "site-1",
    zoneId: "zone-1",
    zoneName: "Brána sever",
    zoneEnabled: true,
    zoneLocation: LOCATION,
    siteCooldownSeconds: 900,
    siteWorkflowUuid: "wf-uuid",
    objectClass: "person",
    detectedAt: new Date("2026-08-24T22:00:00Z"),
    ...overrides,
  };
}

/** Závislosti, které vždycky uspějí; jednotlivé testy si je přebijí. */
function deps(overrides: Partial<DispatchDeps> = {}) {
  const inserted: DispatchRow[] = [];
  const base: DispatchDeps = {
    isSiteArmed: async () => true,
    lastSentDispatchAt: async () => null,
    hasRecentPersonInOtherZone: async () => false,
    triggerWorkflow: async () => ({
      incidentUuid: "incident-1",
      httpStatus: 200,
      response: { code: 0 },
      ok: true,
    }),
    insertDispatch: async (row) => {
      inserted.push(row);
      return "dispatch-1";
    },
    ...overrides,
  };
  return { deps: base, inserted };
}

describe("runDispatch — chybějící konfigurace FlightHubu", () => {
  it("výjimka z flightHubConfig() skončí zapsaným řádkem, ne pádem", async () => {
    // Přesně to, co dělal flightHubConfig() před opravou: vyhodil dřív,
    // než se stihlo cokoli zapsat.
    const { deps: d, inserted } = deps({
      triggerWorkflow: async () => {
        throw new Error("Chybí povinná proměnná prostředí FH_USER_TOKEN");
      },
    });

    const result = await runDispatch(context(), d);

    assert.equal(inserted.length, 1);
    assert.equal(inserted[0].outcome, "failed");
    assert.equal(result.status, "recorded");
  });

  it("zapsaný řádek nese kategorii dispatch_error a hlášku", async () => {
    const { deps: d, inserted } = deps({
      triggerWorkflow: async () => {
        throw new Error("Chybí povinná proměnná prostředí FH_USER_TOKEN");
      },
    });

    await runDispatch(context(), d);
    const response = inserted[0].response as Record<string, unknown>;

    assert.equal(response.error, "dispatch_error");
    assert.match(String(response.message), /FH_USER_TOKEN/);
  });

  it("výjimka v přípravě nechá stupeň podle třídy objektu", async () => {
    const { deps: d, inserted } = deps({
      triggerWorkflow: async () => {
        throw new Error("konfigurace chybí");
      },
    });

    await runDispatch(context({ objectClass: "vehicle" }), d);

    assert.equal(inserted[0].level_sent, 2);
  });

  it("konfigurační chyba vrácená jako výsledek se taky zapíše", async () => {
    // Cesta po opravě: triggerWorkflow už nevyhazuje, vrací výsledek.
    const { deps: d, inserted } = deps({
      triggerWorkflow: async () => ({
        incidentUuid: null,
        httpStatus: null,
        response: {
          error: "configuration_error",
          message: "Chybí povinná proměnná prostředí FH_USER_TOKEN",
        },
        ok: false,
      }),
    });

    await runDispatch(context(), d);

    assert.equal(inserted[0].outcome, "failed");
    assert.equal(
      (inserted[0].response as Record<string, unknown>).error,
      "configuration_error",
    );
  });
});

describe("runDispatch — výjimky odjinud z přípravy", () => {
  const failing: [string, keyof DispatchDeps][] = [
    ["zjištění ostrého režimu", "isSiteArmed"],
    ["čtení posledního výjezdu", "lastSentDispatchAt"],
    ["dotaz na sousední zóny", "hasRecentPersonInOtherZone"],
  ];

  for (const [name, key] of failing) {
    it(`selhání "${name}" nechá zapsaný pokus`, async () => {
      const { deps: d, inserted } = deps({
        [key]: async () => {
          throw new Error("spojení selhalo");
        },
      });

      const result = await runDispatch(context(), d);

      assert.equal(inserted.length, 1);
      assert.equal(inserted[0].outcome, "failed");
      assert.equal(result.status, "recorded");
    });
  }
});

describe("runDispatch — když selže i zápis", () => {
  it("výjimka ze zápisu skončí stavem unrecorded, ne pádem", async () => {
    const { deps: d } = deps({
      insertDispatch: async () => {
        throw new Error("databáze nedostupná");
      },
    });

    const result = await runDispatch(context(), d);

    assert.equal(result.status, "unrecorded");
  });
});

describe("runDispatch — nedotčené cesty", () => {
  it("úspěšný výjezd se zapíše jako sent", async () => {
    const { deps: d, inserted } = deps();

    const result = await runDispatch(context(), d);

    assert.equal(inserted[0].outcome, "sent");
    assert.equal(inserted[0].fh_incident_uuid, "incident-1");
    assert.deepEqual(result, {
      status: "recorded",
      outcome: "sent",
      dispatchId: "dispatch-1",
    });
  });

  it("mimo ostrý režim se zapíše suppressed_disarmed a FlightHub se nevolá", async () => {
    let triggered = 0;
    const { deps: d, inserted } = deps({
      isSiteArmed: async () => false,
      triggerWorkflow: async () => {
        triggered += 1;
        throw new Error("nemělo se volat");
      },
    });

    await runDispatch(context(), d);

    assert.equal(inserted[0].outcome, "suppressed_disarmed");
    assert.equal(triggered, 0);
  });

  it("kamera bez zóny se přeskočí a nic se nezapisuje", async () => {
    const { deps: d, inserted } = deps();

    const result = await runDispatch(context({ zoneId: null }), d);

    assert.deepEqual(result, { status: "skipped", reason: "camera_without_zone" });
    assert.equal(inserted.length, 0);
  });

  it("zóna bez souřadnic se zapíše jako failed bez volání FlightHubu", async () => {
    let triggered = 0;
    const { deps: d, inserted } = deps({
      triggerWorkflow: async () => {
        triggered += 1;
        throw new Error("nemělo se volat");
      },
    });

    await runDispatch(context({ zoneLocation: null }), d);

    assert.equal(inserted[0].outcome, "failed");
    assert.equal(
      (inserted[0].response as Record<string, unknown>).error,
      "zone_without_location",
    );
    assert.equal(triggered, 0);
  });
});
