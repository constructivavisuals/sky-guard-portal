import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  databaseErrorToFieldErrors,
  isValidTimeZone,
  parseCameraForm,
  parseSiteForm,
  parseZoneForm,
} from "./validation.ts";

const SITE_ID = "11111111-1111-1111-1111-111111111111";
const ZONE_ID = "22222222-2222-2222-2222-222222222222";

function form(fields: Record<string, string | string[] | undefined>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) data.append(key, item);
  }
  return data;
}

const validSite = {
  name: "Areál Kralupy",
  address: "Přístavní 12",
  timezone: "Europe/Prague",
  armed_from: "18:00",
  armed_to: "06:00",
  armed_days: ["1", "2", "3", "4", "5"],
  cooldown_seconds: "900",
};

describe("parseSiteForm — platný vstup", () => {
  it("projde a doplní sekundy do časů", () => {
    const r = parseSiteForm(form(validSite));
    assert.ok(r.ok);
    assert.equal(r.value.armed_from, "18:00:00");
    assert.equal(r.value.armed_to, "06:00:00");
    assert.deepEqual(r.value.armed_days, [1, 2, 3, 4, 5]);
    assert.equal(r.value.cooldown_seconds, 900);
  });

  it("prázdná nepovinná pole jsou null, ne prázdný řetězec", () => {
    const r = parseSiteForm(form({ ...validSite, address: "", dock_sn: "  " }));
    assert.ok(r.ok);
    assert.equal(r.value.address, null);
    assert.equal(r.value.dock_sn, null);
    assert.equal(r.value.fh_project_uuid, null);
  });

  it("dny se řadí a odduplikují", () => {
    const r = parseSiteForm(form({ ...validSite, armed_days: ["5", "1", "5", "3"] }));
    assert.ok(r.ok);
    assert.deepEqual(r.value.armed_days, [1, 3, 5]);
  });

  it("okno přes půlnoc je v pořádku", () => {
    const r = parseSiteForm(form({ ...validSite, armed_from: "22:00", armed_to: "05:00" }));
    assert.ok(r.ok);
  });

  it("cooldown 0 projde", () => {
    const r = parseSiteForm(form({ ...validSite, cooldown_seconds: "0" }));
    assert.ok(r.ok);
    assert.equal(r.value.cooldown_seconds, 0);
  });
});

describe("parseSiteForm — chyby u polí", () => {
  const cases: [string, Record<string, string | string[]>, string][] = [
    ["prázdný název", { name: "" }, "name"],
    ["příliš dlouhý název", { name: "x".repeat(201) }, "name"],
    ["neznámá zóna", { timezone: "Europe/Neexistuje" }, "timezone"],
    ["prázdná zóna", { timezone: "" }, "timezone"],
    ["čas mimo tvar", { armed_from: "18h" }, "armed_from"],
    ["nesmyslná hodina", { armed_to: "25:00" }, "armed_to"],
    ["žádný den", { armed_days: [] }, "armed_days"],
    ["cooldown prázdný", { cooldown_seconds: "" }, "cooldown_seconds"],
    ["cooldown záporný", { cooldown_seconds: "-1" }, "cooldown_seconds"],
    ["cooldown přes den", { cooldown_seconds: "90000" }, "cooldown_seconds"],
  ];

  for (const [name, override, field] of cases) {
    it(`${name} → chyba u ${field}`, () => {
      const r = parseSiteForm(form({ ...validSite, ...override }));
      assert.equal(r.ok, false);
      if (!r.ok) {
        assert.ok(r.errors[field], `čekána chyba u pole ${field}`);
        assert.match(r.errors[field], /[ěščřžýáíéůú.]/i);
      }
    });
  }

  it("shodný začátek a konec okna neprojde", () => {
    const r = parseSiteForm(form({ ...validSite, armed_from: "08:00", armed_to: "08:00" }));
    assert.equal(r.ok, false);
    if (!r.ok) assert.ok(r.errors.armed_to);
  });

  it("hlásí všechny vadné pole naráz", () => {
    const r = parseSiteForm(form({ name: "", timezone: "", armed_from: "x", armed_to: "y", cooldown_seconds: "" }));
    assert.equal(r.ok, false);
    if (!r.ok) assert.ok(Object.keys(r.errors).length >= 5);
  });
});

describe("parseZoneForm — souřadnice", () => {
  const validZone = {
    site_id: SITE_ID,
    name: "Brána sever",
    latitude: "50.0755",
    longitude: "14.4378",
    default_level: "3",
  };

  it("platné souřadnice projdou", () => {
    const r = parseZoneForm(form(validZone));
    assert.ok(r.ok);
    assert.equal(r.value.latitude, 50.0755);
    assert.equal(r.value.longitude, 14.4378);
  });

  it("desetinná čárka se bere jako tečka", () => {
    const r = parseZoneForm(form({ ...validZone, latitude: "50,0755" }));
    assert.ok(r.ok);
    assert.equal(r.value.latitude, 50.0755);
  });

  it("nula je platná souřadnice", () => {
    const r = parseZoneForm(form({ ...validZone, latitude: "0", longitude: "0" }));
    assert.ok(r.ok);
    assert.equal(r.value.latitude, 0);
  });

  it("záporné souřadnice projdou", () => {
    const r = parseZoneForm(form({ ...validZone, latitude: "-33.86", longitude: "-70.66" }));
    assert.ok(r.ok);
  });

  const bad: [string, Record<string, string>, string][] = [
    ["šířka nad 90", { latitude: "90.1" }, "latitude"],
    ["šířka pod −90", { latitude: "-90.1" }, "latitude"],
    ["délka nad 180", { longitude: "180.1" }, "longitude"],
    ["délka pod −180", { longitude: "-180.1" }, "longitude"],
    ["šířka není číslo", { latitude: "sever" }, "latitude"],
    ["prázdná délka", { longitude: "" }, "longitude"],
    ["úroveň 0", { default_level: "0" }, "default_level"],
    ["úroveň 6", { default_level: "6" }, "default_level"],
    ["chybí lokalita", { site_id: "" }, "site_id"],
  ];

  for (const [name, override, field] of bad) {
    it(`${name} → chyba u ${field}`, () => {
      const r = parseZoneForm(form({ ...validZone, ...override }));
      assert.equal(r.ok, false);
      if (!r.ok) assert.ok(r.errors[field]);
    });
  }

  it("krajní hodnoty rozsahu projdou", () => {
    const r = parseZoneForm(form({ ...validZone, latitude: "90", longitude: "180" }));
    assert.ok(r.ok);
  });

  it("nezaškrtnuté zapnuto je false", () => {
    const off = parseZoneForm(form(validZone));
    assert.ok(off.ok);
    assert.equal(off.value.enabled, false);
    const on = parseZoneForm(form({ ...validZone, enabled: "on" }));
    assert.ok(on.ok);
    assert.equal(on.value.enabled, true);
  });
});

describe("parseCameraForm", () => {
  const validCamera = {
    site_id: SITE_ID,
    name: "Brána sever",
    status: "online",
  };

  it("minimální vstup projde", () => {
    const r = parseCameraForm(form(validCamera));
    assert.ok(r.ok);
    assert.equal(r.value.zone_id, null);
    assert.equal(r.value.focal_mm, null);
    assert.equal(r.value.model, null);
  });

  it("zóna se přijme jako UUID", () => {
    const r = parseCameraForm(form({ ...validCamera, zone_id: ZONE_ID }));
    assert.ok(r.ok);
    assert.equal(r.value.zone_id, ZONE_ID);
  });

  it("ohnisko s čárkou", () => {
    const r = parseCameraForm(form({ ...validCamera, focal_mm: "2,8" }));
    assert.ok(r.ok);
    assert.equal(r.value.focal_mm, 2.8);
  });

  const bad: [string, Record<string, string>, string][] = [
    ["chybí lokalita", { site_id: "" }, "site_id"],
    ["vadná zóna", { zone_id: "abc" }, "zone_id"],
    ["prázdný název", { name: "" }, "name"],
    ["neznámý stav", { status: "rozbita" }, "status"],
    ["ohnisko nula", { focal_mm: "0" }, "focal_mm"],
    ["ohnisko záporné", { focal_mm: "-4" }, "focal_mm"],
    ["ohnisko nesmyslné", { focal_mm: "10000" }, "focal_mm"],
    ["ohnisko není číslo", { focal_mm: "široké" }, "focal_mm"],
  ];

  for (const [name, override, field] of bad) {
    it(`${name} → chyba u ${field}`, () => {
      const r = parseCameraForm(form({ ...validCamera, ...override }));
      assert.equal(r.ok, false);
      if (!r.ok) assert.ok(r.errors[field]);
    });
  }

  it("stav decommissioned je platný — nahrazuje mazání", () => {
    const r = parseCameraForm(form({ ...validCamera, status: "decommissioned" }));
    assert.ok(r.ok);
    assert.equal(r.value.status, "decommissioned");
  });
});

describe("isValidTimeZone", () => {
  it("přijme známé zóny", () => {
    assert.equal(isValidTimeZone("Europe/Prague"), true);
    assert.equal(isValidTimeZone("America/New_York"), true);
    assert.equal(isValidTimeZone("UTC"), true);
  });

  it("odmítne nesmysly", () => {
    assert.equal(isValidTimeZone("Europe/Neexistuje"), false);
    assert.equal(isValidTimeZone(""), false);
  });
});

describe("databaseErrorToFieldErrors", () => {
  it("duplicitní dock míří na pole dock_sn", () => {
    const e = databaseErrorToFieldErrors('duplicate key value violates unique constraint "idx_sites_dock_sn"', "23505");
    assert.ok(e.dock_sn);
  });

  it("duplicitní sériové číslo míří na serial_number", () => {
    const e = databaseErrorToFieldErrors('… unique constraint "cameras_serial_number_key"', "23505");
    assert.ok(e.serial_number);
  });

  it("neznámá chyba končí u formuláře, ne u pole", () => {
    const e = databaseErrorToFieldErrors("spojení selhalo", "08006");
    assert.ok(e._form);
  });

  it("hláška z Postgresu se uživateli neukáže", () => {
    const raw = 'duplicate key value violates unique constraint "idx_sites_name"';
    const e = databaseErrorToFieldErrors(raw, "23505");
    assert.equal(Object.values(e).some((m) => m.includes("duplicate key")), false);
  });
});
