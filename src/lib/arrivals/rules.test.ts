import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { localDateISO, matchArrival, type ArrivalCandidate } from "./rules.ts";

const DNES = "2026-08-26";

function ohlaseni(over: Partial<ArrivalCandidate> = {}): ArrivalCandidate {
  return {
    id: "a1",
    plate: "1AB 2345",
    arrival_date: DNES,
    night_ok: false,
    cancelled_at: null,
    ...over,
  };
}

describe("matchArrival — párování", () => {
  it("normalizovaná shoda projde přes mezery i malá písmena", () => {
    const v = matchArrival({
      plate: "1ab2345",
      today: DNES,
      armed: false,
      candidates: [ohlaseni()],
    });
    assert.equal(v.covered, true);
    assert.equal(v.arrival?.id, "a1");
  });

  it("jiná značka nesedí", () => {
    const v = matchArrival({
      plate: "9ZZ0000",
      today: DNES,
      armed: false,
      candidates: [ohlaseni()],
    });
    assert.equal(v.covered, false);
    assert.equal(v.reason, "no_match");
  });

  it("ohlášení na jiný den nesedí", () => {
    const v = matchArrival({
      plate: "1AB2345",
      today: DNES,
      armed: false,
      candidates: [ohlaseni({ arrival_date: "2026-08-27" })],
    });
    assert.equal(v.reason, "no_match");
  });

  it("zrušené ohlášení nesedí", () => {
    const v = matchArrival({
      plate: "1AB2345",
      today: DNES,
      armed: false,
      candidates: [ohlaseni({ cancelled_at: "2026-08-26T08:00:00Z" })],
    });
    assert.equal(v.reason, "no_match");
  });

  it("nepřečtená značka se nepáruje", () => {
    // Nejistou značku sem volající vůbec nepustí; kdyby přece,
    // nesmí odbavit cizí auto.
    const v = matchArrival({
      plate: null,
      today: DNES,
      armed: true,
      candidates: [ohlaseni({ night_ok: true })],
    });
    assert.equal(v.reason, "no_match");
  });

  it("značka bez alfanumerických znaků se nepáruje", () => {
    const v = matchArrival({
      plate: "---",
      today: DNES,
      armed: false,
      candidates: [ohlaseni({ plate: "---" })],
    });
    assert.equal(v.reason, "no_match");
  });

  it("bez ohlášení nic", () => {
    const v = matchArrival({ plate: "1AB2345", today: DNES, armed: false, candidates: [] });
    assert.equal(v.reason, "no_match");
    assert.equal(v.arrival, null);
  });
});

describe("matchArrival — tři pravidla", () => {
  it("mimo ostrý režim ohlášení kryje", () => {
    const v = matchArrival({
      plate: "1AB2345",
      today: DNES,
      armed: false,
      candidates: [ohlaseni()],
    });
    assert.equal(v.covered, true);
    assert.equal(v.reason, "disarmed");
  });

  it("v ostrém režimu bez night_ok NEKRYJE", () => {
    // Ohlásit denní rozvoz nesmí být zadní vrátka na noc.
    const v = matchArrival({
      plate: "1AB2345",
      today: DNES,
      armed: true,
      candidates: [ohlaseni({ night_ok: false })],
    });
    assert.equal(v.covered, false);
    assert.equal(v.reason, "night_not_allowed");
    // Ohlášení se přesto vrací — patří do záznamu o vjezdu.
    assert.equal(v.arrival?.id, "a1");
  });

  it("v ostrém režimu s night_ok kryje", () => {
    const v = matchArrival({
      plate: "1AB2345",
      today: DNES,
      armed: true,
      candidates: [ohlaseni({ night_ok: true })],
    });
    assert.equal(v.covered, true);
    assert.equal(v.reason, "night_ok");
  });

  it("z víc ohlášení téže značky stačí jedno noční", () => {
    const v = matchArrival({
      plate: "1AB2345",
      today: DNES,
      armed: true,
      candidates: [
        ohlaseni({ id: "denni", night_ok: false }),
        ohlaseni({ id: "nocni", night_ok: true }),
      ],
    });
    assert.equal(v.covered, true);
    assert.equal(v.arrival?.id, "nocni");
  });

  it("mimo režim je night_ok jedno", () => {
    for (const night of [true, false]) {
      const v = matchArrival({
        plate: "1AB2345",
        today: DNES,
        armed: false,
        candidates: [ohlaseni({ night_ok: night })],
      });
      assert.equal(v.covered, true, `night_ok=${night}`);
    }
  });
});

describe("localDateISO", () => {
  it("dá kalendářní den v pásmu lokality", () => {
    // 21:30 UTC je v Praze už 23:30 téhož dne (léto).
    assert.equal(
      localDateISO("Europe/Prague", new Date("2026-08-26T21:30:00Z")),
      "2026-08-26",
    );
  });

  it("po půlnoci místního času je to už další den", () => {
    // 22:30 UTC = 00:30 v Praze. Bez přepočtu by ohlášení na dnešní
    // večer viselo pod včerejším datem.
    assert.equal(
      localDateISO("Europe/Prague", new Date("2026-08-26T22:30:00Z")),
      "2026-08-27",
    );
  });

  it("měsíc i den mají dvě číslice", () => {
    assert.equal(
      localDateISO("Europe/Prague", new Date("2026-01-05T12:00:00Z")),
      "2026-01-05",
    );
  });

  it("zimní čas posouvá o hodinu míň", () => {
    // 23:30 UTC v lednu je 00:30 v Praze.
    assert.equal(
      localDateISO("Europe/Prague", new Date("2026-01-05T23:30:00Z")),
      "2026-01-06",
    );
  });
});
