-- ═══════════════════════════════════════════════════════════════════
-- Vlastní ingest klíč pro každou kameru.
--
-- Doteď se podpis ověřoval jediným INGEST_SECRET a teprve pak se z těla
-- vytáhlo sériové číslo. Tajemství tedy nijak neváže na konkrétní
-- kameru: kdo odmontuje jednu kameru u jednoho klienta, může posílat
-- detekce za kohokoli jiného a spouštět lety na cizím areálu.
--
-- POZOR na název sloupce: HMAC se ověřuje KLÍČEM, ne jeho otiskem —
-- z hashe podpis spočítat nejde. Klíč se proto neukládá vůbec, nýbrž
-- odvozuje: HMAC-SHA256(INGEST_SECRET, 'sériové_číslo.verze'). Databáze
-- drží jen SHA-256 otisk toho klíče, a to ze dvou důvodů:
--   * NULL znamená „kamera ještě běží na společném tajemství“ —
--     server pak použije fallback a zaloguje to,
--   * když otisk nesedí na odvozený klíč (rotoval se INGEST_SECRET,
--     nebo klíč někdo nastavil ručně), server to pozná a řekne to,
--     místo aby tiše odmítal podpisy.
--
-- Rotace jedné kamery = zvýšit ingest_key_version a přepsat otisk;
-- ostatních kamer se to nedotkne.
--
-- Idempotentní: bezpečné spustit víckrát.
-- ═══════════════════════════════════════════════════════════════════

SET search_path = public, extensions;

ALTER TABLE cameras ADD COLUMN IF NOT EXISTS ingest_secret_hash TEXT;
ALTER TABLE cameras ADD COLUMN IF NOT EXISTS ingest_key_version SMALLINT NOT NULL DEFAULT 1;

COMMENT ON COLUMN cameras.ingest_secret_hash IS
  'SHA-256 otisk ingest klíče kamery, hex. NULL = kamera se ještě '
  'podepisuje společným INGEST_SECRET. Klíč sám v databázi není.';
COMMENT ON COLUMN cameras.ingest_key_version IS
  'Verze odvozeného klíče. Zvýšením se klíč jediné kamery zneplatní.';

-- Otisk je hex SHA-256, tedy 64 znaků. Kdyby sem někdo omylem uložil
-- samotný klíč, tahle podmínka to zachytí.
ALTER TABLE cameras DROP CONSTRAINT IF EXISTS cameras_ingest_secret_hash_format;
ALTER TABLE cameras ADD CONSTRAINT cameras_ingest_secret_hash_format CHECK (
  ingest_secret_hash IS NULL OR ingest_secret_hash ~ '^[0-9a-f]{64}$'
);

ALTER TABLE cameras DROP CONSTRAINT IF EXISTS cameras_ingest_key_version_range;
ALTER TABLE cameras ADD CONSTRAINT cameras_ingest_key_version_range CHECK (
  ingest_key_version >= 1
);

-- Kamera bez sériového čísla se nemá jak podepsat — ingest ji dohledává
-- právě podle něj. Otisk bez sériového čísla by tedy byl mrtvý údaj.
ALTER TABLE cameras DROP CONSTRAINT IF EXISTS cameras_ingest_key_needs_serial;
ALTER TABLE cameras ADD CONSTRAINT cameras_ingest_key_needs_serial CHECK (
  ingest_secret_hash IS NULL OR serial_number IS NOT NULL
);
