import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { clientIp, takeIngestToken } from "./rate-limit.ts";

/** Falešný klient, který si pamatuje, na co se ho ptali. */
function db(odpovedi: (boolean | "chyba")[]) {
  const volani: { keys: string[]; capacity: number }[] = [];
  let i = 0;
  return {
    volani,
    klient: {
      rpc: async (_name: string, args: Record<string, unknown>) => {
        volani.push({
          keys: args.p_keys as string[],
          capacity: args.p_capacity as number,
        });
        const odpoved = odpovedi[i++];
        if (odpoved === "chyba") return { data: null, error: { message: "x" } };
        return { data: odpoved, error: null };
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
  };
}

describe("takeIngestToken", () => {
  it("pustí, když mají žetony obě vědra", async () => {
    const { klient, volani } = db([true, true]);
    const v = await takeIngestToken(klient, { cameraSerial: "CAM-1", ip: "1.2.3.4" });
    assert.equal(v.allowed, true);
    assert.deepEqual(volani.map((c) => c.keys), [["cam:CAM-1"], ["ip:1.2.3.4"]]);
  });

  it("odmítne na vyčerpané kameře a na IP se už neptá", async () => {
    const { klient, volani } = db([false]);
    const v = await takeIngestToken(klient, { cameraSerial: "CAM-1", ip: "1.2.3.4" });
    assert.equal(v.allowed, false);
    assert.equal(v.reason, "camera");
    assert.equal(volani.length, 1);
  });

  it("odmítne na vyčerpané IP i s volnou kamerou", async () => {
    const { klient } = db([true, false]);
    const v = await takeIngestToken(klient, { cameraSerial: "CAM-1", ip: "9.9.9.9" });
    assert.equal(v.allowed, false);
    assert.equal(v.reason, "ip");
  });

  it("IP má vyšší strop než kamera — za ní může být celý areál", async () => {
    const { klient, volani } = db([true, true]);
    await takeIngestToken(klient, { cameraSerial: "CAM-1", ip: "1.2.3.4" });
    assert.ok(volani[1].capacity > volani[0].capacity);
  });

  it("nedostupná databáze požadavek pustí, ne umlčí", async () => {
    // Limit je ochrana proti zahlcení, ne autentizace. Výpadek databáze
    // nesmí znamenat ztracené detekce.
    const { klient } = db(["chyba"]);
    const v = await takeIngestToken(klient, { cameraSerial: "CAM-1", ip: "1.2.3.4" });
    assert.equal(v.allowed, true);
    assert.equal(v.reason, "unavailable");
  });

  it("bez sériového čísla i IP se neptá vůbec", async () => {
    const { klient, volani } = db([]);
    const v = await takeIngestToken(klient, { cameraSerial: null, ip: null });
    assert.equal(v.allowed, true);
    assert.equal(volani.length, 0);
  });
});

describe("clientIp", () => {
  it("bere první položku z x-forwarded-for", () => {
    const h = new Headers({ "x-forwarded-for": "203.0.113.7, 10.0.0.1, 10.0.0.2" });
    assert.equal(clientIp(h), "203.0.113.7");
  });

  it("spadne zpět na x-real-ip", () => {
    assert.equal(clientIp(new Headers({ "x-real-ip": "198.51.100.9" })), "198.51.100.9");
  });

  it("bez hlaviček vrací null", () => {
    assert.equal(clientIp(new Headers()), null);
  });

  it("nesmyslně dlouhou hodnotu ořízne", () => {
    const h = new Headers({ "x-forwarded-for": "a".repeat(500) });
    assert.equal(clientIp(h)?.length, 45);
  });
});
