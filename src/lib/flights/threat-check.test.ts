import { strict as assert } from "node:assert";
import { afterEach, describe, it } from "node:test";

import { checkFlightThreat } from "./sync.ts";

// Zapojení kontroly snímků do synchronizace: co se přečte, co se
// zapíše a kdy se razítko NEZAPÍŠE. Databáze i model jsou zástupné —
// jde o pořadí a rozhodování, ne o síť.

type Zapis = Record<string, unknown>;

interface Stav {
  photos: { id: string; storage_path: string }[];
  count: number;
  /** Odpovědi modelu v pořadí, v jakém se má ptát. */
  odpovedi: (string | null)[];
  zapisy: Zapis[];
  stazeno: string[];
  /** Které cesty se nemají podařit stáhnout. */
  nestahnutelne?: Set<string>;
}

/**
 * Zástupný klient: každá metoda vrací sebe a celý řetěz jde awaitovat.
 * Díky tomu nemusí test kopírovat tvar PostgREST volání.
 */
function fakeDb(stav: Stav) {
  const vysledek = (data: unknown, extra: Zapis = {}) => {
    const chain: Record<string, unknown> = {
      then: (resolve: (v: unknown) => unknown) =>
        Promise.resolve({ data, error: null, ...extra }).then(resolve),
    };
    for (const name of ["select", "eq", "order", "limit", "returns", "update", "in"]) {
      chain[name] = (...args: unknown[]) => {
        if (name === "update") stav.zapisy.push(args[0] as Zapis);
        return chain;
      };
    }
    return chain;
  };

  return {
    from(table: string) {
      if (table === "media") return vysledek(stav.photos, { count: stav.count });
      return vysledek(null);
    },
    storage: {
      from() {
        return {
          async download(path: string) {
            if (stav.nestahnutelne?.has(path)) {
              return { data: null, error: { message: "nenalezeno" } };
            }
            stav.stazeno.push(path);
            return {
              data: new Blob([new Uint8Array([1, 2, 3])], { type: "image/jpeg" }),
              error: null,
            };
          },
        };
      },
    },
  } as unknown as Parameters<typeof checkFlightThreat>[0];
}

function stubFetch(odpovedi: (string | null)[]) {
  let i = 0;
  globalThis.fetch = (async () => {
    const text = odpovedi[i++] ?? null;
    if (text === null) return new Response("chyba", { status: 500 });
    return Response.json({ content: [{ type: "text", text }] });
  }) as typeof fetch;
}

const puvodniFetch = globalThis.fetch;
const puvodniKlic = process.env.ANTHROPIC_API_KEY;

afterEach(() => {
  globalThis.fetch = puvodniFetch;
  if (puvodniKlic === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = puvodniKlic;
});

function fotky(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: `m${i}`,
    storage_path: `site/flight/m${i}.jpg`,
  }));
}

const NALEZ = '{"threat": true, "note": "Muž u haly", "confidence": 0.94}';
const CISTO = '{"threat": false, "note": "Prázdný dvůr", "confidence": 0.9}';
const NEJISTE = '{"threat": false, "note": "Tma", "confidence": 0.3}';

describe("checkFlightThreat", () => {
  it("nález zapíše jako potvrzené nebezpečí", async () => {
    process.env.ANTHROPIC_API_KEY = "test";
    const stav: Stav = {
      photos: fotky(2),
      count: 2,
      odpovedi: [CISTO, NALEZ],
      zapisy: [],
      stazeno: [],
    };
    stubFetch(stav.odpovedi);

    const r = await checkFlightThreat(fakeDb(stav), { id: "f1", site_id: null });

    assert.equal(r.checked, true);
    assert.equal(r.confirmed, true);
    assert.equal(stav.zapisy.length, 1);
    assert.equal(stav.zapisy[0].threat_confirmed, true);
    assert.ok(String(stav.zapisy[0].threat_note).includes("Muž u haly"));
    assert.ok(stav.zapisy[0].threat_checked_at);
  });

  it("samé čisté snímky zapíše jako false", async () => {
    process.env.ANTHROPIC_API_KEY = "test";
    const stav: Stav = {
      photos: fotky(2),
      count: 2,
      odpovedi: [CISTO, CISTO],
      zapisy: [],
      stazeno: [],
    };
    stubFetch(stav.odpovedi);

    const r = await checkFlightThreat(fakeDb(stav), { id: "f1", site_id: null });
    assert.equal(r.confirmed, false);
    assert.equal(stav.zapisy[0].threat_confirmed, false);
  });

  it("nejistý snímek shodí závěr na null, ale razítko se zapíše", async () => {
    process.env.ANTHROPIC_API_KEY = "test";
    const stav: Stav = {
      photos: fotky(2),
      count: 2,
      odpovedi: [CISTO, NEJISTE],
      zapisy: [],
      stazeno: [],
    };
    stubFetch(stav.odpovedi);

    const r = await checkFlightThreat(fakeDb(stav), { id: "f1", site_id: null });
    assert.equal(r.checked, true);
    assert.equal(r.confirmed, null);
    assert.equal(stav.zapisy[0].threat_confirmed, null);
  });

  it("let bez fotek se zapíše jako zkontrolovaný, ať se nezkouší donekonečna", async () => {
    process.env.ANTHROPIC_API_KEY = "test";
    const stav: Stav = { photos: [], count: 0, odpovedi: [], zapisy: [], stazeno: [] };
    stubFetch([]);

    const r = await checkFlightThreat(fakeDb(stav), { id: "f1", site_id: null });
    assert.equal(r.checked, true);
    assert.equal(r.confirmed, null);
    assert.match(String(stav.zapisy[0].threat_note), /žádné fotky/);
  });

  it("když se nepřečte ani jeden snímek, razítko se NEZAPÍŠE", async () => {
    // Jinak by výpadek API skončil jako „zkontrolováno, nejisté“
    // a na let už by se nikdo nepodíval.
    process.env.ANTHROPIC_API_KEY = "test";
    const stav: Stav = {
      photos: fotky(2),
      count: 2,
      odpovedi: [null, null],
      zapisy: [],
      stazeno: [],
    };
    stubFetch(stav.odpovedi);

    const r = await checkFlightThreat(fakeDb(stav), { id: "f1", site_id: null });
    assert.equal(r.checked, false);
    assert.equal(stav.zapisy.length, 0);
    assert.equal(r.problems.length, 1);
  });

  it("bez klíče k API se kontrola přeskočí bez chyby", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const stav: Stav = {
      photos: fotky(2),
      count: 2,
      odpovedi: [],
      zapisy: [],
      stazeno: [],
    };
    stubFetch([]);

    const r = await checkFlightThreat(fakeDb(stav), { id: "f1", site_id: null });
    assert.equal(r.checked, false);
    // Chybějící nastavení není selhání běhu — cron nesmí kvůli němu
    // hlásit chybu při každém spuštění.
    assert.deepEqual(r.problems, []);
    assert.equal(stav.stazeno.length, 0);
  });

  it("nestažitelný snímek se počítá jako nepřečtený, ne jako čistý", async () => {
    process.env.ANTHROPIC_API_KEY = "test";
    const photos = fotky(2);
    const stav: Stav = {
      photos,
      count: 2,
      odpovedi: [CISTO],
      zapisy: [],
      stazeno: [],
      nestahnutelne: new Set([photos[0].storage_path]),
    };
    stubFetch(stav.odpovedi);

    const r = await checkFlightThreat(fakeDb(stav), { id: "f1", site_id: null });
    assert.equal(r.skipped, 1);
    assert.equal(r.confirmed, null);
  });

  it("useknutá dávka se počítá jako nepřečtené snímky", async () => {
    // count říká, že fotek je víc, než kolik se jich vzalo. Tvrdit
    // „nic tam není“ na základě části by lhalo.
    process.env.ANTHROPIC_API_KEY = "test";
    const stav: Stav = {
      photos: fotky(8),
      count: 30,
      odpovedi: Array(8).fill(CISTO),
      zapisy: [],
      stazeno: [],
    };
    stubFetch(stav.odpovedi);

    const r = await checkFlightThreat(fakeDb(stav), { id: "f1", site_id: null });
    assert.equal(r.confirmed, null);
    assert.equal(stav.stazeno.length, 8);
  });
});
