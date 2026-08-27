import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  cameraSilenceWarnings,
  cameraWarnings,
  dockWarnings,
  formatUntil,
  patrolWarnings,
  platelessGateWarnings,
  relayCameraWarnings,
  stuckWorkWarnings,
  unknownPlateWarnings,
  zoneWarnings,
} from "./dashboard.ts";
import type { DockState } from "./dispatch/flighthub.ts";

const ZDRAVY: DockState = {
  droneInDock: true,
  droneStatus: "power_off",
  batteryPercent: 94,
  chargeState: "idle",
  storageUsedPercent: 30,
  remainUpload: 0,
  conditions: null,
  latitude: 50.3305,
  longitude: 15.4256,
};

describe("dockWarnings", () => {
  it("zdravý dok nic nehlásí", () => {
    assert.deepEqual(dockWarnings(ZDRAVY), []);
  });

  it("vypnutý dron v doku není problém", () => {
    // power_off je běžný stav mezi lety.
    assert.deepEqual(dockWarnings({ ...ZDRAVY, droneStatus: "power_off" }), []);
  });

  it("dron mimo dok se hlásí", () => {
    const w = dockWarnings({ ...ZDRAVY, droneInDock: false });
    assert.equal(w.length, 1);
    assert.match(w[0].text, /není v doku/);
  });

  it("úložiště nad 90 %", () => {
    const w = dockWarnings({ ...ZDRAVY, storageUsedPercent: 91 });
    assert.match(w[0].text, /91 %/);
  });

  it("přesně 90 % ještě nevaruje", () => {
    assert.deepEqual(dockWarnings({ ...ZDRAVY, storageUsedPercent: 90 }), []);
  });

  it("plné úložiště zmíní i čekající soubory", () => {
    const w = dockWarnings({ ...ZDRAVY, storageUsedPercent: 96, remainUpload: 42 });
    assert.match(w[0].text, /42 souborů/);
  });

  it("baterie pod 40 %", () => {
    const w = dockWarnings({ ...ZDRAVY, batteryPercent: 39 });
    assert.match(w[0].text, /39 %/);
  });

  it("přesně 40 % ještě nevaruje", () => {
    assert.deepEqual(dockWarnings({ ...ZDRAVY, batteryPercent: 40 }), []);
  });

  it("neznámé hodnoty nevaruje, ne že by mlčky předpokládala nulu", () => {
    assert.deepEqual(
      dockWarnings({ ...ZDRAVY, batteryPercent: null, storageUsedPercent: null }),
      [],
    );
  });

  it("víc potíží naráz dá víc varování", () => {
    const w = dockWarnings({
      ...ZDRAVY,
      droneInDock: false,
      batteryPercent: 12,
      storageUsedPercent: 99,
    });
    assert.equal(w.length, 3);
  });
});

describe("patrolWarnings", () => {
  const now = new Date("2026-08-26T12:00:00Z");
  const base = { name: "Ranní obchůzka", interval_minutes: 60, since: new Date("2026-08-01T00:00:00Z") };

  it("čerstvá hlídka nic nehlásí", () => {
    const w = patrolWarnings(
      [{ ...base, lastFlightAt: new Date("2026-08-26T11:30:00Z") }],
      now,
    );
    assert.deepEqual(w, []);
  });

  it("přesně dvojnásobek intervalu ještě projde", () => {
    const w = patrolWarnings(
      [{ ...base, lastFlightAt: new Date("2026-08-26T10:00:00Z") }],
      now,
    );
    assert.deepEqual(w, []);
  });

  it("nad dvojnásobek se hlásí", () => {
    const w = patrolWarnings(
      [{ ...base, lastFlightAt: new Date("2026-08-26T09:00:00Z") }],
      now,
    );
    assert.equal(w.length, 1);
    assert.match(w[0].text, /Ranní obchůzka/);
    assert.match(w[0].text, /3 h/);
  });

  it("hlídka, která nikdy neletěla", () => {
    const w = patrolWarnings([{ ...base, lastFlightAt: null }], now);
    assert.equal(w.length, 1);
    assert.match(w[0].text, /nikdy neletěla/);
  });

  it("delší prodleva se počítá ve dnech", () => {
    const w = patrolWarnings(
      [{ ...base, lastFlightAt: new Date("2026-08-23T12:00:00Z") }],
      now,
    );
    assert.match(w[0].text, /3 dní/);
  });

  it("víc hlídek dá víc varování", () => {
    const w = patrolWarnings(
      [
        { ...base, lastFlightAt: new Date("2026-08-20T12:00:00Z") },
        { ...base, name: "Noční", lastFlightAt: new Date("2026-08-20T12:00:00Z") },
      ],
      now,
    );
    assert.equal(w.length, 2);
  });
});

describe("formatUntil", () => {
  const now = new Date("2026-08-26T12:00:00Z");

  it("minuty", () => {
    assert.equal(formatUntil(new Date("2026-08-26T12:45:00Z"), now), "za 45 min");
  });

  it("hodiny s minutami", () => {
    assert.equal(formatUntil(new Date("2026-08-26T15:12:00Z"), now), "za 3 h 12 min");
  });

  it("celé hodiny bez minut", () => {
    assert.equal(formatUntil(new Date("2026-08-26T18:00:00Z"), now), "za 6 h");
  });

  it("dny", () => {
    assert.equal(formatUntil(new Date("2026-08-29T18:00:00Z"), now), "za 3 dní 6 h");
  });

  it("minulost vrací null místo záporného času", () => {
    assert.equal(formatUntil(new Date("2026-08-26T11:00:00Z"), now), null);
  });

  it("právě teď taky null", () => {
    assert.equal(formatUntil(now, now), null);
  });
});

describe("patrolWarnings — vadná data", () => {
  const now = new Date("2026-08-26T12:00:00Z");

  it("neplatné datum nedá NaN, ale ticho", () => {
    const w = patrolWarnings(
      [
        {
          name: "Rozbitá",
          interval_minutes: 60,
          lastFlightAt: null,
          since: new Date("nesmysl"),
        },
      ],
      now,
    );
    assert.deepEqual(w, []);
  });

  it("nulový interval taky nevaruje", () => {
    const w = patrolWarnings(
      [
        {
          name: "Bez intervalu",
          interval_minutes: 0,
          lastFlightAt: new Date("2020-01-01T00:00:00Z"),
          since: new Date("2020-01-01T00:00:00Z"),
        },
      ],
      now,
    );
    assert.deepEqual(w, []);
  });
});

describe("cameraWarnings", () => {
  it("mlčí, když mají všechny kamery zónu", () => {
    assert.deepEqual(cameraWarnings({ total: 5, withoutZone: 0 }), []);
  });

  it("mlčí i bez kamer", () => {
    assert.deepEqual(cameraWarnings({ total: 0, withoutZone: 0 }), []);
  });

  it("část kamer bez zóny", () => {
    const [warning] = cameraWarnings({ total: 5, withoutZone: 2 });
    assert.match(warning.text, /2 kamer nemá/);
    assert.ok(!warning.text.includes("žádný zásah"));
  });

  it("jedna kamera se skloňuje", () => {
    const [warning] = cameraWarnings({ total: 5, withoutZone: 1 });
    assert.match(warning.text, /^Jedna kamera nemá/);
  });

  it("když je bez zóny úplně všechno, řekne to natvrdo", () => {
    const [warning] = cameraWarnings({ total: 5, withoutZone: 5 });
    assert.match(warning.text, /nevznikne žádný zásah/);
  });
});

describe("cameraSilenceWarnings", () => {
  const now = new Date("2026-08-31T12:00:00Z");
  const pred = (minut: number) => new Date(now.getTime() - minut * 60_000);

  it("mlčí, když se všechny ozvaly nedávno", () => {
    assert.deepEqual(
      cameraSilenceWarnings(
        [{ name: "Brána", lastSeenAt: pred(10), online: true }],
        now,
      ),
      [],
    );
  });

  it("upozorní na kameru, která mlčí přes hodinu", () => {
    const [w] = cameraSilenceWarnings(
      [{ name: "Brána", lastSeenAt: pred(61), online: true }],
      now,
    );
    assert.match(w.text, /Brána/);
  });

  it("těsně pod prahem ještě nehlásí", () => {
    assert.deepEqual(
      cameraSilenceWarnings(
        [{ name: "Brána", lastSeenAt: pred(59), online: true }],
        now,
      ),
      [],
    );
  });

  it("kamera, která se nikdy neozvala, není rozbitá — jen nezapojená", () => {
    assert.deepEqual(
      cameraSilenceWarnings(
        [{ name: "Nová", lastSeenAt: null, online: true }],
        now,
      ),
      [],
    );
  });

  it("kamera vedená jako offline se nehlásí — o tom se ví jinak", () => {
    assert.deepEqual(
      cameraSilenceWarnings(
        [{ name: "Vypnutá", lastSeenAt: pred(500), online: false }],
        now,
      ),
      [],
    );
  });

  it("víc kamer se sloučí do jedné hlášky se jmény", () => {
    const [w] = cameraSilenceWarnings(
      [
        { name: "Brána", lastSeenAt: pred(90), online: true },
        { name: "Dvůr", lastSeenAt: pred(200), online: true },
      ],
      now,
    );
    assert.match(w.text, /2 kamer/);
    assert.match(w.text, /Brána, Dvůr/);
  });

  it("neplatné datum mlčí, ne aby hlásilo nesmysl", () => {
    assert.deepEqual(
      cameraSilenceWarnings(
        [{ name: "Rozbitá", lastSeenAt: new Date("nesmysl"), online: true }],
        now,
      ),
      [],
    );
  });
});

describe("unknownPlateWarnings", () => {
  it("mlčí, když nic neprojelo", () => {
    assert.deepEqual(unknownPlateWarnings([]), []);
  });

  it("mlčí u vjezdů mimo ostrý režim", () => {
    // Přes den auta jezdí; hlásit každé by z varování udělalo tapetu.
    assert.deepEqual(
      unknownPlateWarnings([{ plate: "1AB2345", armed: false }]),
      [],
    );
  });

  it("jedna neznámá značka se vypíše i s číslem", () => {
    const [w] = unknownPlateWarnings([{ plate: "1AB2345", armed: true }]);
    assert.match(w.text, /1AB2345/);
  });

  it("nepřečtená značka se hlásí taky, jen bez čísla", () => {
    const [w] = unknownPlateWarnings([{ plate: null, armed: true }]);
    assert.match(w.text, /nepodařilo přečíst/);
  });

  it("víc vjezdů se sloučí do počtu", () => {
    const [w] = unknownPlateWarnings([
      { plate: "1AB2345", armed: true },
      { plate: null, armed: true },
      { plate: "5XY0000", armed: false },
    ]);
    assert.match(w.text, /2 vozidel/);
  });
});

describe("zoneWarnings", () => {
  it("mlčí, když mají všechny zóny trasu", () => {
    assert.deepEqual(zoneWarnings({ total: 3, withoutWayline: 0 }), []);
  });

  it("mlčí i bez zón", () => {
    assert.deepEqual(zoneWarnings({ total: 0, withoutWayline: 0 }), []);
  });

  it("část zón bez trasy", () => {
    const [warning] = zoneWarnings({ total: 3, withoutWayline: 2 });
    assert.match(warning.text, /2 zón nemá/);
    assert.ok(!warning.text.includes("žádný zásah"));
  });

  it("jedna zóna se skloňuje", () => {
    const [warning] = zoneWarnings({ total: 3, withoutWayline: 1 });
    assert.match(warning.text, /^Jedna zóna nemá/);
  });

  it("když je bez trasy úplně všechno, řekne to natvrdo", () => {
    const [warning] = zoneWarnings({ total: 3, withoutWayline: 3 });
    assert.match(warning.text, /nevznikne žádný zásah/);
  });
});

describe("skloňování ve varováních", () => {
  it("víc zón bez trasy má „z nich“, ne „z ní“", () => {
    const [warning] = zoneWarnings({ total: 5, withoutWayline: 2 });
    assert.match(warning.text, /z nich dron nevzlétne/);
  });

  it("jedna zóna má „z ní“", () => {
    const [warning] = zoneWarnings({ total: 5, withoutWayline: 1 });
    assert.match(warning.text, /z ní dron nevzlétne/);
  });

  it("totéž u kamer bez zóny", () => {
    assert.match(cameraWarnings({ total: 5, withoutZone: 2 })[0].text, /z nich zásah/);
    assert.match(cameraWarnings({ total: 5, withoutZone: 1 })[0].text, /z ní zásah/);
  });
});

describe("platelessGateWarnings", () => {
  const brana = { id: "c1", name: "Brána", readsPlate: true };
  const perimetr = { id: "c2", name: "Perimetr", readsPlate: false };

  const vjezdy = (cameraId: string, plates: boolean[]) =>
    plates.map((hasPlate) => ({ cameraId, hasPlate }));

  it("brána bez jediné značky se ohlásí", () => {
    const w = platelessGateWarnings([brana], vjezdy("c1", [false, false, false]));
    assert.equal(w.length, 1);
    assert.match(w[0].text, /Brána/);
    assert.match(w[0].text, /bez značky/);
  });

  it("jedna přečtená značka varování zruší", () => {
    // Čtení funguje, jen se jednou nepovedlo — na to je varování
    // o neznámých značkách.
    const w = platelessGateWarnings([brana], vjezdy("c1", [false, true, false, false]));
    assert.deepEqual(w, []);
  });

  it("dva nepřečtené vjezdy jsou málo na závěr", () => {
    // Bláto na značce nebo protisvětlo. Práh je tři.
    assert.deepEqual(platelessGateWarnings([brana], vjezdy("c1", [false, false])), []);
  });

  it("kamera, která značky číst nemá, se neřeší", () => {
    const w = platelessGateWarnings([perimetr], vjezdy("c2", [false, false, false, false]));
    assert.deepEqual(w, []);
  });

  it("vjezdy jiné kamery se nepočítají", () => {
    const w = platelessGateWarnings(
      [brana],
      [...vjezdy("c1", [false, true]), ...vjezdy("c2", [false, false, false])],
    );
    assert.deepEqual(w, []);
  });

  it("bez vjezdů mlčí", () => {
    assert.deepEqual(platelessGateWarnings([brana], []), []);
  });
});

describe("stuckWorkWarnings", () => {
  it("bez nálezu mlčí", () => {
    assert.deepEqual(
      stuckWorkWarnings({ detectionsWithoutDispatch: 0, passagesWithoutRead: 0 }),
      [],
    );
  });

  it("detekce bez zásahu se ohlásí", () => {
    // Zásah běží v after(). Když ho Vercel ukončí dřív, nezůstane po
    // něm ani potlačený řádek — a vypadá to jako kamera bez zóny.
    const w = stuckWorkWarnings({ detectionsWithoutDispatch: 1, passagesWithoutRead: 0 });
    assert.equal(w.length, 1);
    assert.match(w[0].text, /Jedna detekce/);
    assert.match(w[0].text, /ani potlačený/);
  });

  it("víc detekcí se počítá, ne vyjmenovává", () => {
    const w = stuckWorkWarnings({ detectionsWithoutDispatch: 7, passagesWithoutRead: 0 });
    assert.match(w[0].text, /7 detekcí/);
  });

  it("vjezd bez přečtené značky se ohlásí zvlášť", () => {
    const w = stuckWorkWarnings({ detectionsWithoutDispatch: 0, passagesWithoutRead: 2 });
    assert.equal(w.length, 1);
    assert.equal(w[0].key, "passages_without_plate_read");
    assert.match(w[0].text, /2 vjezdů/);
  });

  it("obojí naráz dá dvě varování", () => {
    // Jsou to dvě různé diagnózy: zásah a čtení značky běží každé
    // jinou cestou.
    const w = stuckWorkWarnings({ detectionsWithoutDispatch: 3, passagesWithoutRead: 1 });
    assert.equal(w.length, 2);
    assert.deepEqual(w.map((x) => x.key), [
      "detections_without_dispatch",
      "passages_without_plate_read",
    ]);
  });
});

describe("relayCameraWarnings", () => {
  const ftp = (name: string, lan_ip: string | null) => ({
    name,
    ingest_mode: "ftp",
    lan_ip,
  });

  it("kamera přes relay bez adresy je varování", () => {
    const out = relayCameraWarnings([ftp("Jeřáb", null)]);
    assert.equal(out.length, 1);
    assert.match(out[0].text, /Jeřáb/);
  });

  it("text říká, proč to není poznat jinak", () => {
    // Tohle je celý smysl varování: kamera bez adresy posílá záznamy
    // dál a v portálu se tváří živá. Kdyby text jen řekl „chybí IP“,
    // nikdo by nepochopil, že přišel o detekce.
    const out = relayCameraWarnings([ftp("Jeřáb", null)]);
    assert.match(out[0].text, /nepřijde žádná detekce/);
    assert.match(out[0].text, /Záznamy chodí dál/);
  });

  it("vyplněná adresa nevaruje", () => {
    assert.deepEqual(relayCameraWarnings([ftp("Jeřáb", "192.168.11.51")]), []);
  });

  it("kamera u brány adresu potřebovat nemusí", () => {
    // Ta se hlásí sama, portál se na ni nepřipojuje.
    assert.deepEqual(
      relayCameraWarnings([{ name: "Vjezd", ingest_mode: "http", lan_ip: null }]),
      [],
    );
  });

  it("víc kamer se vypíše jmenovitě", () => {
    const out = relayCameraWarnings([ftp("Jeřáb", null), ftp("Vrata", null)]);
    assert.equal(out.length, 1);
    assert.match(out[0].text, /Jeřáb/);
    assert.match(out[0].text, /Vrata/);
  });
});
