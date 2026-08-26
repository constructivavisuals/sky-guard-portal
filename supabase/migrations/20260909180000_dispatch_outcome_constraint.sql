-- ═══════════════════════════════════════════════════════════════════
-- Zásah se nedal zapsat.
--
-- Podmínka dispatches_incident_matches_outcome je z první migrace,
-- kdy zásah odcházel přes workflow trigger a vracel fh_incident_uuid.
-- Od migrace 20260903180000 jde zásah plánovanou úlohou a incident se
-- nevyplňuje — jenže podmínka zůstala:
--
--   (outcome = 'sent' AND fh_incident_uuid IS NOT NULL)
--   OR (outcome IN ('suppressed_disarmed','suppressed_cooldown') AND ...)
--   OR outcome = 'failed'
--
-- Do databáze tedy neprojde ANI JEDEN z těchhle výsledků:
--   sent                  (incident je dnes vždycky NULL)
--   suppressed_dock       (přidáno 20260903180000)
--   suppressed_unknown    (přidáno 20260905120000)
--   suppressed_announced  (přidáno 20260906120000)
--
-- Projevovalo se to přesně tak, jak se tichá selhání projevují: dron
-- vzlétl (úloha se ve FlightHubu založí PŘED zápisem), ale v portálu
-- po něm nezůstalo nic — žádný zásah, tím pádem ani řádek letu, ani
-- notifikace. V logu jediná řádka „Zápis dispatche selhal“.
--
-- Nová podmínka mluví o tom, co dnes platí:
--   sent      musí nést stopu na FlightHub — task_uuid (nová cesta)
--             nebo incident (historické řádky ze staré).
--   suppressed_*  nesmí nést ani jedno: nikam se nevolalo.
--   failed    bez omezení — selhat lze i po tom, co FlightHub úlohu
--             založil (timeout při čtení odpovědi, odmítnutí dronem).
--
-- Idempotentní: bezpečné spustit víckrát.
-- ═══════════════════════════════════════════════════════════════════

SET search_path = public, extensions;

ALTER TABLE dispatches DROP CONSTRAINT IF EXISTS dispatches_incident_matches_outcome;

-- Kdyby v tabulce byly řádky, které nové podmínce nevyhoví, ALTER
-- spadne — a je to tak správně. Radši ať se to ukáže teď, než aby se
-- podmínka přidala jako NOT VALID a lhala o obsahu.
ALTER TABLE dispatches ADD CONSTRAINT dispatches_incident_matches_outcome CHECK (
  (outcome = 'sent'
     AND (fh_task_uuid IS NOT NULL OR fh_incident_uuid IS NOT NULL))
  OR (outcome::TEXT LIKE 'suppressed_%'
     AND fh_task_uuid IS NULL AND fh_incident_uuid IS NULL)
  OR outcome = 'failed'
);

COMMENT ON CONSTRAINT dispatches_incident_matches_outcome ON dispatches IS
  'Odeslaný zásah musí nést stopu na FlightHub (fh_task_uuid z plánované '
  'úlohy, u historických řádků fh_incident_uuid). Potlačený nesmí nést '
  'ani jedno — nikam se nevolalo. failed je bez omezení: selhat lze '
  'i po tom, co FlightHub úlohu založil.';
