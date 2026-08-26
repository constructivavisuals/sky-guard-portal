import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  effectivePrefs,
  shouldDeliver,
  warningCooldownElapsed,
  WARNING_COOLDOWN_HOURS,
} from "./rules.ts";
import { isQuietHour } from "../../types/database.ts";

const PRAHA = "Europe/Prague";

/** 2026-08-26 v místním čase (léto, UTC+2). */
function praha(hour: number, minute = 0): Date {
  return new Date(Date.UTC(2026, 7, 26, hour - 2, minute));
}

describe("isQuietHour", () => {
  const noc = { quiet_from: "22:00:00", quiet_to: "06:00:00" };

  it("nenastavené okno neumlčí nic", () => {
    assert.equal(isQuietHour({ quiet_from: null, quiet_to: null }, PRAHA, praha(3)), false);
  });

  it("okno přes půlnoc platí večer i ráno", () => {
    assert.equal(isQuietHour(noc, PRAHA, praha(23)), true);
    assert.equal(isQuietHour(noc, PRAHA, praha(3)), true);
  });

  it("mimo okno je ticho pryč", () => {
    assert.equal(isQuietHour(noc, PRAHA, praha(12)), false);
    assert.equal(isQuietHour(noc, PRAHA, praha(21, 59)), false);
  });

  it("hranice: začátek patří dovnitř, konec ven", () => {
    assert.equal(isQuietHour(noc, PRAHA, praha(22)), true);
    assert.equal(isQuietHour(noc, PRAHA, praha(6)), false);
  });

  it("okno v rámci dne", () => {
    const den = { quiet_from: "09:00:00", quiet_to: "17:00:00" };
    assert.equal(isQuietHour(den, PRAHA, praha(12)), true);
    assert.equal(isQuietHour(den, PRAHA, praha(20)), false);
    assert.equal(isQuietHour(den, PRAHA, praha(3)), false);
  });

  it("počítá se v pásmu lokality, ne v UTC", () => {
    // 23:30 v Praze je 21:30 UTC. Kdyby se okno počítalo v UTC,
    // vyšlo by „není ticho“.
    const at = new Date("2026-08-26T21:30:00Z");
    assert.equal(isQuietHour(noc, PRAHA, at), true);
  });

  it("jedna hranice bez druhé neumlčí", () => {
    assert.equal(isQuietHour({ quiet_from: "22:00:00", quiet_to: null }, PRAHA, praha(23)), false);
  });
});

describe("effectivePrefs", () => {
  it("bez řádku platí výchozí hodnoty", () => {
    const p = effectivePrefs(null);
    assert.equal(p.on_dispatch_sent, true);
    assert.equal(p.on_threat_confirmed, true);
    // Potlačených zásahů je v běžném provozu nejvíc.
    assert.equal(p.on_dispatch_suppressed, false);
    assert.equal(p.quiet_from, null);
  });

  it("uložené hodnoty přebijí výchozí", () => {
    const p = effectivePrefs({ on_dispatch_sent: false, quiet_from: "22:00:00" });
    assert.equal(p.on_dispatch_sent, false);
    assert.equal(p.quiet_from, "22:00:00");
    // Co uloženo není, zůstává výchozí.
    assert.equal(p.on_camera_silent, true);
  });
});

describe("shouldDeliver", () => {
  const noc = effectivePrefs({ quiet_from: "22:00:00", quiet_to: "06:00:00" });

  it("zapnutý druh ve dne projde", () => {
    const d = shouldDeliver({ kind: "dispatch_sent", prefs: noc, timezone: PRAHA, at: praha(12) });
    assert.deepEqual(d, { send: true });
  });

  it("vypnutý druh neprojde ani ve dne", () => {
    const prefs = effectivePrefs({ on_dispatch_sent: false });
    const d = shouldDeliver({ kind: "dispatch_sent", prefs, timezone: PRAHA, at: praha(12) });
    assert.deepEqual(d, { send: false, reason: "kind_disabled" });
  });

  it("tiché hodiny zásah umlčí", () => {
    const d = shouldDeliver({ kind: "dispatch_sent", prefs: noc, timezone: PRAHA, at: praha(3) });
    assert.deepEqual(d, { send: false, reason: "quiet_hours" });
  });

  it("potvrzený nález jde i v tichých hodinách", () => {
    // Na pozemku někdo je. Právě ve tři ráno to platí nejvíc.
    const d = shouldDeliver({ kind: "threat_confirmed", prefs: noc, timezone: PRAHA, at: praha(3) });
    assert.deepEqual(d, { send: true });
  });

  it("ale vypnout se potvrzený nález dá", () => {
    // Umlčet ne, vypnout ano — to je vědomé rozhodnutí uživatele.
    const prefs = effectivePrefs({ on_threat_confirmed: false, quiet_from: "22:00:00", quiet_to: "06:00:00" });
    const d = shouldDeliver({ kind: "threat_confirmed", prefs, timezone: PRAHA, at: praha(3) });
    assert.deepEqual(d, { send: false, reason: "kind_disabled" });
  });

  it("vypnutý druh má přednost před tichem i v noci", () => {
    // Důvod má být ten hlavní, ne ten, na který se dřív narazilo.
    const prefs = effectivePrefs({
      on_camera_silent: false,
      quiet_from: "22:00:00",
      quiet_to: "06:00:00",
    });
    const d = shouldDeliver({ kind: "camera_silent", prefs, timezone: PRAHA, at: praha(3) });
    assert.equal(d.send, false);
    assert.equal(d.send === false && d.reason, "kind_disabled");
  });

  it("potlačený zásah je ve výchozím stavu vypnutý", () => {
    const d = shouldDeliver({
      kind: "dispatch_suppressed",
      prefs: effectivePrefs(null),
      timezone: PRAHA,
      at: praha(12),
    });
    assert.equal(d.send, false);
  });
});

describe("warningCooldownElapsed", () => {
  const now = new Date("2026-08-26T12:00:00Z");
  const pred = (hodin: number) =>
    new Date(now.getTime() - hodin * 3_600_000).toISOString();

  it("bez předchozího odeslání se posílá", () => {
    assert.equal(warningCooldownElapsed(null, now), true);
  });

  it("hned po odeslání se neposílá znovu", () => {
    assert.equal(warningCooldownElapsed(pred(0.25), now), false);
  });

  it("po odstupu zase ano", () => {
    assert.equal(warningCooldownElapsed(pred(WARNING_COOLDOWN_HOURS + 1), now), true);
  });

  it("přesně na hranici projde", () => {
    assert.equal(warningCooldownElapsed(pred(WARNING_COOLDOWN_HOURS), now), true);
  });

  it("nečitelné razítko varování neumlčí natrvalo", () => {
    assert.equal(warningCooldownElapsed("nesmysl", now), true);
  });
});
