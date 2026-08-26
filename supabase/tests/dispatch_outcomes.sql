-- Testy zápisu zásahu: každý výsledek, který kód umí vyrobit, musí jít
-- uložit. Pojistka proti tomu, co se stalo s podmínkou
-- dispatches_incident_matches_outcome — enum se rozšiřoval, podmínka
-- ne, a čtyři ze sedmi výsledků databáze tiše odmítala.
--
-- Zásah zapisuje service_role, takže RLS se tu neřeší; jde o samotnou
-- podmínku.

\set ON_ERROR_STOP on
SET search_path = public, extensions;

BEGIN;

INSERT INTO sites (id, name, timezone, armed_from, armed_to, armed_days)
VALUES ('aaaaaaaa-0000-0000-0000-00000000d001', 'Test zásahů', 'Europe/Prague',
        '18:00', '06:00', ARRAY[1,2,3,4,5]);

INSERT INTO zones (id, site_id, name)
VALUES ('aaaaaaaa-0000-0000-0000-00000000d002',
        'aaaaaaaa-0000-0000-0000-00000000d001', 'Brána');

DO $$
DECLARE
  v_outcome TEXT;
  v_ok      BOOLEAN;
BEGIN
  -- ── Potlačené: bez stopy na FlightHub ──────────────────────────
  FOREACH v_outcome IN ARRAY ARRAY[
    'suppressed_disarmed', 'suppressed_cooldown', 'suppressed_dock',
    'suppressed_unknown', 'suppressed_announced'
  ] LOOP
    BEGIN
      EXECUTE format($q$
        INSERT INTO dispatches (site_id, zone_id, level_sent, outcome)
        VALUES ('aaaaaaaa-0000-0000-0000-00000000d001',
                'aaaaaaaa-0000-0000-0000-00000000d002', 1, %L)
      $q$, v_outcome);
      RAISE NOTICE 'ok  %: potlačený zásah se zapsal', v_outcome;
    EXCEPTION WHEN check_violation THEN
      RAISE EXCEPTION 'FAIL %: potlačený zásah databáze odmítla', v_outcome;
    END;
  END LOOP;

  -- ── Odeslaný přes plánovanou úlohu ─────────────────────────────
  BEGIN
    INSERT INTO dispatches (site_id, zone_id, level_sent, outcome, fh_task_uuid)
    VALUES ('aaaaaaaa-0000-0000-0000-00000000d001',
            'aaaaaaaa-0000-0000-0000-00000000d002', 5, 'sent', 'task-1');
    RAISE NOTICE 'ok  sent s fh_task_uuid se zapsal';
  EXCEPTION WHEN check_violation THEN
    RAISE EXCEPTION 'FAIL sent s fh_task_uuid databáze odmítla — dron letí, portál o tom neví';
  END;

  -- ── Odeslaný ze staré cesty ────────────────────────────────────
  BEGIN
    INSERT INTO dispatches (site_id, zone_id, level_sent, outcome, fh_incident_uuid)
    VALUES ('aaaaaaaa-0000-0000-0000-00000000d001',
            'aaaaaaaa-0000-0000-0000-00000000d002', 5, 'sent', 'incident-1');
    RAISE NOTICE 'ok  historický sent s fh_incident_uuid se zapsal';
  EXCEPTION WHEN check_violation THEN
    RAISE EXCEPTION 'FAIL historický sent databáze odmítla';
  END;

  -- ── Odeslaný bez jakékoli stopy projít NESMÍ ───────────────────
  v_ok := FALSE;
  BEGIN
    INSERT INTO dispatches (site_id, zone_id, level_sent, outcome)
    VALUES ('aaaaaaaa-0000-0000-0000-00000000d001',
            'aaaaaaaa-0000-0000-0000-00000000d002', 5, 'sent');
  EXCEPTION WHEN check_violation THEN
    v_ok := TRUE;
  END;
  IF NOT v_ok THEN
    RAISE EXCEPTION 'FAIL sent bez task_uuid i incidentu prošel — zásah bez dohledatelné úlohy';
  END IF;
  RAISE NOTICE 'ok  sent bez stopy na FlightHub neprojde';

  -- ── Potlačený s úlohou projít NESMÍ ────────────────────────────
  v_ok := FALSE;
  BEGIN
    INSERT INTO dispatches (site_id, zone_id, level_sent, outcome, fh_task_uuid)
    VALUES ('aaaaaaaa-0000-0000-0000-00000000d001',
            'aaaaaaaa-0000-0000-0000-00000000d002', 1, 'suppressed_dock', 'task-2');
  EXCEPTION WHEN check_violation THEN
    v_ok := TRUE;
  END;
  IF NOT v_ok THEN
    RAISE EXCEPTION 'FAIL potlačený zásah s úlohou prošel — potlačený znamená, že se nikam nevolalo';
  END IF;
  RAISE NOTICE 'ok  potlačený s úlohou neprojde';

  -- ── failed bez omezení ─────────────────────────────────────────
  BEGIN
    INSERT INTO dispatches (site_id, zone_id, level_sent, outcome, fh_task_uuid)
    VALUES ('aaaaaaaa-0000-0000-0000-00000000d001',
            'aaaaaaaa-0000-0000-0000-00000000d002', 1, 'failed', 'task-3');
    INSERT INTO dispatches (site_id, zone_id, level_sent, outcome)
    VALUES ('aaaaaaaa-0000-0000-0000-00000000d001',
            'aaaaaaaa-0000-0000-0000-00000000d002', 1, 'failed');
    RAISE NOTICE 'ok  failed projde s úlohou i bez ní';
  EXCEPTION WHEN check_violation THEN
    RAISE EXCEPTION 'FAIL failed databáze odmítla';
  END;

  -- ── Ruční zásah: bez detekce ───────────────────────────────────
  BEGIN
    INSERT INTO dispatches (site_id, zone_id, level_sent, outcome,
                            fh_task_uuid, triggered_by_detection)
    VALUES ('aaaaaaaa-0000-0000-0000-00000000d001',
            'aaaaaaaa-0000-0000-0000-00000000d002', 5, 'sent', 'task-4', NULL);
    RAISE NOTICE 'ok  ruční zásah bez detekce se zapsal';
  EXCEPTION WHEN check_violation THEN
    RAISE EXCEPTION 'FAIL ruční zásah databáze odmítla';
  END;

  RAISE NOTICE 'VŠECHNY TESTY PROŠLY';
END $$;

ROLLBACK;
