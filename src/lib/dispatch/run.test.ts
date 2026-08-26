import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  DISPATCH_LEAD_SECONDS,
  runDispatch,
  type DispatchDeps,
  type DispatchNotification,
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
  const notifikace: DispatchNotification[] = [];
  const base: DispatchDeps = {
    isSiteArmed: async () => true,
    lastSentDispatchAt: async () => ({ known: true, at: null }),
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
    notifyDispatch: async (input) => {
      notifikace.push(input);
      return { sent: 1, skipped: 0, removed: 0, failed: 0 };
    },
    ...overrides,
  };
  return { deps: base, inserted, flights, notifikace };
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
      lastSentDispatchAt: async () => ({ known: true, at: poslednyZasah }),
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
      lastSentDispatchAt: async () => ({ known: true, at: new Date("2026-08-24T21:00:00Z") }),
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

describe("runDispatch — notifikace", () => {
  it("odeslaný zásah pošle notifikaci s odkazem na detail", async () => {
    const { deps: d, notifikace } = deps();

    await runDispatch(context(), d);

    assert.equal(notifikace.length, 1);
    assert.equal(notifikace[0].outcome, "sent");
    assert.equal(notifikace[0].dispatchId, "dispatch-1");
    assert.equal(notifikace[0].zoneName, "Brána sever");
  });

  it("potlačený zásah taky, ať je poznat, že se neletělo", async () => {
    const { deps: d, notifikace } = deps({ isSiteArmed: async () => false });

    await runDispatch(context(), d);

    assert.equal(notifikace.length, 1);
    assert.equal(notifikace[0].outcome, "suppressed_disarmed");
  });

  it("selhání notifikace nezmění výsledek zásahu", async () => {
    // Notifikace je doplněk k zapsanému zásahu, ne jeho součást.
    const { deps: d } = deps({
      notifyDispatch: async () => {
        throw new Error("push služba nedostupná");
      },
    });

    const result = await runDispatch(context(), d);

    assert.deepEqual(result, {
      status: "recorded",
      outcome: "sent",
      dispatchId: "dispatch-1",
    });
  });

  it("bez zapsaného zásahu se neposílá nic", async () => {
    // Odkaz by nevedl nikam.
    const { deps: d, notifikace } = deps({ insertDispatch: async () => null });

    await runDispatch(context(), d);

    assert.equal(notifikace.length, 0);
  });

  it("kamera bez zóny notifikaci nespustí", async () => {
    const { deps: d, notifikace } = deps();
    await runDispatch(context({ zoneId: null }), d);
    assert.equal(notifikace.length, 0);
  });
});

describe("runDispatch — tichá selhání vstupů", () => {
  it("nezjištěný režim střežení je suppressed_unknown, ne disarmed", async () => {
    // Rozdíl je podstatný: 'disarmed' tvrdí něco o areálu, tohle
    // přiznává, že se to nezjišťovalo.
    const { deps: d, inserted } = deps({ isSiteArmed: async () => null });

    await runDispatch(context(), d);

    assert.equal(inserted[0].outcome, "suppressed_unknown");
    assert.equal(inserted[0].decision_reason?.armed, null);
    assert.deepEqual(inserted[0].decision_reason?.unknown_inputs, ["armed"]);
    assert.equal(
      (inserted[0].response as Record<string, unknown>).cause,
      "armed_unknown",
    );
  });

  it("nezjištěný cooldown zásah zastaví a zapíše se do důvodu", async () => {
    const { deps: d, inserted, flights } = deps({
      lastSentDispatchAt: async () => ({ known: false, at: null }),
    });

    await runDispatch(context(), d);

    assert.equal(inserted[0].outcome, "suppressed_unknown");
    assert.deepEqual(inserted[0].decision_reason?.unknown_inputs, ["cooldown"]);
    // Nic neodletělo — to je celý smysl fail-closed.
    assert.equal(flights.length, 0);
  });

  it("nezjištěná eskalace zásah pustí na základním stupni", async () => {
    // Fail-open. Osoba dá pětku i tak, protože to je její základ.
    const { deps: d, inserted } = deps({
      hasRecentPersonInOtherZone: async () => null,
    });

    await runDispatch(context({ objectClass: "vehicle" }), d);

    assert.equal(inserted[0].outcome, "sent");
    assert.equal(inserted[0].level_sent, 2);
    assert.equal(inserted[0].decision_reason?.escalated, false);
    assert.deepEqual(inserted[0].decision_reason?.unknown_inputs, ["escalation"]);
  });

  it("úplné vstupy pole unknown_inputs vůbec nezakládají", async () => {
    // Ať se v důvodu neobjeví prázdné pole, které vypadá jako údaj.
    const { deps: d, inserted } = deps();
    await runDispatch(context(), d);
    assert.equal(inserted[0].decision_reason?.unknown_inputs, undefined);
  });

  it("vypnutá zóna je rozhodnutí, ne neznalost", async () => {
    // Zóna se nevyhodnocuje dotazem, takže tu není co nezjistit.
    const { deps: d, inserted } = deps();
    await runDispatch(context({ zoneEnabled: false }), d);

    assert.equal(inserted[0].outcome, "suppressed_disarmed");
    assert.equal(inserted[0].decision_reason?.armed, false);
    assert.equal(inserted[0].decision_reason?.unknown_inputs, undefined);
  });

  it("víc nezjištěných vstupů se zapíše všechny", async () => {
    const { deps: d, inserted } = deps({
      isSiteArmed: async () => null,
      lastSentDispatchAt: async () => ({ known: false, at: null }),
      hasRecentPersonInOtherZone: async () => null,
    });

    await runDispatch(context(), d);

    assert.deepEqual(inserted[0].decision_reason?.unknown_inputs, [
      "armed",
      "cooldown",
      "escalation",
    ]);
  });
});

describe("runDispatch — ruční zásah z portálu", () => {
  /** Kontext tlačítka: bez detekce, se jménem toho, kdo ho zmáčkl. */
  function rucni(overrides: Partial<DispatchContext> = {}) {
    return context({
      detectionId: null,
      manual: { actorId: "profil-1" },
      objectClass: "unknown",
      ...overrides,
    });
  }

  it("zapíše zásah bez detekce", async () => {
    // Schéma to tak má popsané od začátku: triggered_by_detection NULL
    // znamená ruční výjezd. Vyrobit kvůli tlačítku falešnou detekci by
    // znamenalo zapsat do důkazní tabulky událost, kterou nikdo neviděl.
    const { deps: d, inserted } = deps();
    const result = await runDispatch(rucni(), d);

    assert.equal(result.status, "recorded");
    assert.equal(inserted[0].triggered_by_detection, null);
    assert.equal(inserted[0].outcome, "sent");
  });

  it("letí na nejvyšším stupni, i když třída objektu je neurčeno", async () => {
    // Bez tohohle by ruční zásah jel na stupni 1 — tlačítko nemá třídu
    // objektu a BASE_LEVEL_BY_CLASS.unknown je nejnižší.
    const { deps: d, inserted } = deps();
    await runDispatch(rucni(), d);

    assert.equal(inserted[0].level_sent, 5);
    assert.equal(inserted[0].decision_reason?.base_level, 5);
  });

  it("v důvodu je autor a žádná třída objektu", async () => {
    const { deps: d, inserted } = deps();
    await runDispatch(rucni(), d);

    assert.deepEqual(inserted[0].decision_reason?.manual, { actor_id: "profil-1" });
    // „Neurčeno“ by v detailu vypadalo jako detekce, kterou se nepovedlo
    // rozpoznat.
    assert.equal(inserted[0].decision_reason?.object_class, null);
  });

  it("eskalace se nezjišťuje a nepočítá mezi neznámé vstupy", async () => {
    let dotazu = 0;
    const { deps: d, inserted } = deps({
      hasRecentPersonInOtherZone: async () => {
        dotazu += 1;
        return null;
      },
    });

    await runDispatch(rucni(), d);

    assert.equal(dotazu, 0);
    assert.equal(inserted[0].decision_reason?.unknown_inputs, undefined);
    assert.equal(inserted[0].decision_reason?.escalated, false);
  });

  it("mimo ostrý režim se ani na povel neletí", async () => {
    // Tlačítko nesmí být druhou sadou pravidel. Kdyby ostrý režim
    // obcházelo, vzlétl by dron nad areál, kde zrovna pracuje směna.
    const { deps: d, inserted, flights } = deps({ isSiteArmed: async () => false });
    const result = await runDispatch(rucni(), d);

    assert.equal(result.status, "recorded");
    assert.equal(inserted[0].outcome, "suppressed_disarmed");
    assert.equal(flights.length, 0);
  });

  it("cooldown platí stejně jako u detekce", async () => {
    const { deps: d, inserted } = deps({
      lastSentDispatchAt: async () => ({
        known: true,
        at: new Date("2026-08-24T21:55:00Z"),
      }),
    });

    await runDispatch(rucni(), d);
    assert.equal(inserted[0].outcome, "suppressed_cooldown");
  });

  it("nepřipravený dok zásah zastaví", async () => {
    const { deps: d, inserted } = deps({
      getDockState: async () => ({ ok: true, state: dockState({ batteryPercent: 12 }) }),
    });

    await runDispatch(rucni(), d);
    assert.equal(inserted[0].outcome, "suppressed_dock");
    assert.equal(inserted[0].decision_reason?.dock?.reason, "low_battery");
  });

  it("zóna bez trasy skončí jako neúspěch, ne jako odeslaný zásah", async () => {
    const { deps: d, inserted } = deps();
    await runDispatch(rucni({ zoneWaylineUuid: null }), d);

    assert.equal(inserted[0].outcome, "failed");
    assert.equal(
      (inserted[0].response as Record<string, unknown>).error,
      "zone_without_wayline",
    );
  });

  it("notifikace se nehlásí jako detekce", async () => {
    const { deps: d, notifikace } = deps();
    await runDispatch(rucni(), d);

    assert.equal(notifikace[0].manual, true);
  });

  it("úloha ve FlightHubu se jmenuje ručním zásahem", async () => {
    let name = "";
    const { deps: d } = deps({
      createFlightTask: async (input) => {
        name = input.name;
        return { taskUuid: "task-1", httpStatus: 200, response: { code: 0 }, ok: true };
      },
    });

    await runDispatch(rucni(), d);
    assert.match(name, /^Ruční zásah — Brána sever$/);
  });

  it("bez zóny se nezapíše nic — není kam letět", async () => {
    const { deps: d, inserted } = deps();
    const result = await runDispatch(rucni({ zoneId: null }), d);

    assert.equal(result.status, "skipped");
    assert.equal(inserted.length, 0);
  });

  it("let k odeslanému zásahu vznikne stejně jako u detekce", async () => {
    const { deps: d, flights } = deps();
    await runDispatch(rucni(), d);

    assert.equal(flights.length, 1);
    assert.equal(flights[0].fhTaskUuid, "task-1");
    assert.equal(flights[0].dispatchId, "dispatch-1");
    assert.ok(DISPATCH_LEAD_SECONDS > 0);
  });
});
