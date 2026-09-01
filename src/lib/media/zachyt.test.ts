import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { jmenoSouboru } from "./zachyt.ts";

describe("jmenoSouboru", () => {
  const kdy = new Date(2026, 8, 1, 19, 54, 45);

  it("nese kameru i čas, ať se to dá v galerii najít", () => {
    assert.equal(jmenoSouboru("M_03", "jpg", kdy), "M_03-20260901-195445.jpg");
  });

  it("mezery a diakritika se nahradí — souborový systém je nemá rád", () => {
    assert.equal(
      jmenoSouboru("Klanečná — jeřáb", "mp4", kdy),
      "Klane-n-je-b-20260901-195445.mp4",
    );
  });

  it("z prázdného jména nevznikne soubor začínající pomlčkou", () => {
    assert.equal(jmenoSouboru("···", "jpg", kdy), "kamera-20260901-195445.jpg");
  });

  it("jednociferné hodnoty se doplní nulou", () => {
    assert.equal(
      jmenoSouboru("A", "jpg", new Date(2026, 0, 5, 7, 8, 9)),
      "A-20260105-070809.jpg",
    );
  });
});
