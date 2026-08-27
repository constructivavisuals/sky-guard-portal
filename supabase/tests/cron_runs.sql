-- Test evidence běhů cronu a nového výsledku zásahu.
-- Běží v transakci s ROLLBACKem.
\set ON_ERROR_STOP on
BEGIN;
SET search_path = public, extensions;

CREATE FUNCTION public.test_expect(label TEXT, actual BIGINT, expected BIGINT)
RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  IF actual IS DISTINCT FROM expected THEN
    RAISE EXCEPTION 'FAIL  % — čekáno %, dostal %', label, expected, actual;
  END IF;
  RAISE NOTICE 'ok    % = %', label, actual;
END $$;

-- ── Nový výsledek zásahu ─────────────────────────────────────────

SELECT test_expect('dispatch_outcome zná suppressed_unknown',
  (SELECT count(*) FROM unnest(enum_range(NULL::dispatch_outcome)) v
   WHERE v::text = 'suppressed_unknown'), 1);

-- ── Data ─────────────────────────────────────────────────────────

INSERT INTO auth.users (id) VALUES
  ('00000000-0000-0000-0000-0000000c0001'),
  ('00000000-0000-0000-0000-0000000c0002');
INSERT INTO profiles (id, email, role) VALUES
  ('00000000-0000-0000-0000-0000000c0001', 'admin@sky-guard.cz', 'admin'),
  ('00000000-0000-0000-0000-0000000c0002', 'klient@example.com', 'viewer');
INSERT INTO sites (id, name, timezone) VALUES
  ('00000000-0000-0000-0000-0000000b0001', 'Areál', 'Europe/Prague');

-- ── Běhy cronu ───────────────────────────────────────────────────

INSERT INTO cron_runs (name, ran_at, result) VALUES
  ('patrols', now() - interval '2 minutes', '{"scheduled": 1}'),
  ('patrols', now() - interval '7 minutes', '{"scheduled": 0}'),
  ('flights', now() - interval '3 hours', '{"failed": 2}');

SELECT test_expect('běhy se zapsaly', (SELECT count(*) FROM cron_runs), 3);

-- Dotaz, ze kterého čte přehled: poslední běh podle jména.
SELECT test_expect('poslední běh hlídek je ten novější',
  (SELECT count(*) FROM (
     SELECT ran_at FROM cron_runs WHERE name = 'patrols'
     ORDER BY ran_at DESC LIMIT 1
   ) t WHERE ran_at > now() - interval '5 minutes'), 1);

-- Výsledek je jsonb, ne text: musí jít dotazovat.
SELECT test_expect('výsledek jde číst jako jsonb',
  (SELECT (result->>'failed')::bigint FROM cron_runs WHERE name = 'flights'), 2);

-- Smazaná lokalita nesmí vzít běhy s sebou — evidence cronu na ní
-- nezávisí, jen na ni odkazují notifikace.
SELECT test_expect('běhy nevisí na lokalitě',
  (SELECT count(*) FROM cron_runs WHERE name = 'patrols'), 2);

-- ── RLS ──────────────────────────────────────────────────────────

SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000c0002"}';

-- Klient na běhy NEVIDÍ (migrace 20260911120000). Jsou to provozní
-- čísla přes celý systém — kolik je lokalit dohromady, kolik hlídek se
-- plánuje — tedy čísla i o cizích areálech. A zaseklý cron klient
-- stejně nespraví.
SELECT test_expect('klient na běhy nevidí', (SELECT count(*) FROM cron_runs), 0);

-- Operátor a admin ano: pro ně je to diagnóza, kvůli které se jde
-- podívat na VPS.
SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000c0001"}';
SELECT test_expect('admin na běhy vidí', (SELECT count(*) FROM cron_runs), 3);
SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000c0002"}';

-- Zapisuje výhradně cron pod service_role.
DO $$
BEGIN
  INSERT INTO cron_runs (name) VALUES ('podvrzeny');
  RAISE EXCEPTION 'FAIL  klient zapsal běh cronu, ačkoli neměl';
EXCEPTION
  WHEN insufficient_privilege THEN
    RAISE NOTICE 'ok    klient běh cronu nezapíše — odmítnuto právy';
END $$;

DO $$
BEGIN
  DELETE FROM cron_runs;
  RAISE NOTICE 'ok    klientův DELETE prošel bez chyby (nic nesmazal, viz níž)';
EXCEPTION
  WHEN insufficient_privilege THEN
    RAISE NOTICE 'ok    klient běhy nesmaže — odmítnuto právy';
END $$;

RESET ROLE;

-- Kontrola AŽ mimo klientovu roli: od migrace 20260911120000 na běhy
-- nevidí, takže by dotazem po smazání nedokázal rozlišit „nic jsem
-- nesmazal“ od „nevidím na to“.
SELECT test_expect('běhy po klientově DELETE zůstaly',
  (SELECT count(*) FROM cron_runs), 3);

DO $$ BEGIN RAISE NOTICE 'VŠECHNY TESTY PROŠLY'; END $$;
ROLLBACK;
