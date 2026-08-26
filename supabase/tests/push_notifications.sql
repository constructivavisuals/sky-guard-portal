-- Test odběrů a předvoleb notifikací. Běží v transakci s ROLLBACKem.
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
  WHEN unique_violation THEN RAISE NOTICE 'ok    % — odmítnuto unikátností', label;
  WHEN check_violation THEN RAISE NOTICE 'ok    % — odmítnuto omezením', label;
  WHEN foreign_key_violation THEN RAISE NOTICE 'ok    % — odmítnuto cizím klíčem', label;
END $$;

-- ── Data ─────────────────────────────────────────────────────────

INSERT INTO auth.users (id) VALUES
  ('00000000-0000-0000-0000-0000000e0001'),
  ('00000000-0000-0000-0000-0000000e0002');
INSERT INTO profiles (id, email, role) VALUES
  ('00000000-0000-0000-0000-0000000e0001', 'admin@sky-guard.cz', 'admin'),
  ('00000000-0000-0000-0000-0000000e0002', 'klient@example.com', 'viewer');
INSERT INTO sites (id, name, timezone) VALUES
  ('00000000-0000-0000-0000-0000000a0001', 'Areál', 'Europe/Prague'),
  ('00000000-0000-0000-0000-0000000a0002', 'Cizí areál', 'Europe/Prague');
INSERT INTO site_grants (profile_id, site_id) VALUES
  ('00000000-0000-0000-0000-0000000e0002', '00000000-0000-0000-0000-0000000a0001');

-- ── Odběry ───────────────────────────────────────────────────────

INSERT INTO push_subscriptions (profile_id, endpoint, p256dh, auth, user_agent)
VALUES
  ('00000000-0000-0000-0000-0000000e0001', 'https://push.example/a', 'p1', 'a1', 'Firefox'),
  ('00000000-0000-0000-0000-0000000e0002', 'https://push.example/b', 'p2', 'a2', 'Safari');

SELECT test_expect('odběry založené', (SELECT count(*) FROM push_subscriptions), 2);

-- Tentýž prohlížeč vrací tentýž endpoint. Druhý řádek by znamenal,
-- že se notifikace pošle dvakrát.
SELECT test_expect_rejected('druhý odběr na stejný endpoint neprojde', $sql$
  INSERT INTO push_subscriptions (profile_id, endpoint, p256dh, auth)
  VALUES ('00000000-0000-0000-0000-0000000e0001', 'https://push.example/a', 'x', 'y')
$sql$);

-- ── Předvolby ────────────────────────────────────────────────────

INSERT INTO notification_prefs (profile_id, site_id)
VALUES ('00000000-0000-0000-0000-0000000e0002', '00000000-0000-0000-0000-0000000a0001');

SELECT test_expect('výchozí: zásah odeslán zapnuto',
  (SELECT count(*) FROM notification_prefs WHERE on_dispatch_sent), 1);
SELECT test_expect('výchozí: potlačený zásah vypnuto',
  (SELECT count(*) FROM notification_prefs WHERE on_dispatch_suppressed), 0);
SELECT test_expect('výchozí: potvrzený nález zapnuto',
  (SELECT count(*) FROM notification_prefs WHERE on_threat_confirmed), 1);

SELECT test_expect_rejected('druhá sada předvoleb pro touž lokalitu neprojde', $sql$
  INSERT INTO notification_prefs (profile_id, site_id)
  VALUES ('00000000-0000-0000-0000-0000000e0002', '00000000-0000-0000-0000-0000000a0001')
$sql$);

-- Jedna hranice tichých hodin sama okno neurčuje.
SELECT test_expect_rejected('tiché hodiny jen s jednou hranicí neprojdou', $sql$
  INSERT INTO notification_prefs (profile_id, site_id, quiet_from)
  VALUES ('00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000a0001', '22:00')
$sql$);

-- Shodné hranice by šlo číst jako „nikdy“ i „pořád“.
SELECT test_expect_rejected('prázdné okno tichých hodin neprojde', $sql$
  INSERT INTO notification_prefs (profile_id, site_id, quiet_from, quiet_to)
  VALUES ('00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000a0001',
          '22:00', '22:00')
$sql$);

-- Okno přes půlnoc je naopak v pořádku, stejně jako u střežení.
INSERT INTO notification_prefs (profile_id, site_id, quiet_from, quiet_to)
VALUES ('00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000a0001',
        '22:00', '06:00');
SELECT test_expect('okno přes půlnoc projde',
  (SELECT count(*) FROM notification_prefs WHERE quiet_from > quiet_to), 1);

-- ── Mazání ───────────────────────────────────────────────────────
--
-- Tady se schválně mazat SMÍ: mrtvý odběr se musí dát uklidit.

DELETE FROM push_subscriptions WHERE endpoint = 'https://push.example/b';
SELECT test_expect('odběr jde smazat', (SELECT count(*) FROM push_subscriptions), 1);

-- Smazaný profil vezme své odběry i předvolby s sebou.
DELETE FROM profiles WHERE id = '00000000-0000-0000-0000-0000000e0002';
SELECT test_expect('odběry smazaného profilu jsou pryč',
  (SELECT count(*) FROM push_subscriptions
   WHERE profile_id = '00000000-0000-0000-0000-0000000e0002'), 0);
SELECT test_expect('předvolby smazaného profilu jsou pryč',
  (SELECT count(*) FROM notification_prefs
   WHERE profile_id = '00000000-0000-0000-0000-0000000e0002'), 0);

-- ── RLS ──────────────────────────────────────────────────────────

INSERT INTO auth.users (id) VALUES ('00000000-0000-0000-0000-0000000e0003');
INSERT INTO profiles (id, email, role) VALUES
  ('00000000-0000-0000-0000-0000000e0003', 'druhy@example.com', 'viewer');
INSERT INTO site_grants (profile_id, site_id) VALUES
  ('00000000-0000-0000-0000-0000000e0003', '00000000-0000-0000-0000-0000000a0001');
INSERT INTO push_subscriptions (profile_id, endpoint, p256dh, auth)
VALUES ('00000000-0000-0000-0000-0000000e0003', 'https://push.example/c', 'p3', 'a3');

SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000e0003"}';

-- Odběr je adresa zařízení. Cizí nemá vidět nikdo.
SELECT test_expect('uživatel vidí jen své odběry',
  (SELECT count(*) FROM push_subscriptions), 1);

DELETE FROM push_subscriptions
WHERE endpoint = 'https://push.example/a';
SELECT test_expect('cizí odběr nesmaže',
  (SELECT count(*) FROM push_subscriptions
   WHERE endpoint = 'https://push.example/a'), 0);

-- Předvolby k lokalitě bez přístupu neprojdou.
DO $$
BEGIN
  INSERT INTO notification_prefs (profile_id, site_id)
  VALUES ('00000000-0000-0000-0000-0000000e0003', '00000000-0000-0000-0000-0000000a0002');
  RAISE EXCEPTION 'FAIL  předvolby k cizí lokalitě prošly';
EXCEPTION
  WHEN insufficient_privilege THEN
    RAISE NOTICE 'ok    předvolby k cizí lokalitě neprojdou';
END $$;

-- Ani na cizí jméno.
DO $$
BEGIN
  INSERT INTO push_subscriptions (profile_id, endpoint, p256dh, auth)
  VALUES ('00000000-0000-0000-0000-0000000e0001', 'https://push.example/d', 'x', 'y');
  RAISE EXCEPTION 'FAIL  odběr na cizí profil prošel';
EXCEPTION
  WHEN insufficient_privilege THEN
    RAISE NOTICE 'ok    odběr na cizí profil neprojde';
END $$;

RESET ROLE;

-- Admin na cizí odběry taky nevidí — z jakého zařízení kdo chodí, se
-- ho netýká.
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000e0001"}';

SELECT test_expect('ani admin cizí odběry nevidí',
  (SELECT count(*) FROM push_subscriptions), 1);

RESET ROLE;

-- Log odstupů není pro přihlášené vůbec: RLS bez jediné politiky.
INSERT INTO notification_log (site_id, kind, target)
VALUES ('00000000-0000-0000-0000-0000000a0001', 'camera_silent', 'cam-1');

SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000e0001"}';
SELECT test_expect('log odstupů nevidí ani admin',
  (SELECT count(*) FROM notification_log), 0);
RESET ROLE;

SELECT test_expect_rejected('druhý log pro touž událost neprojde', $sql$
  INSERT INTO notification_log (site_id, kind, target)
  VALUES ('00000000-0000-0000-0000-0000000a0001', 'camera_silent', 'cam-1')
$sql$);

DO $$ BEGIN RAISE NOTICE 'VŠECHNY TESTY PROŠLY'; END $$;
ROLLBACK;
