-- ═══════════════════════════════════════════════════════════════════
-- Zpevnění ingestu: omezení počtu požadavků, ochrana proti přehrání,
-- stopa po odesílateli a zákaz mazání detekcí.
--
-- Body 1C, 1D, 1E a 4C z bezpečnostního auditu.
--
-- Idempotentní: bezpečné spustit víckrát.
-- ═══════════════════════════════════════════════════════════════════

SET search_path = public, extensions;

-- ── 1C: omezení počtu požadavků ──────────────────────────────────
--
-- Vědro s žetony ve SDÍLENÉM úložišti, ne v paměti procesu. Na Vercelu
-- běží každý požadavek klidně na jiné instanci, takže čítač v paměti
-- by omezoval jednu instanci z mnoha a dohromady by nezastavil nic.
--
-- Klíč není jen sériové číslo: to si určuje odesílatel v těle
-- požadavku, které v tu chvíli ještě není ověřené. Kdo by chtěl limit
-- obejít, střídal by vymyšlená sériová čísla. Proto se vedle něj
-- počítá i vědro na IP adresu.

CREATE TABLE IF NOT EXISTS ingest_rate_limits (
  key TEXT PRIMARY KEY,
  tokens DOUBLE PRECISION NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE ingest_rate_limits IS
  'Vědra s žetony pro /api/ingest/detection. Zapisuje výhradně '
  'ingest_take_tokens(); portál sem nesahá.';

ALTER TABLE ingest_rate_limits ENABLE ROW LEVEL SECURITY;
-- Žádná politika = nikdo přihlášený sem nevidí. Ingest jede pod
-- service_role, který RLS obchází.

/**
 * Odebere po jednom žetonu ze všech vědel naráz.
 *
 * Buď má dost všechno, nebo se neodebere nic — jinak by odmítnutý
 * požadavek stejně ubral žeton tomu vědru, které ještě mělo, a limit
 * na IP by nenápadně vyčerpával limit kamery.
 *
 * Klíče se zamykají v setříděném pořadí. Dva souběžné požadavky se
 * stejnou dvojicí klíčů by se jinak mohly zaklesnout každý z jiné
 * strany.
 */
CREATE OR REPLACE FUNCTION ingest_take_tokens(
  p_keys TEXT[],
  p_capacity DOUBLE PRECISION,
  p_refill_per_second DOUBLE PRECISION,
  p_now TIMESTAMPTZ DEFAULT now()
)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  k TEXT;
  v_tokens DOUBLE PRECISION;
  v_updated TIMESTAMPTZ;
BEGIN
  IF p_keys IS NULL OR array_length(p_keys, 1) IS NULL THEN
    RETURN TRUE;
  END IF;

  -- Založit chybějící vědra plná; ON CONFLICT DO NOTHING, ať souběh
  -- nespadne na primárním klíči.
  INSERT INTO ingest_rate_limits (key, tokens, updated_at)
  SELECT unnest(p_keys), p_capacity, p_now
  ON CONFLICT (key) DO NOTHING;

  -- První průchod: doplnit podle uplynulého času a zjistit, jestli
  -- má každé vědro aspoň jeden žeton.
  FOREACH k IN ARRAY (SELECT array_agg(x ORDER BY x) FROM unnest(p_keys) AS x) LOOP
    SELECT tokens, updated_at INTO v_tokens, v_updated
      FROM ingest_rate_limits WHERE key = k FOR UPDATE;

    v_tokens := LEAST(
      p_capacity,
      v_tokens + EXTRACT(EPOCH FROM (p_now - v_updated)) * p_refill_per_second
    );

    UPDATE ingest_rate_limits
       SET tokens = v_tokens, updated_at = p_now
     WHERE key = k;

    IF v_tokens < 1 THEN
      RETURN FALSE;
    END IF;
  END LOOP;

  -- Druhý průchod: teprve teď odebrat. Zámky z prvního průchodu drží
  -- do konce transakce, takže mezi tím nikdo nic nezmění.
  UPDATE ingest_rate_limits
     SET tokens = tokens - 1
   WHERE key = ANY (p_keys);

  RETURN TRUE;
END $$;

REVOKE ALL ON FUNCTION ingest_take_tokens(TEXT[], DOUBLE PRECISION, DOUBLE PRECISION, TIMESTAMPTZ) FROM PUBLIC;
REVOKE ALL ON FUNCTION ingest_take_tokens(TEXT[], DOUBLE PRECISION, DOUBLE PRECISION, TIMESTAMPTZ) FROM anon;
REVOKE ALL ON FUNCTION ingest_take_tokens(TEXT[], DOUBLE PRECISION, DOUBLE PRECISION, TIMESTAMPTZ) FROM authenticated;
GRANT EXECUTE ON FUNCTION ingest_take_tokens(TEXT[], DOUBLE PRECISION, DOUBLE PRECISION, TIMESTAMPTZ) TO service_role;

-- ── 1E: odkud požadavek přišel ───────────────────────────────────

ALTER TABLE detections ADD COLUMN IF NOT EXISTS source_ip INET;
ALTER TABLE detections ADD COLUMN IF NOT EXISTS ingest_key_id TEXT;

COMMENT ON COLUMN detections.source_ip IS
  'IP, ze které detekce dorazila. Z x-forwarded-for; u detekcí z dronu '
  'a starších záznamů NULL.';
COMMENT ON COLUMN detections.ingest_key_id IS
  'Kterým klíčem byl požadavek podepsaný: sériové číslo kamery '
  '(vlastní klíč) nebo "shared" (společný INGEST_SECRET).';

-- ── 1D: ochrana proti přehrání ───────────────────────────────────
--
-- Podpis dosud kryl jen okno 300 s; uvnitř něj šlo tentýž požadavek
-- poslat opakovaně a pokaždé vznikla další detekce. Dvě různé detekce
-- z jedné kamery ve stejný okamžik na mikrosekundu neexistují, takže
-- unikát na (camera_id, detected_at) rozliší přehrání od skutečnosti.
--
-- Detekce z dronu mají camera_id NULL a unikát se jich netýká —
-- v Postgresu se NULL nerovná NULL.

DO $$
DECLARE v_duplicity BIGINT;
BEGIN
  SELECT count(*) INTO v_duplicity FROM (
    SELECT camera_id, detected_at
      FROM detections
     WHERE camera_id IS NOT NULL
     GROUP BY camera_id, detected_at
    HAVING count(*) > 1
  ) d;

  IF v_duplicity > 0 THEN
    RAISE EXCEPTION
      'V detections je % dvojic se stejnou kamerou a časem. Unikát by '
      'je odmítl — nejdřív je projděte a rozhodněte, které smazat.',
      v_duplicity;
  END IF;
END $$;

-- Vlastní jméno, ne idx_detections_camera_time: to už zabírá obyčejný
-- index ze základní migrace a CREATE UNIQUE INDEX IF NOT EXISTS hlídá
-- jen jméno, ne definici. Tiše by neudělal nic a ochrana proti
-- přehrání by neexistovala, aniž by to cokoli ohlásilo.
CREATE UNIQUE INDEX IF NOT EXISTS idx_detections_replay_guard
  ON detections (camera_id, detected_at)
  WHERE camera_id IS NOT NULL;

-- ── 4C: detekce se nesmí mazat ───────────────────────────────────
--
-- Detekce je důkaz. Politika FOR ALL zahrnovala i DELETE, takže je
-- správce lokality mohl odstranit — a detections se schválně
-- neauditují, takže beze stopy. Sám audit_log je proti mazání
-- chráněný triggerem; tabulka s důkazy má být taky.

DROP POLICY IF EXISTS "write_detections" ON detections;

DROP POLICY IF EXISTS "insert_detections" ON detections;
CREATE POLICY "insert_detections" ON detections
  FOR INSERT TO authenticated
  WITH CHECK (site_is_manager(site_id));

DROP POLICY IF EXISTS "update_detections" ON detections;
CREATE POLICY "update_detections" ON detections
  FOR UPDATE TO authenticated
  USING (site_is_manager(site_id))
  WITH CHECK (site_is_manager(site_id));

-- Žádná politika pro DELETE. Bez ní RLS mazání nepustí nikomu
-- z přihlášených; service_role ho obchází, což je záměr — opravu
-- dat musí udělat někdo se servisním klíčem, ne klient v portálu.
