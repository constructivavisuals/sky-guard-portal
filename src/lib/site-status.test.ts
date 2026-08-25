import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { zonedTimeToUtc } from "./patrols/schedule.ts";
import { nextArmedTransition, type ArmedSchedule } from "./site-status.ts";

const PRAGUE = "Europe/Prague";

const nocni: ArmedSchedule = {
  timezone: PRAGUE,
  armed_from: "18:00:00",
  armed_to: "06:00:00",
  armed_days: [1, 2, 3, 4, 5],
};

function wall(date: Date): string {
  return new Intl.DateTimeFormat("cs-CZ", {
    timeZone: PRAGUE,
    hourCycle: "h23",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

describe("nextArmedTransition — noční okno Po–Pá", () => {
  it("odpoledne ve středu čeká zapnutí v 18:00", () => {
    const t = nextArmedTransition(nocni, zonedTimeToUtc(2026, 8, 26, 15, 0, PRAGUE));
    assert.ok(t);
    assert.equal(t.becomes, "armed");
    assert.equal(wall(t.at), "26. 08. 18:00");
  });

  it("v noci čeká vypnutí v 06:00", () => {
    const t = nextArmedTransition(nocni, zonedTimeToUtc(2026, 8, 26, 23, 0, PRAGUE));
    assert.ok(t);
    assert.equal(t.becomes, "disarmed");
    assert.equal(wall(t.at), "27. 08. 06:00");
  });

  it("v pátek v noci se po vypnutí čeká až na pondělí", () => {
    // Sobota ani neděle nejsou v armed_days, takže po sobotním ránu
    // přijde na řadu až pondělní večer.
    const t = nextArmedTransition(nocni, zonedTimeToUtc(2026, 8, 29, 7, 0, PRAGUE));
    assert.ok(t);
    assert.equal(t.becomes, "armed");
    assert.equal(wall(t.at), "31. 08. 18:00");
  });

  it("přesně na hranici se počítá už další přepnutí", () => {
    const t = nextArmedTransition(nocni, zonedTimeToUtc(2026, 8, 26, 18, 0, PRAGUE));
    assert.ok(t);
    assert.equal(t.becomes, "disarmed");
    assert.equal(wall(t.at), "27. 08. 06:00");
  });
});

describe("nextArmedTransition — denní okno", () => {
  const denni: ArmedSchedule = {
    timezone: PRAGUE,
    armed_from: "08:00:00",
    armed_to: "17:00:00",
    armed_days: [1, 2, 3, 4, 5, 6, 7],
  };

  it("ráno před oknem čeká zapnutí", () => {
    const t = nextArmedTransition(denni, zonedTimeToUtc(2026, 8, 26, 6, 0, PRAGUE));
    assert.ok(t);
    assert.equal(t.becomes, "armed");
    assert.equal(wall(t.at), "26. 08. 08:00");
  });

  it("uvnitř okna čeká vypnutí", () => {
    const t = nextArmedTransition(denni, zonedTimeToUtc(2026, 8, 26, 12, 0, PRAGUE));
    assert.ok(t);
    assert.equal(t.becomes, "disarmed");
    assert.equal(wall(t.at), "26. 08. 17:00");
  });

  it("večer po okně čeká ráno dalšího dne", () => {
    const t = nextArmedTransition(denni, zonedTimeToUtc(2026, 8, 26, 20, 0, PRAGUE));
    assert.ok(t);
    assert.equal(wall(t.at), "27. 08. 08:00");
  });
});

describe("nextArmedTransition — přechody času", () => {
  it("jarní posun neposune hranici okna", () => {
    // 29. 3. 2026 skáčou hodiny z 02:00 na 03:00; okno 18:00–06:00
    // v sobotu večer končí v neděli v 06:00 nástěnného času.
    const vikend: ArmedSchedule = { ...nocni, armed_days: [6] };
    const t = nextArmedTransition(vikend, zonedTimeToUtc(2026, 3, 28, 23, 0, PRAGUE));
    assert.ok(t);
    assert.equal(t.becomes, "disarmed");
    assert.equal(wall(t.at), "29. 03. 06:00");
  });

  it("podzimní posun taky ne", () => {
    const vikend: ArmedSchedule = { ...nocni, armed_days: [6] };
    const t = nextArmedTransition(vikend, zonedTimeToUtc(2026, 10, 24, 23, 0, PRAGUE));
    assert.ok(t);
    assert.equal(wall(t.at), "25. 10. 06:00");
  });
});

describe("nextArmedTransition — okrajové vstupy", () => {
  it("shodný začátek a konec nemá co přepínat", () => {
    const nikdy: ArmedSchedule = { ...nocni, armed_from: "08:00:00", armed_to: "08:00:00" };
    assert.equal(nextArmedTransition(nikdy, new Date()), null);
  });

  it("jiná zóna se počítá vlastním posunem", () => {
    const newYork: ArmedSchedule = { ...nocni, timezone: "America/New_York" };
    const t = nextArmedTransition(
      newYork,
      zonedTimeToUtc(2026, 8, 26, 15, 0, "America/New_York"),
    );
    assert.ok(t);
    assert.equal(
      new Intl.DateTimeFormat("cs-CZ", {
        timeZone: "America/New_York",
        hourCycle: "h23",
        hour: "2-digit",
        minute: "2-digit",
      }).format(t.at),
      "18:00",
    );
  });
});

describe("nextArmedTransition — předaný výchozí stav", () => {
  it("popisek odpovídá předanému stavu, ne dopočítanému", () => {
    // Uprostřed noci je okno aktivní; kdyby volající tvrdil opak,
    // musí tomu odpovídat i popisek — jinak by věta na obrazovce
    // říkala „je střežený, střežení se zapne“.
    const at = zonedTimeToUtc(2026, 8, 26, 23, 0, PRAGUE);
    assert.equal(nextArmedTransition(nocni, at)?.becomes, "disarmed");
    assert.equal(
      nextArmedTransition(nocni, at, { currentlyArmed: false })?.becomes,
      "armed",
    );
  });

  it("bez parametru se chová jako dřív", () => {
    const at = zonedTimeToUtc(2026, 8, 26, 15, 0, PRAGUE);
    assert.equal(nextArmedTransition(nocni, at)?.becomes, "armed");
  });

  it("horizont jde pořád nastavit", () => {
    const at = zonedTimeToUtc(2026, 8, 29, 7, 0, PRAGUE);
    // Do pondělí je to víc než den, s horizontem 1 se nic nenajde.
    assert.equal(nextArmedTransition(nocni, at, { horizonDays: 1 }), null);
  });
});
