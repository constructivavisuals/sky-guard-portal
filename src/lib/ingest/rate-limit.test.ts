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
  it("hlavička od Vercelu má přednost", () => {
    // Tuhle si edge nastavuje sám a odesílatel ji přepsat nemůže.
    const h = new Headers({
      "x-vercel-forwarded-for": "203.0.113.7",
      "x-forwarded-for": "1.2.3.4, 203.0.113.7",
      "x-real-ip": "5.6.7.8",
    });
    assert.equal(clientIp(h), "203.0.113.7");
  });

  it("z x-forwarded-for bere POSLEDNÍ položku, ne první", () => {
    // První položku si připisuje odesílatel. Kdyby se brala, dala by
    // se jí obejít vědra na IP, nafouknout jejich tabulka a hlavně
    // podvrhnout detections.source_ip, který detail detekce ukazuje
    // jako doklad o původu.
    const h = new Headers({ "x-forwarded-for": "1.2.3.4, 10.0.0.1, 203.0.113.7" });
    assert.equal(clientIp(h), "203.0.113.7");
  });

  it("podvržená hlavička od odesílatele neprojde", () => {
    // Přesně ten útok: klient si do XFF napíše cizí adresu, proxy za
    // ni připíše tu skutečnou.
    const h = new Headers({ "x-forwarded-for": "8.8.8.8, 198.51.100.9" });
    assert.equal(clientIp(h), "198.51.100.9");
  });

  it("jediná položka je ta správná", () => {
    assert.equal(
      clientIp(new Headers({ "x-forwarded-for": "203.0.113.7" })),
      "203.0.113.7",
    );
  });

  it("x-real-ip má přednost před x-forwarded-for", () => {
    const h = new Headers({
      "x-real-ip": "198.51.100.9",
      "x-forwarded-for": "1.2.3.4",
    });
    assert.equal(clientIp(h), "198.51.100.9");
  });

  it("bez hlaviček vrací null", () => {
    assert.equal(clientIp(new Headers()), null);
  });

  it("prázdná hodnota se bere jako chybějící", () => {
    assert.equal(clientIp(new Headers({ "x-forwarded-for": "   " })), null);
    assert.equal(clientIp(new Headers({ "x-vercel-forwarded-for": "" })), null);
  });

  it("nesmyslně dlouhou hodnotu ořízne", () => {
    const h = new Headers({ "x-forwarded-for": "a".repeat(500) });
    assert.equal(clientIp(h)?.length, 45);
  });
});
