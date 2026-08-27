import { strict as assert } from "node:assert";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

// ═══ Proč tenhle test existuje ══════════════════════════════════════
// Middleware obnovuje session a kdo ji nemá, odklání na /login. Routa
// pod /api, která se ověřuje jinak — HMAC podpisem nebo sdíleným
// tajemstvím — session cookie nemá a nikdy mít nebude, takže musí být
// z matcheru vyjmutá. Jinak vrátí 307 na /login místo odpovědi.
//
// Stalo se to TŘIKRÁT. Pokaždé stejně: routa se napsala, otestovala
// curlem proti localhostu (kde middleware neběží stejně), nasadila —
// a zvenčí vracela přesměrování. Poznalo se to až z druhé strany,
// z relaye nebo z crontabu, kde to vypadá jako výpadek sítě.
//
// Test proto nečte seznam, který by někdo musel udržovat. Prochází
// SKUTEČNÉ routy na disku, každou zařadí podle toho, čím se ověřuje,
// a pak pouští matcher jako regulární výraz na jejich cestu — tedy
// přesně tak, jak ho pustí Next.

const KOREN = new URL("..", import.meta.url).pathname;
const API = join(KOREN, "src/app/api");

/** Cesty rout na disku → adresa, kterou by volající zavolal. */
function najdiRouty(dir: string, prefix = ""): { file: string; path: string }[] {
  const out: { file: string; path: string }[] = [];
  for (const polozka of readdirSync(dir, { withFileTypes: true })) {
    if (polozka.isDirectory()) {
      // [id] → něco, co se dá dosadit do adresy.
      const segment = polozka.name.startsWith("[") ? "vzorek" : polozka.name;
      out.push(...najdiRouty(join(dir, polozka.name), `${prefix}/${segment}`));
    } else if (polozka.name === "route.ts" || polozka.name === "route.tsx") {
      out.push({ file: join(dir, polozka.name), path: `/api${prefix}` });
    }
  }
  return out;
}

/**
 * Čím se routa ověřuje.
 *
 * Rozhoduje jediný signál a je spolehlivý: routa, která sahá na
 * databázi přes supabaseAdmin(), obchází RLS a session k tomu nemá —
 * musí se tedy ověřovat sama. Routa, která si bere klienta ze
 * server.ts, jede na session přihlášeného člověka a middleware
 * potřebuje.
 */
function zpusobOvereni(file: string): "vlastni" | "session" | "neznamy" {
  const zdroj = readFileSync(file, "utf8");
  if (/from "@\/lib\/supabase\/server\.ts"/.test(zdroj)) return "session";
  if (/supabaseAdmin\(/.test(zdroj)) return "vlastni";
  return "neznamy";
}

/** Matcher tak, jak ho ponese nasazený build — ne kopie v testu. */
function nactiMatcher(): RegExp {
  const zdroj = readFileSync(join(KOREN, "src/middleware.ts"), "utf8");
  const nalez = zdroj.match(/matcher:\s*\[\s*(?:\/\*[\s\S]*?\*\/\s*)?"((?:[^"\\]|\\.)*)"/);
  assert.ok(nalez, "V middleware.ts se nepodařilo najít matcher");
  // Řetězec v souboru je zdrojový kód: \\ v něm je jeden zpětný lomítko.
  const vzor = nalez[1].replace(/\\\\/g, "\\");
  return new RegExp(`^${vzor}$`);
}

const ROUTY = najdiRouty(API);
const MATCHER = nactiMatcher();

describe("matcher middlewaru", () => {
  it("routy vůbec našel — jinak by test mlčel a nic nehlídal", () => {
    assert.ok(ROUTY.length >= 5, `nalezeno ${ROUTY.length} rout`);
  });

  it("matcher chytá běžné stránky", () => {
    // Kdyby ne, byl by celý test bezcenný: prošel by i prázdný vzor.
    assert.equal(MATCHER.test("/prehled"), true);
    assert.equal(MATCHER.test("/arealy/vzorek"), true);
  });

  it("statické soubory nechává být", () => {
    assert.equal(MATCHER.test("/favicon.ico"), false);
    assert.equal(MATCHER.test("/logo.svg"), false);
  });

  it("veřejné stránky jsou vypsané taky", () => {
    // Druhý seznam téhož druhu: matcher rozhoduje, jestli middleware
    // vůbec poběží, PUBLIC_PATHS pak, koho pustí bez přihlášení.
    // Stránka mimo skupinu (app) nemá layout portálu — žádný sidebar,
    // žádný přepínač lokalit —, takže se na ni z principu chodí bez
    // session: buď je to přihlášení, nebo se ověřuje tokenem v adrese
    // jako /prijezd. Když v seznamu chybí, pošle ji middleware na
    // /login, kam se ten člověk nikdy nedostane.
    const zdroj = readFileSync(join(KOREN, "src/lib/supabase/middleware.ts"), "utf8");
    const nalez = zdroj.match(/PUBLIC_PATHS = \[([^\]]*)\]/);
    assert.ok(nalez, "PUBLIC_PATHS se nepodařilo najít");
    const verejne = [...nalez[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);

    const mimoPortal = readdirSync(join(KOREN, "src/app"), { withFileTypes: true })
      .filter((p) => p.isDirectory() && p.name !== "api" && !p.name.startsWith("("))
      .map((p) => `/${p.name}`);

    for (const cesta of mimoPortal) {
      assert.ok(
        verejne.includes(cesta),
        `${cesta} je mimo skupinu (app), ale není ve PUBLIC_PATHS — middleware ` +
          `ji odkloní na /login. Buď ji tam doplň, nebo ji přesuň pod (app), ` +
          `pokud přihlášení vyžadovat MÁ.`,
      );
    }
  });

  for (const routa of ROUTY) {
    const zpusob = zpusobOvereni(routa.file);

    if (zpusob === "vlastni") {
      it(`${routa.path} se ověřuje sám, takže musí být z matcheru vyjmutý`, () => {
        assert.equal(
          MATCHER.test(routa.path),
          false,
          `${routa.path} projde matcherem, takže ho middleware odkloní na /login. ` +
            `Doplň jeho prefix do vyjmutých cest v src/middleware.ts.`,
        );
      });
    }

    if (zpusob === "session") {
      it(`${routa.path} jede na session, takže v matcheru zůstat musí`, () => {
        // Vyjmutá session routa není díra — kontrolu má v sobě —, ale
        // přestane se jí obnovovat cookie a po hodině začne vracet 401
        // člověku, který je přihlášený.
        assert.equal(MATCHER.test(routa.path), true, `${routa.path} je z matcheru vyjmutá`);
      });
    }

    if (zpusob === "neznamy") {
      it(`${routa.path} se dá zařadit`, () => {
        assert.fail(
          `U ${routa.path} nejde poznat, čím se ověřuje: nesahá na supabaseAdmin() ` +
            `ani si nebere klienta ze server.ts. Zařaď ji — na tomhle rozhodnutí ` +
            `stojí, jestli má být v matcheru.`,
        );
      });
    }
  }
});
