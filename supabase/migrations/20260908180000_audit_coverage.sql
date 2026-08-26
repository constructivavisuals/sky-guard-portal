-- ═══════════════════════════════════════════════════════════════════
-- Doplnění auditu.
--
-- audit_log NENÍ mrtvé schéma, jak to na první pohled vypadá: zapisuje
-- do něj trigger audit_row() na profiles, sites, zones, cameras
-- a dispatches. V aplikačním kódu se na tabulku nesahá vůbec, takže
-- hledání podle `grep audit_log src/` nic nenajde — což je přesně to,
-- proč je trigger lepší než volání z akce. Nová cesta zápisu se do něj
-- dostane sama.
--
-- Chybí ale tři konfigurační tabulky, které přibyly později:
--   known_plates  kdo přidal nebo odebral značku ze seznamu
--   patrols       kdo změnil rozvrh hlídek
--   carriers      kdo vydal nebo zrušil odkaz dopravci
--
-- Vjezdy, detekce a ohlášené příjezdy schválně NE: jsou to události,
-- ne konfigurace, a jsou samy o sobě záznamem.
--
-- ═══ Redakce tajemství ═════════════════════════════════════════════
-- Trigger ukládá celý řádek. U carriers by to znamenalo token v deníku,
-- který je append-only — po rotaci odkazu by v něm ten starý zůstal
-- navždy. audit_row() proto citlivé sloupce vyhazuje. Týká se to
-- i cameras.ingest_secret_hash, kde to platilo už dřív.
--
-- Idempotentní: bezpečné spustit víckrát.
-- ═══════════════════════════════════════════════════════════════════

SET search_path = public, extensions;

-- ── Redakce + tytéž zápisy jako dosud ────────────────────────────

CREATE OR REPLACE FUNCTION audit_redact(p_row JSONB)
RETURNS JSONB LANGUAGE sql IMMUTABLE AS $$
  -- `-` na jsonb klíč, který tam není, nic neudělá, takže se to dá
  -- řetězit přes všechny tabulky bez podmínek.
  SELECT p_row - 'token' - 'ingest_secret_hash' - 'p256dh' - 'auth';
$$;

COMMENT ON FUNCTION audit_redact(JSONB) IS
  'Vyhodí z auditovaného řádku přístupové údaje. Deník je append-only, '
  'takže co se do něj jednou dostane, tam zůstane napořád.';

CREATE OR REPLACE FUNCTION audit_row()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_row     JSONB;
  v_entity  UUID;
  v_meta    JSONB;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_row := audit_redact(to_jsonb(OLD));
    v_meta := jsonb_build_object('old', v_row);
  ELSIF TG_OP = 'UPDATE' THEN
    v_row := audit_redact(to_jsonb(NEW));
    -- Jen skutečně změněná pole — log zůstane čitelný.
    v_meta := jsonb_build_object(
      'changed', (
        SELECT COALESCE(jsonb_object_agg(key, jsonb_build_object('old', o.value, 'new', n.value)), '{}'::jsonb)
        FROM jsonb_each(audit_redact(to_jsonb(OLD))) AS o(key, value)
        JOIN jsonb_each(v_row) AS n(key, value) USING (key)
        WHERE o.value IS DISTINCT FROM n.value
          AND key <> 'updated_at'
      )
    );
    -- Bez reálné změny (jen touch updated_at) se nezapisuje nic.
    IF v_meta->'changed' = '{}'::jsonb THEN
      RETURN NEW;
    END IF;
  ELSE
    v_row := audit_redact(to_jsonb(NEW));
    v_meta := jsonb_build_object('new', v_row);
  END IF;

  v_entity := (v_row->>'id')::UUID;

  INSERT INTO audit_log (actor_id, action, entity_type, entity_id, metadata)
  VALUES (auth.uid(), lower(TG_OP), TG_TABLE_NAME, v_entity, v_meta);

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END; $$;

-- ── Trigger na chybějící tabulky ─────────────────────────────────

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['known_plates', 'patrols', 'carriers'] LOOP
    -- Tabulka nemusí existovat, když se migrace pouští na starším
    -- schématu; přeskočit je lepší než spadnout.
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = t
    ) THEN
      RAISE NOTICE 'Tabulka % neexistuje — přeskakuji.', t;
      CONTINUE;
    END IF;

    EXECUTE format('DROP TRIGGER IF EXISTS %I_audit ON %I', t, t);
    EXECUTE format(
      'CREATE TRIGGER %I_audit AFTER INSERT OR UPDATE OR DELETE ON %I
         FOR EACH ROW EXECUTE FUNCTION audit_row()', t, t
    );
  END LOOP;
END $$;

-- ── Autor deníku ─────────────────────────────────────────────────
--
-- Stránka deníku chce ukázat jméno, ne UUID. Cizí klíč tu dosud nebyl,
-- takže se profil nedal připojit vnořeným výběrem.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'audit_log_actor_id_fkey'
  ) THEN
    -- ON DELETE SET NULL, ne CASCADE: smazaný účet nesmí odnést
    -- záznamy o tom, co dělal.
    ALTER TABLE audit_log
      ADD CONSTRAINT audit_log_actor_id_fkey
      FOREIGN KEY (actor_id) REFERENCES profiles(id) ON DELETE SET NULL;
  END IF;
END $$;
