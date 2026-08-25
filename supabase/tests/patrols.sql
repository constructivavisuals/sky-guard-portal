-- Test hlídek a rozšíření letů. Běží v transakci s ROLLBACKem.
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

CREATE FUNCTION public.test_expect_rejected(label TEXT, stmt TEXT)
RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE stmt;
  RAISE EXCEPTION 'FAIL  % — prošlo, ačkoli mělo být odmítnuto', label;
EXCEPTION
  WHEN check_violation THEN RAISE NOTICE 'ok    % — odmítnuto omezením', label;
  WHEN unique_violation THEN RAISE NOTICE 'ok    % — odmítnuto unikátností', label;
  WHEN foreign_key_violation THEN RAISE NOTICE 'ok    % — odmítnuto cizím klíčem', label;
END $$;

GRANT EXECUTE ON FUNCTION public.test_expect(TEXT, BIGINT, BIGINT) TO authenticated;

INSERT INTO auth.users (id) VALUES
  ('00000000-0000-0000-0000-0000000000a1'),
  ('00000000-0000-0000-0000-0000000000a2');
INSERT INTO profiles (id, email, role) VALUES
  ('00000000-0000-0000-0000-0000000000a1', 'admin@sky-guard.cz', 'admin'),
  ('00000000-0000-0000-0000-0000000000a2', 'klient@kralupy.cz', 'viewer');
INSERT INTO sites (id, name, timezone, dock_sn) VALUES
  ('00000000-0000-0000-0000-000000000001', 'Areál Kralupy', 'Europe/Prague', 'DOCK-001');
INSERT INTO site_grants (profile_id, site_id) VALUES
  ('00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-000000000001');

INSERT INTO patrols (id, site_id, name, wayline_uuid, window_from, window_to, days, interval_minutes)
VALUES ('00000000-0000-0000-0000-000000000061', '00000000-0000-0000-0000-000000000001',
        'Ranní obchůzka', 'wl-1', '08:00', '18:00', ARRAY[1,2,3,4,5], 120);

-- ── Omezení ──────────────────────────────────────────────────────

SELECT public.test_expect_rejected('interval 0 neprojde',
  $s$INSERT INTO patrols (site_id, name, wayline_uuid, interval_minutes)
     VALUES ('00000000-0000-0000-0000-000000000001', 'X', 'wl', 0)$s$);

SELECT public.test_expect_rejected('interval nad den neprojde',
  $s$INSERT INTO patrols (site_id, name, wayline_uuid, interval_minutes)
     VALUES ('00000000-0000-0000-0000-000000000001', 'Y', 'wl', 1441)$s$);

SELECT public.test_expect_rejected('prázdné dny neprojdou',
  $s$INSERT INTO patrols (site_id, name, wayline_uuid, days)
     VALUES ('00000000-0000-0000-0000-000000000001', 'Z', 'wl', ARRAY[]::int[])$s$);

SELECT public.test_expect_rejected('shodné okno neprojde',
  $s$INSERT INTO patrols (site_id, name, wayline_uuid, window_from, window_to)
     VALUES ('00000000-0000-0000-0000-000000000001', 'W', 'wl', '08:00', '08:00')$s$);

SELECT public.test_expect_rejected('dvě hlídky téhož jména na lokalitě',
  $s$INSERT INTO patrols (site_id, name, wayline_uuid)
     VALUES ('00000000-0000-0000-0000-000000000001', 'ranní obchůzka', 'wl')$s$);

-- ── Lety ─────────────────────────────────────────────────────────

INSERT INTO flights (id, fh_task_uuid, status) VALUES
  ('00000000-0000-0000-0000-000000000051', 'task-stary', 'completed');

SELECT public.test_expect('stávající let má kind dispatch',
  (SELECT count(*) FROM flights
   WHERE id = '00000000-0000-0000-0000-000000000051' AND kind = 'dispatch'), 1);

SELECT public.test_expect_rejected('let hlídky bez patrol_id neprojde',
  $s$INSERT INTO flights (kind, status) VALUES ('patrol', 'pending')$s$);

INSERT INTO flights (id, kind, patrol_id, site_id, fh_task_uuid, started_at, status) VALUES
  ('00000000-0000-0000-0000-000000000052', 'patrol',
   '00000000-0000-0000-0000-000000000061',
   '00000000-0000-0000-0000-000000000001', 'task-uuid-1',
   '2026-08-26T08:00:00+02', 'pending');

SELECT public.test_expect_rejected('tentýž task_uuid podruhé neprojde',
  $s$INSERT INTO flights (kind, patrol_id, fh_task_uuid, started_at, status)
     VALUES ('patrol', '00000000-0000-0000-0000-000000000061', 'task-uuid-1',
             '2026-08-26T10:00:00+02', 'pending')$s$);

-- Tohle je pojistka proti dvojímu naplánování téhož slotu.
SELECT public.test_expect_rejected('tentýž slot hlídky podruhé neprojde',
  $s$INSERT INTO flights (kind, patrol_id, fh_task_uuid, started_at, status)
     VALUES ('patrol', '00000000-0000-0000-0000-000000000061', 'task-uuid-2',
             '2026-08-26T08:00:00+02', 'pending')$s$);

-- Podmínky letu (migrace 20260827120000).
SELECT public.test_expect('nový let zatím podmínky nemá',
  (SELECT count(*) FROM flights
   WHERE id = '00000000-0000-0000-0000-000000000052' AND conditions IS NULL), 1);

UPDATE flights
   SET conditions = '{"wind_speed": 3.4, "rainfall": 0, "environment_temperature": 21.5}'::jsonb
 WHERE id = '00000000-0000-0000-0000-000000000052';

SELECT public.test_expect('vítr jde přečíst po klíči',
  (SELECT count(*) FROM flights
   WHERE id = '00000000-0000-0000-0000-000000000052'
     AND (conditions->>'wind_speed')::numeric = 3.4), 1);

SELECT public.test_expect_rejected('hlídku s letem nelze smazat',
  $s$DELETE FROM patrols WHERE id = '00000000-0000-0000-0000-000000000061'$s$);

-- ── Lokalita letu (migrace 20260827180000) ───────────────────────

SELECT public.test_expect('hlídkový let dostal lokalitu přes hlídku',
  (SELECT count(*) FROM flights
   WHERE id = '00000000-0000-0000-0000-000000000052'
     AND site_id = '00000000-0000-0000-0000-000000000001'), 1);

SELECT public.test_expect('let bez hlídky i zásahu lokalitu nemá',
  (SELECT count(*) FROM flights
   WHERE id = '00000000-0000-0000-0000-000000000051' AND site_id IS NULL), 1);

-- ── RLS ──────────────────────────────────────────────────────────

SET LOCAL request.jwt.claims TO '{"sub":"00000000-0000-0000-0000-0000000000a2","role":"authenticated"}';
SET LOCAL ROLE authenticated;
SELECT public.test_expect('klient s grantem hlídku vidí', (SELECT count(*) FROM patrols), 1);
-- Hlídkový let nevisí na zásahu; bez site_id by ho viděl jen admin.
SELECT public.test_expect('a vidí i její let', (SELECT count(*) FROM flights), 1);
RESET ROLE;

SET LOCAL request.jwt.claims TO '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}';
SET LOCAL ROLE authenticated;
SELECT public.test_expect('admin ji vidí taky', (SELECT count(*) FROM patrols), 1);
RESET ROLE;

DO $$ BEGIN RAISE NOTICE 'VŠECHNY TESTY PROŠLY'; END $$;
ROLLBACK;
