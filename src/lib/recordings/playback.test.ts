import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  absoluteTime,
  buildPlaylist,
  cameraIds,
  locateTime,
  nextIndex,
  positionPercent,
  timeAtPercent,
} from "./playback.ts";

const T = (iso: string) => new Date(iso).getTime();

/** Den 27. 8. 2026 v Praze: 22:00 UTC předchozího dne až 22:00 UTC. */
const RANGE = {
  from: new Date("2026-08-26T22:00:00Z"),
  to: new Date("2026-08-27T22:00:00Z"),
};

function radek(o: {
  id: string;
  od: string;
  do?: string | null;
  path?: string | null;
  uploaded?: string | null;
  expired?: string | null;
  kamera?: string;
}) {
  return {
    id: o.id,
    started_at: o.od,
    ended_at: o.do === undefined ? null : o.do,
    storage_path: o.path === undefined ? `s/c/${o.id}.mp4` : o.path,
    uploaded_at: o.uploaded === undefined ? "2026-08-27T10:00:00Z" : o.uploaded,
    video_expired_at: o.expired ?? null,
    camera_id: o.kamera ?? "cam-1",
    cameras: { name: "Jeřáb" },
  };
}

// Tři osmiminutové soubory za sebou a po nich dvouhodinová mezera —
// tvar, jaký dělá pohybové nahrávání.
const SOUBORY = [
  radek({ id: "a", od: "2026-08-27T08:00:00Z", do: "2026-08-27T08:08:00Z" }),
  radek({ id: "b", od: "2026-08-27T08:08:00Z", do: "2026-08-27T08:16:00Z" }),
  radek({ id: "c", od: "2026-08-27T10:16:00Z", do: "2026-08-27T10:24:00Z" }),
];

describe("buildPlaylist", () => {
  it("řadí od nejstaršího, i když seznam přijde obráceně", () => {
    // Tabulka jde od nejnovějšího. Spolehnout se na pořadí volajícího
    // by znamenalo přehrávat den pozpátku.
    const clips = buildPlaylist([...SOUBORY].reverse());
    assert.deepEqual(clips.map((c) => c.id), ["a", "b", "c"]);
  });

  it("vynechá, co se přehrát nedá", () => {
    const clips = buildPlaylist([
      ...SOUBORY,
      radek({ id: "neprisel", od: "2026-08-27T09:00:00Z", uploaded: null }),
      radek({ id: "polhute", od: "2026-08-27T09:10:00Z", expired: "2026-09-01T00:00:00Z" }),
      radek({ id: "bezcesty", od: "2026-08-27T09:20:00Z", path: null }),
    ]);
    assert.deepEqual(clips.map((c) => c.id), ["a", "b", "c"]);
  });

  it("odkazuje přes /api/media, ne na úložiště", () => {
    assert.match(buildPlaylist(SOUBORY)[0].src, /^\/api\/media\/zaznamy\//);
  });

  it("záznam bez konce má neznámou délku, ne nulovou", () => {
    const [clip] = buildPlaylist([radek({ id: "x", od: "2026-08-27T08:00:00Z", do: null })]);
    assert.equal(clip.durationSec, null);
    assert.equal(clip.endsAt, clip.startsAt);
  });

  it("délka se počítá z rozsahu v databázi", () => {
    assert.equal(buildPlaylist(SOUBORY)[0].durationSec, 480);
  });
});

describe("locateTime", () => {
  const clips = buildPlaylist(SOUBORY);

  it("uvnitř souboru dá přesný offset", () => {
    const l = locateTime(clips, T("2026-08-27T08:03:00Z"));
    assert.deepEqual(l, { index: 0, offsetSec: 180, snapped: false });
  });

  it("na hranici dvou souborů patří čas tomu DALŠÍMU", () => {
    // Konec je výlučný. Kdyby byl včetně, seek na 08:08 by skončil za
    // koncem prvního souboru a video by se zaseklo.
    const l = locateTime(clips, T("2026-08-27T08:08:00Z"));
    assert.equal(l?.index, 1);
    assert.equal(l?.offsetSec, 0);
  });

  it("v mezeře skočí na DALŠÍ záznam vpřed, ne zpět", () => {
    const l = locateTime(clips, T("2026-08-27T09:00:00Z"));
    assert.deepEqual(l, { index: 2, offsetSec: 0, snapped: true });
  });

  it("před prvním záznamem začne prvním", () => {
    const l = locateTime(clips, T("2026-08-27T05:00:00Z"));
    assert.deepEqual(l, { index: 0, offsetSec: 0, snapped: true });
  });

  it("za posledním zůstane na jeho konci", () => {
    const l = locateTime(clips, T("2026-08-27T20:00:00Z"));
    assert.deepEqual(l, { index: 2, offsetSec: 480, snapped: true });
  });

  it("prázdný playlist nemá kam skočit", () => {
    assert.equal(locateTime([], T("2026-08-27T08:00:00Z")), null);
  });
});

describe("nextIndex", () => {
  const clips = buildPlaylist(SOUBORY);

  it("navazuje dalším souborem", () => {
    assert.equal(nextIndex(clips, 0), 1);
  });

  it("přeskočí i dvouhodinovou mezeru", () => {
    // Mezi b a c jsou dvě hodiny ticha. Po dojetí b se hraje c hned,
    // nečeká se.
    assert.equal(nextIndex(clips, 1), 2);
  });

  it("na konci dne už nic není", () => {
    assert.equal(nextIndex(clips, 2), null);
  });
});

describe("absoluteTime", () => {
  const clips = buildPlaylist(SOUBORY);

  it("pozice v souboru se převede na skutečný čas záznamu", () => {
    assert.equal(
      absoluteTime(clips[0], 180),
      T("2026-08-27T08:03:00Z"),
    );
  });

  it("po mezeře ukazuje skutečný čas, ne plynulou osu", () => {
    // Třetí soubor začíná ve 10:16, ne v 08:16 + něco. Kdyby se čas
    // počítal jako součet délek, klient by viděl čas o dvě hodiny vedle.
    assert.equal(absoluteTime(clips[2], 0), T("2026-08-27T10:16:00Z"));
  });

  it("nesmyslná pozice se bere jako začátek", () => {
    for (const t of [Number.NaN, -5, Number.POSITIVE_INFINITY]) {
      assert.equal(absoluteTime(clips[0], t), clips[0].startsAt);
    }
  });
});

describe("osa ↔ čas", () => {
  it("poledne je uprostřed dne", () => {
    const percent = positionPercent(T("2026-08-27T10:00:00Z"), RANGE);
    assert.equal(percent, 50);
  });

  it("mimo den nemá kde svítit", () => {
    assert.equal(positionPercent(T("2026-08-25T10:00:00Z"), RANGE), null);
  });

  it("klik a zpět dá týž čas", () => {
    const cas = T("2026-08-27T14:37:00Z");
    const percent = positionPercent(cas, RANGE);
    assert.ok(percent !== null);
    assert.equal(timeAtPercent(percent, RANGE), cas);
  });

  it("klik za okrajem se ořízne do dne", () => {
    assert.equal(timeAtPercent(-10, RANGE), RANGE.from.getTime());
    assert.equal(timeAtPercent(150, RANGE), RANGE.to.getTime());
  });

  it("den se změnou času má správnou délku", () => {
    // Říjnový 25hodinový den. Poledne v něm NENÍ v 50 %.
    const dlouhy = {
      from: new Date("2026-10-24T22:00:00Z"),
      to: new Date("2026-10-25T23:00:00Z"),
    };
    const percent = positionPercent(T("2026-10-25T10:30:00Z"), dlouhy);
    assert.equal(percent, 50);
  });
});

describe("cameraIds", () => {
  it("pozná, že den má víc kamer", () => {
    const ids = cameraIds([
      radek({ id: "a", od: "2026-08-27T08:00:00Z", kamera: "cam-1" }),
      radek({ id: "b", od: "2026-08-27T08:00:00Z", kamera: "cam-2" }),
      radek({ id: "c", od: "2026-08-27T08:10:00Z", kamera: "cam-1" }),
    ]);
    assert.deepEqual(ids.sort(), ["cam-1", "cam-2"]);
  });
});
