import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { isSupportedLogoType, logoPathFor, logoUrl } from "./logo.ts";

describe("logoUrl", () => {
  const puvodni = process.env.NEXT_PUBLIC_SUPABASE_URL;

  it("složí veřejnou adresu z cesty", () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://abc.supabase.co";
    assert.equal(
      logoUrl("u1/123.png"),
      "https://abc.supabase.co/storage/v1/object/public/loga/u1/123.png",
    );
    process.env.NEXT_PUBLIC_SUPABASE_URL = puvodni;
  });

  it("poradí si s lomítky navíc", () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://abc.supabase.co/";
    assert.equal(
      logoUrl("/u1/123.png"),
      "https://abc.supabase.co/storage/v1/object/public/loga/u1/123.png",
    );
    process.env.NEXT_PUBLIC_SUPABASE_URL = puvodni;
  });

  it("bez cesty vrací null", () => {
    assert.equal(logoUrl(null), null);
    assert.equal(logoUrl(undefined), null);
    assert.equal(logoUrl(""), null);
  });

  it("bez konfigurace vrací null, ne rozbitou adresu", () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    assert.equal(logoUrl("u1/123.png"), null);
    process.env.NEXT_PUBLIC_SUPABASE_URL = puvodni;
  });
});

describe("logoPathFor", () => {
  it("cesta nese id profilu, razítko i příponu", () => {
    assert.equal(logoPathFor("u1", "image/png", 42), "u1/42.png");
    assert.equal(logoPathFor("u1", "image/jpeg", 42), "u1/42.jpg");
    assert.equal(logoPathFor("u1", "image/webp", 42), "u1/42.webp");
  });

  it("nová verze dostane jinou cestu — kvůli cache prohlížeče", () => {
    assert.notEqual(
      logoPathFor("u1", "image/png", 1),
      logoPathFor("u1", "image/png", 2),
    );
  });

  it("nepodporovaný typ vrací null", () => {
    assert.equal(logoPathFor("u1", "image/gif", 42), null);
    assert.equal(logoPathFor("u1", "application/pdf", 42), null);
  });

  it("SVG neprojde — bucket je veřejný", () => {
    // Migrace 20260911180000. SVG je spustitelný dokument, ne obrázek,
    // a soubor v tomhle bucketu se dá otevřít přímo, mimo portál.
    assert.equal(logoPathFor("u1", "image/svg+xml", 42), null);
  });
});

describe("isSupportedLogoType", () => {
  it("povolené typy odpovídají tomu, co přijme bucket", () => {
    for (const t of ["image/png", "image/jpeg", "image/webp"]) {
      assert.equal(isSupportedLogoType(t), true, t);
    }
    for (const t of ["image/svg+xml", "image/gif", "text/html", ""]) {
      assert.equal(isSupportedLogoType(t), false, t);
    }
  });
});
