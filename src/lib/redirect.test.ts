import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { bezpecnyCil } from "./redirect.ts";

const ORIGIN = "https://portal.sky-guard.cz";

describe("bezpecnyCil", () => {
  it("vlastní cesta projde", () => {
    assert.equal(bezpecnyCil("/detekce", ORIGIN), "/detekce");
    assert.equal(bezpecnyCil("/zasahy/abc", ORIGIN), "/zasahy/abc");
  });

  it("ponechá dotaz i kotvu", () => {
    assert.equal(bezpecnyCil("/detekce?strana=2#x", ORIGIN), "/detekce?strana=2#x");
  });

  it("protokolově relativní adresa neprojde", () => {
    // Tohle byla ta díra: `//evil.tld` začíná lomítkem, takže původní
    // podmínka ho pustila — a odnesla uživatele pryč po úspěšném
    // přihlášení, kdy nic nevzbudí podezření.
    assert.equal(bezpecnyCil("//evil.tld", ORIGIN), "/prehled");
    assert.equal(bezpecnyCil("//evil.tld/prihlaseni", ORIGIN), "/prehled");
  });

  it("zpětné lomítko neprojde — prohlížeč ho přeloží na //", () => {
    assert.equal(bezpecnyCil("/\\evil.tld", ORIGIN), "/prehled");
  });

  it("absolutní cizí adresa neprojde", () => {
    assert.equal(bezpecnyCil("https://evil.tld", ORIGIN), "/prehled");
    assert.equal(bezpecnyCil("http://evil.tld", ORIGIN), "/prehled");
  });

  it("cizí schéma neprojde", () => {
    assert.equal(bezpecnyCil("javascript:alert(1)", ORIGIN), "/prehled");
    assert.equal(bezpecnyCil("data:text/html,x", ORIGIN), "/prehled");
  });

  it("prázdné a chybějící končí na přehledu", () => {
    assert.equal(bezpecnyCil(null, ORIGIN), "/prehled");
    assert.equal(bezpecnyCil("", ORIGIN), "/prehled");
  });

  it("adresa s vlastním původem se zkrátí na cestu", () => {
    assert.equal(bezpecnyCil("/lety", ORIGIN), "/lety");
  });

  it("bez známého původu radši přehled", () => {
    assert.equal(bezpecnyCil("/detekce", ""), "/prehled");
  });
});
