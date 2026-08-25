import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { patrolRunsBetween, zonedTimeToUtc, type PatrolSchedule } from "./schedule.ts";

const PRAGUE = "Europe/Prague";

/** Sloty jako čitelné nástěnné časy lokality. */
function wall(dates: Date[], timeZone = PRAGUE): string[] {
  return dates.map((d) =>
    new Intl.DateTimeFormat("cs-CZ", {
      timeZone,
      hourCycle: "h23",
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).format(d),
  );
}

const denni: PatrolSchedule = {
  window_from: "08:00",
  window_to: "18:00",
  days: [1, 2, 3, 4, 5],
  interval_minutes: 120,
  timezone: PRAGUE,
};

describe("zonedTimeToUtc", () => {
  it("letní čas: 08:00 v Praze je 06:00 UTC", () => {
    assert.equal(
      zonedTimeToUtc(2026, 8, 26, 8, 0, PRAGUE).toISOString(),
      "2026-08-26T06:00:00.000Z",
    );
  });

  it("zimní čas: 08:00 v Praze je 07:00 UTC", () => {
    assert.equal(
      zonedTimeToUtc(2026, 1, 15, 8, 0, PRAGUE).toISOString(),
      "2026-01-15T07:00:00.000Z",
    );
  });

  it("jiná zóna se počítá vlastním posunem", () => {
    assert.equal(
      zonedTimeToUtc(2026, 8, 26, 8, 0, "America/New_York").toISOString(),
      "2026-08-26T12:00:00.000Z",
    );
  });

  it("okamžik těsně po podzimním přechodu", () => {
    // 25. 10. 2026 se v Praze vrací zimní čas; 03:00 už je CET.
    assert.equal(
      zonedTimeToUtc(2026, 10, 25, 3, 0, PRAGUE).toISOString(),
      "2026-10-25T02:00:00.000Z",
    );
  });
});

describe("patrolRunsBetween — denní okno", () => {
  it("najde slot v následujících deseti minutách", () => {
    // Středa 26. 8. 2026, 07:55 pražského času.
    const now = zonedTimeToUtc(2026, 8, 26, 7, 55, PRAGUE);
    const runs = patrolRunsBetween(denni, now, new Date(now.getTime() + 10 * 60_000));
    assert.deepEqual(wall(runs), ["26. 08. 08:00"]);
  });

  it("mimo okno nevrací nic", () => {
    const now = zonedTimeToUtc(2026, 8, 26, 19, 0, PRAGUE);
    assert.deepEqual(patrolRunsBetween(denni, now, new Date(now.getTime() + 10 * 60_000)), []);
  });

  it("o víkendu nevrací nic", () => {
    // Sobota 29. 8. 2026 v 07:55.
    const now = zonedTimeToUtc(2026, 8, 29, 7, 55, PRAGUE);
    assert.deepEqual(patrolRunsBetween(denni, now, new Date(now.getTime() + 10 * 60_000)), []);
  });

  it("celý den dá starty po dvou hodinách od osmi do šesti", () => {
    const start = zonedTimeToUtc(2026, 8, 26, 0, 0, PRAGUE);
    const end = zonedTimeToUtc(2026, 8, 27, 0, 0, PRAGUE);
    assert.deepEqual(wall(patrolRunsBetween(denni, start, end)), [
      "26. 08. 08:00",
      "26. 08. 10:00",
      "26. 08. 12:00",
      "26. 08. 14:00",
      "26. 08. 16:00",
    ]);
  });

  it("poslední slot padne dovnitř okna, ne na jeho konec", () => {
    // 08:00 + 5×120 = 18:00, což je konec okna — už se neletí.
    const runs = patrolRunsBetween(
      denni,
      zonedTimeToUtc(2026, 8, 26, 17, 0, PRAGUE),
      zonedTimeToUtc(2026, 8, 26, 23, 0, PRAGUE),
    );
    assert.deepEqual(wall(runs), []);
  });

  it("interval, který okno nedělí beze zbytku", () => {
    const runs = patrolRunsBetween(
      { ...denni, window_from: "08:00", window_to: "12:00", interval_minutes: 90 },
      zonedTimeToUtc(2026, 8, 26, 0, 0, PRAGUE),
      zonedTimeToUtc(2026, 8, 27, 0, 0, PRAGUE),
    );
    assert.deepEqual(wall(runs), ["26. 08. 08:00", "26. 08. 09:30", "26. 08. 11:00"]);
  });
});

describe("patrolRunsBetween — okno přes půlnoc", () => {
  const nocni: PatrolSchedule = {
    ...denni,
    window_from: "22:00",
    window_to: "04:00",
    days: [1], // jen pondělí
    interval_minutes: 120,
  };

  it("série patří dni, ve kterém začala", () => {
    // Pondělí 24. 8. 2026 od 21:00 do úterního rána.
    const runs = patrolRunsBetween(
      nocni,
      zonedTimeToUtc(2026, 8, 24, 21, 0, PRAGUE),
      zonedTimeToUtc(2026, 8, 25, 12, 0, PRAGUE),
    );
    assert.deepEqual(wall(runs), [
      "24. 08. 22:00",
      "25. 08. 00:00",
      "25. 08. 02:00",
    ]);
  });

  it("úterní noc už neletí, protože úterý v days není", () => {
    const runs = patrolRunsBetween(
      nocni,
      zonedTimeToUtc(2026, 8, 25, 21, 0, PRAGUE),
      zonedTimeToUtc(2026, 8, 26, 12, 0, PRAGUE),
    );
    assert.deepEqual(wall(runs), []);
  });
});

describe("patrolRunsBetween — přechody času", () => {
  it("na jaře se hodina přeskočí, sloty se neztratí", () => {
    // Noc na neděli 29. 3. 2026, hodiny skáčou z 02:00 na 03:00.
    const nocni: PatrolSchedule = {
      ...denni,
      window_from: "23:00",
      window_to: "06:00",
      days: [6],
      interval_minutes: 60,
    };
    const runs = patrolRunsBetween(
      nocni,
      zonedTimeToUtc(2026, 3, 28, 22, 0, PRAGUE),
      zonedTimeToUtc(2026, 3, 29, 12, 0, PRAGUE),
    );
    // Sloty jsou po hodině nástěnného času; 02:00 v Praze neexistuje,
    // takže vyjde na 03:00 — dva slity se tím potkají a odduplikují.
    const times = wall(runs);
    assert.ok(times.includes("28. 03. 23:00"));
    assert.ok(times.includes("29. 03. 01:00"));
    assert.ok(times.includes("29. 03. 05:00"));
    // Skutečné okamžiky musí být rostoucí a neopakovat se.
    const stamps = runs.map((r) => r.getTime());
    assert.deepEqual(stamps, [...stamps].sort((a, b) => a - b));
    assert.equal(new Set(stamps).size, stamps.length);
  });

  it("na podzim se hodina opakuje, sloty se nezdvojí", () => {
    const nocni: PatrolSchedule = {
      ...denni,
      window_from: "23:00",
      window_to: "06:00",
      days: [6],
      interval_minutes: 60,
    };
    const runs = patrolRunsBetween(
      nocni,
      zonedTimeToUtc(2026, 10, 24, 22, 0, PRAGUE),
      zonedTimeToUtc(2026, 10, 25, 12, 0, PRAGUE),
    );
    const stamps = runs.map((r) => r.getTime());
    assert.equal(new Set(stamps).size, stamps.length, "sloty se nesmí opakovat");
  });
});

describe("patrolRunsBetween — okrajové vstupy", () => {
  it("nulový interval nevrací nic místo nekonečna", () => {
    const now = zonedTimeToUtc(2026, 8, 26, 7, 0, PRAGUE);
    assert.deepEqual(
      patrolRunsBetween({ ...denni, interval_minutes: 0 }, now, new Date(now.getTime() + 86_400_000)),
      [],
    );
  });

  it("shodný začátek a konec okna nevrací nic", () => {
    const now = zonedTimeToUtc(2026, 8, 26, 7, 0, PRAGUE);
    assert.deepEqual(
      patrolRunsBetween({ ...denni, window_from: "08:00", window_to: "08:00" }, now, new Date(now.getTime() + 86_400_000)),
      [],
    );
  });

  it("dolní hranice je vylučující — slot přesně v `after` se nevrací", () => {
    const at8 = zonedTimeToUtc(2026, 8, 26, 8, 0, PRAGUE);
    const runs = patrolRunsBetween(denni, at8, new Date(at8.getTime() + 60_000));
    assert.deepEqual(wall(runs), []);
  });

  it("horní hranice je zahrnující — slot přesně v `until` se vrací", () => {
    const at8 = zonedTimeToUtc(2026, 8, 26, 8, 0, PRAGUE);
    const runs = patrolRunsBetween(denni, new Date(at8.getTime() - 60_000), at8);
    assert.deepEqual(wall(runs), ["26. 08. 08:00"]);
  });

  it("zóna lokality se opravdu respektuje", () => {
    const newYork = { ...denni, timezone: "America/New_York" };
    // 07:55 newyorského času = 11:55 UTC.
    const now = zonedTimeToUtc(2026, 8, 26, 7, 55, "America/New_York");
    const runs = patrolRunsBetween(newYork, now, new Date(now.getTime() + 10 * 60_000));
    assert.deepEqual(wall(runs, "America/New_York"), ["26. 08. 08:00"]);
  });
});
