-- ═══════════════════════════════════════════════════════════════════
-- Tichá selhání: rozlišit „nevíme“ od „rozhodli jsme“.
--
-- Dvě věci:
--
--   1. dispatch_outcome dostává 'suppressed_unknown'. Dosud se každé
--      selhání dotazu tvářilo jako rozhodnutí: nedostupná databáze
--      vrátila „nestřeží“ a v detailu zásahu pak stálo „lokalita v tu
--      chvíli nestřežila“. To je tvrzení o areálu, ne o databázi —
--      a je nepravdivé.
--
--   2. cron_runs. Tři endpointy volá cron zvenčí a nikdo nehlídá, že
--      opravdu běží. Když se crontab rozbije, hlídky prostě přestanou
--      létat a portál vypadá jako v klidnou noc.
--
-- Idempotentní: bezpečné spustit víckrát.
-- ═══════════════════════════════════════════════════════════════════

SET search_path = public, extensions;

-- ── Nezjištěný stav není potlačení ───────────────────────────────

ALTER TYPE dispatch_outcome ADD VALUE IF NOT EXISTS 'suppressed_unknown';

-- ── Běhy cronu ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS cron_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- 'patrols', 'flights', 'warnings'. Ne enum: přidat další endpoint
  -- má být změna v kódu, ne migrace typu.
  name TEXT NOT NULL,
  ran_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Souhrn, který endpoint vrátil. Ať jde zpětně dohledat, co dělal
  -- běh, po kterém přestaly chodit lety.
  result JSONB NOT NULL DEFAULT '{}'::jsonb
);

COMMENT ON TABLE cron_runs IS
  'Kdy naposledy proběhl který cron a s jakým výsledkem. Přehled z toho '
  'hlásí varování, když je poslední běh starší než trojnásobek '
  'intervalu daného endpointu.';

-- Dotaz je vždy „poslední běh podle jména“.
CREATE INDEX IF NOT EXISTS idx_cron_runs_name_time
  ON cron_runs(name, ran_at DESC);

-- ── RLS ──────────────────────────────────────────────────────────
--
-- Čtení všem přihlášeným: „hlídky nelétají“ je zpráva i pro klienta,
-- kterého se to týká nejvíc. Zapisuje výhradně service_role z cronu.

ALTER TABLE cron_runs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "read_cron_runs" ON cron_runs;
CREATE POLICY "read_cron_runs" ON cron_runs
  FOR SELECT TO authenticated
  USING (TRUE);

-- Bez GRANTu by RLS nedostala slovo — dotaz by spadl dřív, na právech.
GRANT SELECT ON cron_runs TO authenticated;
GRANT ALL ON cron_runs TO service_role;
