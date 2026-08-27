import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  formatArmedDays,
  formatArmedWindow,
  formatConditions,
  formatBytes,
  formatConfidence,
  formatDateTime,
  formatDuration,
  durationBetween,
  formatRainfall,
  formatTemperature,
  formatWindSpeed,
  formatFocalLength,
  formatTimeOfDay,
  orDash,
  plural,
} from "./format.ts";

describe("formatDateTime", () => {
  it("formátuje v zóně lokality, ne serveru", () => {
    // 20:00 UTC je v Praze 22:00 (CEST) a v New Yorku 16:00 (EDT).
    const iso = "2026-08-24T20:00:00Z";
    assert.match(formatDateTime(iso, "Europe/Prague"), /22:00:00/);
    assert.match(formatDateTime(iso, "America/New_York"), /16:00:00/);
  });

  it("respektuje zimní čas", () => {
    assert.match(formatDateTime("2026-01-15T20:00:00Z", "Europe/Prague"), /21:00:00/);
  });

  it("null i nesmysl vrací pomlčku", () => {
    assert.equal(formatDateTime(null), "—");
    assert.equal(formatDateTime("včera"), "—");
  });
});

describe("formatArmedDays", () => {
  const cases: [string, number[], string][] = [
    ["celý týden", [1, 2, 3, 4, 5, 6, 7], "Celý týden"],
    ["pracovní dny", [1, 2, 3, 4, 5], "Po–Pá"],
    ["víkend zůstává výčtem", [6, 7], "So, Ne"],
    ["nesouvislé dny", [1, 3, 5], "Po, St, Pá"],
    ["rozsah plus samostatný den", [1, 2, 3, 7], "Po–St, Ne"],
    ["jediný den", [3], "St"],
    ["prázdné", [], "Nikdy"],
    ["duplicity a nepořádek", [5, 1, 3, 1], "Po, St, Pá"],
  ];

  for (const [name, days, expected] of cases) {
    it(name, () => {
      assert.equal(formatArmedDays(days as never), expected);
    });
  }
});

describe("formatTimeOfDay a formatArmedWindow", () => {
  it("zahazuje sekundy", () => {
    assert.equal(formatTimeOfDay("18:00:00"), "18:00");
  });

  it("okno přes půlnoc se píše tak, jak je", () => {
    assert.equal(formatArmedWindow("18:00:00", "06:00:00"), "18:00–06:00");
  });

  it("null vrací pomlčku", () => {
    assert.equal(formatTimeOfDay(null), "—");
  });
});

describe("formatConfidence", () => {
  it("převádí na procenta", () => {
    assert.equal(formatConfidence(0.874), "87 %");
    assert.equal(formatConfidence(1), "100 %");
  });

  it("nula je platná hodnota, ne chybějící", () => {
    assert.equal(formatConfidence(0), "0 %");
  });

  it("null vrací pomlčku", () => {
    assert.equal(formatConfidence(null), "—");
  });
});

describe("formatFocalLength a orDash", () => {
  it("ohnisko s desetinnou čárkou", () => {
    assert.equal(formatFocalLength(4), "4 mm");
    assert.equal(formatFocalLength(2.8), "2,8 mm");
  });

  it("prázdné hodnoty jsou pomlčka", () => {
    assert.equal(formatFocalLength(null), "—");
    assert.equal(orDash(null), "—");
    assert.equal(orDash("   "), "—");
    assert.equal(orDash("Dahua"), "Dahua");
  });
});

describe("plural", () => {
  const zone = (n: number) => plural(n, "zóna", "zóny", "zón");

  it("jednotné číslo", () => {
    assert.equal(zone(1), "1 zóna");
  });

  it("dva až čtyři", () => {
    assert.equal(zone(2), "2 zóny");
    assert.equal(zone(4), "4 zóny");
  });

  it("pět a víc", () => {
    assert.equal(zone(5), "5 zón");
    assert.equal(zone(11), "11 zón");
    assert.equal(zone(22), "22 zón");
  });

  it("nula bere tvar pro pět a víc", () => {
    assert.equal(zone(0), "0 zón");
  });
});

describe("formatRainfall", () => {
  it("známé kódy jsou česky", () => {
    assert.equal(formatRainfall("no_rain"), "Beze srážek");
    assert.equal(formatRainfall("light_rain"), "Slabý déšť");
    assert.equal(formatRainfall("moderate_rain"), "Déšť");
    assert.equal(formatRainfall("heavy_rain"), "Silný déšť");
  });

  it("neznámý kód se vypíše, ne zahodí", () => {
    // Ať jde z obrazovky poznat, co dok posílá, a překlad doplnit.
    assert.equal(formatRainfall("torrential_rain"), "torrential_rain");
  });

  it("chybějící hodnota je pomlčka", () => {
    assert.equal(formatRainfall(null), "—");
    assert.equal(formatRainfall(""), "—");
    assert.equal(formatRainfall(undefined), "—");
  });
});

describe("formatWindSpeed a formatTemperature", () => {
  it("jednotky a desetinná čárka", () => {
    assert.equal(formatWindSpeed(3.4), "3,4 m/s");
    assert.equal(formatTemperature(21.5), "21,5 °C");
  });

  it("nula je platná hodnota, ne chybějící", () => {
    assert.equal(formatWindSpeed(0), "0 m/s");
    assert.equal(formatTemperature(0), "0 °C");
  });

  it("záporná teplota projde", () => {
    assert.equal(formatTemperature(-4.5), "-4,5 °C");
  });

  it("null je pomlčka", () => {
    assert.equal(formatWindSpeed(null), "—");
    assert.equal(formatTemperature(null), "—");
  });
});

describe("formatConditions", () => {
  it("skládá vše do jednoho řádku", () => {
    assert.equal(
      formatConditions({
        wind_speed: 3.4,
        rainfall: "no_rain",
        environment_temperature: 21.5,
        measured_at: "2026-08-25T13:16:13.547Z",
      }),
      "3,4 m/s · Beze srážek · 21,5 °C",
    );
  });

  it("chybějící údaje vynechá, ne vypíše jako pomlčky", () => {
    assert.equal(
      formatConditions({
        wind_speed: null,
        rainfall: "light_rain",
        environment_temperature: null,
        measured_at: "2026-08-25T13:16:13.547Z",
      }),
      "Slabý déšť",
    );
  });

  it("bez podmínek je pomlčka", () => {
    assert.equal(formatConditions(null), "—");
  });

  it("prázdný odečet nevrátí oddělovače bez hodnot", () => {
    assert.equal(
      formatConditions({
        wind_speed: null,
        rainfall: null,
        environment_temperature: null,
        measured_at: "2026-08-25T13:16:13.547Z",
      }),
      "—",
    );
  });
});

describe("formatDuration", () => {
  it("pod minutu ve vteřinách", () => {
    assert.equal(formatDuration(45), "45 s");
    assert.equal(formatDuration(0), "0 s");
  });

  it("krátké lety s vteřinami", () => {
    assert.equal(formatDuration(8 * 60 + 7), "8 min 7 s");
  });

  it("delší lety už bez vteřin", () => {
    assert.equal(formatDuration(18 * 60 + 7), "18 min");
  });

  it("přes hodinu", () => {
    assert.equal(formatDuration(3600), "1 h");
    assert.equal(formatDuration(3600 + 25 * 60), "1 h 25 min");
  });

  it("chybějící a nesmyslné hodnoty", () => {
    assert.equal(formatDuration(null), "—");
    assert.equal(formatDuration(-5), "—");
    assert.equal(formatDuration(Number.NaN), "—");
  });
});

describe("durationBetween", () => {
  it("spočítá trvání z časů", () => {
    assert.equal(
      durationBetween("2026-08-26T08:00:00Z", "2026-08-26T08:12:30Z"),
      750,
    );
  });

  it("chybějící konec znamená null, ne nulu", () => {
    assert.equal(durationBetween("2026-08-26T08:00:00Z", null), null);
  });

  it("konec před startem se nepočítá", () => {
    assert.equal(
      durationBetween("2026-08-26T08:12:00Z", "2026-08-26T08:00:00Z"),
      null,
    );
  });
});

describe("formatBytes", () => {
  it("megabajty na desetinu", () => {
    assert.equal(formatBytes(4_194_304), "4.0 MB");
    assert.equal(formatBytes(2_500_000), "2.4 MB");
  });

  it("malé soubory v kilobajtech", () => {
    // Pár kilobajtů u záznamu z kamery znamená rozbitý remux — musí
    // být na první pohled poznat, že to není megabajt.
    assert.equal(formatBytes(2_048), "2 kB");
    assert.equal(formatBytes(512), "512 B");
  });

  it("chybějící velikost je pomlčka, ne nula", () => {
    assert.equal(formatBytes(null), "—");
    assert.equal(formatBytes(undefined), "—");
    assert.equal(formatBytes(Number.NaN), "—");
  });
});
