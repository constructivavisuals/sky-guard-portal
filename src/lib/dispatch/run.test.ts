import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  DISPATCH_LEAD_SECONDS,
  runDispatch,
  type DispatchDeps,
  type DispatchRow,
  type FlightPlan,
} from "./run.ts";
import type { DispatchContext } from "./run.ts";
import type { DockState } from "./flighthub.ts";

// Testy zaručují hlavní slib orchestrace: každý pokus o zásah nechá
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
    siteTimezone: "Europe/Prague",
    siteDockSn: "DOCK-1",
    zoneWaylineUuid: "wayline-1",
    objectClass: "person",
    detectedAt: new Date("2026-08-24T22:00:00Z"),
    receivedAt: new Date("2026-08-24T22:00:00Z"),
    ...overrides,
  };
}

/** Dok, ze kterého se dá vzlétnout. */
function dockState(over: Partial<DockState> = {}): DockState {
  return {
    droneInDock: true,
    droneStatus: "power_off",
    batteryPercent: 96,
    chargeState: "idle",
    storageUsedPercent: 40,
    remainUpload: 0,
    conditions: {
      wind_speed: 2,
      rainfall: "no_rain",
      environment_temperature: 18,
      measured_at: "2026-08-24T22:00:00.000Z",
    },
    latitude: 50.3305,
    longitude: 15.4256,
    ...over,
  };
}

/** Závislosti, které vždycky uspějí; jednotlivé testy si je přebijí. */
function deps(overrides: Partial<DispatchDeps> = {}) {
  const inserted: DispatchRow[] = [];
  const flights: FlightPlan[] = [];
  const base: DispatchDeps = {
    isSiteArmed: async () => true,
    lastSentDispatchAt: async () => null,
    hasRecentPersonInOtherZone: async () => false,
    getDockState: async () => ({ ok: true, state: dockState() }),
    createFlightTask: async () => ({
      taskUuid: "task-1",
      httpStatus: 200,
      response: { code: 0 },
      ok: true,
    }),
    insertDispatch: async (row) => {
      inserted.push(row);
      return "dispatch-1";
    },
    insertFlight: async (plan) => {
      flights.push(plan);
    },
    ...overrides,
  };
  return { deps: base, inserted, flights };
}

describe("runDispatch — chybějící konfigurace FlightHubu", () => {
  it("výjimka z flightHubConfig() skončí zapsaným řádkem, ne pádem", async () => {
    // Přesně to, co dělal flightHubConfig() před opravou: vyhodil dřív,
    // než se stihlo cokoli zapsat.
    const { deps: d, inserted } = deps({
      createFlightTask: async () => {
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
      createFlightTask: async () => {
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
      createFlightTask: async () => {
        throw new Error("konfigurace chybí");
      },
    });

    await runDispatch(context({ objectClass: "vehicle" }), d);

    assert.equal(inserted[0].level_sent, 2);
  });

  it("konfigurační chyba vrácená jako výsledek se taky zapíše", async () => {
    // Cesta po opravě: createFlightTask už nevyhazuje, vrací výsledek.
    const { deps: d, inserted } = deps({
      createFlightTask: async () => ({
        taskUuid: null,
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
    ["čtení posledního zásahu", "lastSentDispatchAt"],
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
  it("úspěšný zásah se zapíše jako sent", async () => {
    const { deps: d, inserted } = deps();

    const result = await runDispatch(context(), d);

    assert.equal(inserted[0].outcome, "sent");
    assert.equal(inserted[0].fh_task_uuid, "task-1");
    // Stará cesta přes workflow trigger je pryč — incident se
    // nevyplňuje ani omylem.
    assert.equal(inserted[0].fh_incident_uuid, null);
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
      createFlightTask: async () => {
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

  it("zóna bez souřadnic zásah NEZASTAVÍ — dron letí po trase", async () => {
    // Plánovaná úloha souřadnice nechce. zones.location zůstává kvůli
    // mapě a detailu, ale o tom, kudy se letí, rozhoduje trasa.
    const { deps: d, inserted } = deps();

    await runDispatch(context({ zoneLocation: null }), d);

    assert.equal(inserted[0].outcome, "sent");
  });
});

describe("runDispatch — co musí být připravené, než se letí", () => {
  it("zóna bez trasy se zapíše jako failed a FlightHub se nevolá", async () => {
    let volano = 0;
    const { deps: d, inserted, flights } = deps({
      createFlightTask: async () => {
        volano += 1;
        throw new Error("nemělo se volat");
      },
    });

    await runDispatch(context({ zoneWaylineUuid: null }), d);

    assert.equal(inserted[0].outcome, "failed");
    assert.equal(
      (inserted[0].response as Record<string, unknown>).error,
      "zone_without_wayline",
    );
    assert.equal(inserted[0].decision_reason?.zone_has_wayline, false);
    assert.equal(volano, 0);
    assert.equal(flights.length, 0);
  });

  it("lokalita bez sériového čísla doku se zapíše jako failed", async () => {
    const { deps: d, inserted } = deps();

    await runDispatch(context({ siteDockSn: null }), d);

    assert.equal(inserted[0].outcome, "failed");
    assert.equal(
      (inserted[0].response as Record<string, unknown>).error,
      "site_without_dock_sn",
    );
  });

  it("dron mimo dok potlačí zásah, ale není to chyba", async () => {
    let volano = 0;
    const { deps: d, inserted } = deps({
      getDockState: async () => ({ ok: true, state: dockState({ droneInDock: false }) }),
      createFlightTask: async () => {
        volano += 1;
        throw new Error("nemělo se volat");
      },
    });

    await runDispatch(context(), d);

    assert.equal(inserted[0].outcome, "suppressed_dock");
    assert.equal(inserted[0].decision_reason?.dock?.reason, "drone_not_in_dock");
    assert.equal(volano, 0);
  });

  it("vybitá baterie potlačí zásah a důvod je v decision_reason", async () => {
    const { deps: d, inserted } = deps({
      getDockState: async () => ({ ok: true, state: dockState({ batteryPercent: 12 }) }),
    });

    await runDispatch(context(), d);

    assert.equal(inserted[0].outcome, "suppressed_dock");
    assert.equal(inserted[0].decision_reason?.dock?.reason, "low_battery");
    assert.equal(inserted[0].decision_reason?.dock?.battery_percent, 12);
  });

  it("plné úložiště doku potlačí zásah", async () => {
    const { deps: d, inserted } = deps({
      getDockState: async () => ({
        ok: true,
        state: dockState({ storageUsedPercent: 99.4 }),
      }),
    });

    await runDispatch(context(), d);

    assert.equal(inserted[0].outcome, "suppressed_dock");
    assert.equal(inserted[0].decision_reason?.dock?.reason, "storage_full");
  });

  it("nedostupný dok zásah potlačí, neposílá naslepo", async () => {
    // Planý let stojí víc než zmeškaný a bez stavu doku nevíme ani to,
    // jestli je dron doma.
    const { deps: d, inserted } = deps({
      getDockState: async () => ({ ok: false, message: "FlightHub odpověděl 503." }),
    });

    await runDispatch(context(), d);

    assert.equal(inserted[0].outcome, "suppressed_dock");
    assert.equal(inserted[0].decision_reason?.dock?.reason, "unreachable");
  });

  it("stav doku se nezjišťuje, když se stejně neletí", async () => {
    // Mimo ostrý režim by to bylo volání po síti pro nic.
    let volano = 0;
    const { deps: d } = deps({
      isSiteArmed: async () => false,
      getDockState: async () => {
        volano += 1;
        throw new Error("nemělo se volat");
      },
    });

    await runDispatch(context(), d);
    assert.equal(volano, 0);
  });
});

describe("runDispatch — let k zásahu", () => {
  it("po odeslání se založí let, aby ho sync dotáhl", async () => {
    const { deps: d, flights } = deps();
    const pred = Date.now();

    await runDispatch(context(), d);

    assert.equal(flights.length, 1);
    assert.equal(flights[0].dispatchId, "dispatch-1");
    assert.equal(flights[0].fhTaskUuid, "task-1");
    assert.equal(flights[0].siteId, "site-1");
    // Počasí z doku se ukládá k letu, stejně jako u hlídek.
    assert.equal(flights[0].conditions?.wind_speed, 2);

    const lead = flights[0].beginAt.getTime() - pred;
    assert.ok(
      lead >= (DISPATCH_LEAD_SECONDS - 2) * 1000 &&
        lead <= (DISPATCH_LEAD_SECONDS + 2) * 1000,
      `začátek za ${lead} ms`,
    );
  });

  it("potlačený zásah let nezakládá", async () => {
    const { deps: d, flights } = deps({ isSiteArmed: async () => false });
    await runDispatch(context(), d);
    assert.equal(flights.length, 0);
  });

  it("neúspěšná úloha let nezakládá", async () => {
    const { deps: d, flights, inserted } = deps({
      createFlightTask: async () => ({
        taskUuid: null,
        httpStatus: 400,
        response: { code: 300001 },
        ok: false,
      }),
    });

    await runDispatch(context(), d);

    assert.equal(inserted[0].outcome, "failed");
    assert.equal(flights.length, 0);
  });

  it("selhání zápisu letu neshodí výsledek zásahu", async () => {
    // Úloha je ve FlightHubu založená a dron poletí; zásah nese
    // fh_task_uuid, takže se let dá dohledat ručně.
    const { deps: d } = deps({
      insertFlight: async () => {
        throw new Error("databáze nedostupná");
      },
    });

    const result = await runDispatch(context(), d);

    assert.deepEqual(result, {
      status: "recorded",
      outcome: "sent",
      dispatchId: "dispatch-1",
    });
  });
});


describe("cooldown se počítá z času přijetí", () => {
  it("detekce datovaná zpět cooldown neobejde", async () => {
    // Bez tohohle stačilo poslat detekci s detected_at o pět minut
    // zpátky a cooldown se tvářil jako uplynulý. Čas přijetí si
    // odesílatel neurčuje.
    const prijato = new Date("2026-08-24T22:00:00Z");
    const poslednyZasah = new Date("2026-08-24T21:55:00Z"); // před 5 min

    const { deps: d, inserted } = deps({
      lastSentDispatchAt: async () => poslednyZasah,
    });

    await runDispatch(
      context({
        // Kamera tvrdí, že se to stalo o hodinu dřív.
        detectedAt: new Date("2026-08-24T21:00:00Z"),
        receivedAt: prijato,
        siteCooldownSeconds: 900,
      }),
      d,
    );

    assert.equal(inserted.length, 1);
    assert.equal(inserted[0].outcome, "suppressed_cooldown");
  });

  it("po uplynutí cooldownu zásah odejde", async () => {
    const { deps: d, inserted } = deps({
      lastSentDispatchAt: async () => new Date("2026-08-24T21:00:00Z"),
    });

    await runDispatch(
      context({
        detectedAt: new Date("2026-08-24T22:00:00Z"),
        receivedAt: new Date("2026-08-24T22:00:00Z"),
        siteCooldownSeconds: 900,
      }),
      d,
    );

    assert.equal(inserted[0].outcome, "sent");
  });
});
