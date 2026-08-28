import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  contentSecurityPolicy,
  hetznerOrigin,
  supabaseConnectOrigin,
  supabaseOrigin,
} from "./csp.ts";

const PROJEKT = "https://ateldjcffovdiexzmkii.supabase.co";
const HETZNER = "fsn1.your-objectstorage.com";

/** Vytáhne jednu direktivu z hotové politiky. */
function direktiva(csp: string, jmeno: string): string | null {
  const nalezena = csp
    .split("; ")
    .find((cast) => cast === jmeno || cast.startsWith(`${jmeno} `));
  return nalezena ?? null;
}

describe("media-src", () => {
  const csp = contentSecurityPolicy({
    supabaseUrl: PROJEKT,
    hetznerEndpoint: HETZNER,
  });

  it("existuje — bez ní spadne na default-src a video se nepřehraje", () => {
    // Tahle direktiva chyběla od zavedení CSP. Projevilo se to až
    // u klienta jako „video nejde“; build ani testy o tom nevěděly.
    assert.ok(direktiva(csp, "media-src"), csp);
  });

  it("pouští Supabase — média z letů a záznamy před přechodem", () => {
    assert.match(direktiva(csp, "media-src")!, /https:\/\/ateldjcffovdiexzmkii\.supabase\.co/);
  });

  it("netahá s sebou websocket, který u médií nic neznamená", () => {
    assert.doesNotMatch(direktiva(csp, "media-src")!, /wss:/);
    assert.doesNotMatch(direktiva(csp, "img-src")!, /wss:/);
  });

  it("pouští Hetzner — záznamy ze stavebních kamer", () => {
    assert.match(direktiva(csp, "media-src")!, /fsn1\.your-objectstorage\.com/);
  });

  it("pouští oba tvary adresy Hetzneru", () => {
    // Klient skládá virtual-hosted (`bucket.fsn1.…`), ale path-style
    // je jedním přepínačem daleko. Musí projít obojí.
    const media = direktiva(csp, "media-src")!;
    assert.match(media, /https:\/\/fsn1\.your-objectstorage\.com/);
    assert.match(media, /https:\/\/\*\.fsn1\.your-objectstorage\.com/);
  });

  it("pouští i vlastní původ kvůli /api/media", () => {
    // Přehrávač odkazuje na /api/media; teprve ten přesměrovává dál.
    assert.match(direktiva(csp, "media-src")!, /'self'/);
  });
});

describe("'unsafe-eval'", () => {
  it("v produkci není — žádný chunk ho nepotřebuje", () => {
    const csp = contentSecurityPolicy({ supabaseUrl: PROJEKT });
    assert.doesNotMatch(direktiva(csp, "script-src")!, /unsafe-eval/);
  });

  it("ve vývoji je — next dev staví zdrojové mapy přes eval", () => {
    const csp = contentSecurityPolicy({ supabaseUrl: PROJEKT, dev: true });
    assert.match(direktiva(csp, "script-src")!, /unsafe-eval/);
  });
});

describe("supabaseOrigin", () => {
  it("pro soubory dá jen https původ, bez websocketu", () => {
    // `wss://` v img-src nebo media-src nic nepovoluje a jen svádí
    // k domněnce, že se odtamtud něco streamuje.
    assert.equal(supabaseOrigin(PROJEKT), "https://ateldjcffovdiexzmkii.supabase.co");
  });

  it("pro connect-src přidá websocket", () => {
    assert.equal(
      supabaseConnectOrigin(PROJEKT),
      "https://ateldjcffovdiexzmkii.supabase.co wss://ateldjcffovdiexzmkii.supabase.co",
    );
  });

  it("bez proměnné pustí supabase.co, ať se nerozbije přihlášení", () => {
    // Přísnější hodnota by build bez .env proměnila v portál, kam se
    // nedá přihlásit — a poznalo by se to až u klienta.
    for (const vstup of [undefined, "", "   ", "tohle není adresa"]) {
      assert.match(supabaseOrigin(vstup), /\*\.supabase\.co/);
      assert.match(supabaseConnectOrigin(vstup), /wss:\/\/\*\.supabase\.co/);
    }
  });
});

describe("hetznerOrigin", () => {
  it("schéma i koncové lomítko v proměnné nevadí", () => {
    for (const vstup of [HETZNER, `https://${HETZNER}`, `https://${HETZNER}/`]) {
      assert.equal(
        hetznerOrigin(vstup),
        "https://fsn1.your-objectstorage.com https://*.fsn1.your-objectstorage.com",
      );
    }
  });

  it("bez proměnné pustí doménu úložiště, ne celý internet", () => {
    assert.equal(hetznerOrigin(undefined), "https://*.your-objectstorage.com");
    assert.doesNotMatch(hetznerOrigin(undefined), /\*$|https:\/\/\*\s|\*\.com/);
  });
});

describe("politika jako celek", () => {
  const csp = contentSecurityPolicy({ supabaseUrl: PROJEKT, hetznerEndpoint: HETZNER });

  it("drží direktivy, na kterých stojí izolace portálu", () => {
    for (const [jmeno, hodnota] of [
      ["default-src", "'self'"],
      ["frame-ancestors", "'none'"],
      ["frame-src", "'none'"],
      ["object-src", "'none'"],
      ["base-uri", "'self'"],
      ["form-action", "'self'"],
      ["worker-src", "'self'"],
      ["manifest-src", "'self'"],
    ] as const) {
      assert.equal(direktiva(csp, jmeno), `${jmeno} ${hodnota}`);
    }
  });

  it("nikam neposílá data mimo vlastní původ a Supabase", () => {
    assert.equal(
      direktiva(csp, "connect-src"),
      `connect-src 'self' ${supabaseConnectOrigin(PROJEKT)}`,
    );
  });

  it("nemá prázdné ani zdvojené oddělovače", () => {
    // Prázdná direktiva z chybějící proměnné by tiše znamenala
    // „nic není povoleno“ pro celý svůj druh zdroje.
    assert.doesNotMatch(csp, /;\s*;/);
    assert.doesNotMatch(csp, /\s{2,}/);
    for (const cast of csp.split("; ")) {
      assert.ok(cast.trim().length > 0, csp);
      // Direktiva bez hodnoty pouští jen upgrade-insecure-requests.
      if (cast !== "upgrade-insecure-requests") {
        assert.ok(cast.includes(" "), `direktiva bez hodnoty: ${cast}`);
      }
    }
  });
});
