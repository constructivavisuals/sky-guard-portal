-- ═══════════════════════════════════════════════════════════════════
-- Zásah přes plánovanou úlohu místo workflow triggeru.
--
-- Důvod je provozní, ne technický: Triggered Workflow ve FlightHubu
-- vyžaduje ruční potvrzení v Message Centru. Mise se bez kliknutí
-- nespustí, takže celá automatická cesta nikdy nedoletěla. Ověřeno
-- naostro. Automaticky jde spustit jedině plánovaná úloha (task_type
-- 'timed') — přesně to, co už dělá cron hlídek.
--
-- Plánovaná úloha ale nechce souřadnice, chce TRASU. Zóna proto musí
-- nést vlastní trasu ve FlightHubu; dron po ní letí.
--
-- Idempotentní: bezpečné spustit víckrát.
-- ═══════════════════════════════════════════════════════════════════

SET search_path = public, extensions;

-- ── Trasa zóny ───────────────────────────────────────────────────

ALTER TABLE zones ADD COLUMN IF NOT EXISTS wayline_uuid TEXT;

COMMENT ON COLUMN zones.wayline_uuid IS
  'Trasa ve FlightHubu, po které dron k zóně letí (GET /openapi/v0.1/'
  'wayline → data.list[].id). Opaque string, ne validované UUID. '
  'NULL = zóna trasu nemá a zásah z ní neodejde; přehled na to '
  'upozorňuje varováním, stejně jako u kamer bez zóny.';

-- zones.location zůstává: waypoint je pořád to, co se ukazuje na mapě
-- a v detailu zásahu. Do plánované úlohy se ale neposílá — tu vede
-- trasa.

-- ── Úloha u zásahu ───────────────────────────────────────────────

ALTER TABLE dispatches ADD COLUMN IF NOT EXISTS fh_task_uuid TEXT;

COMMENT ON COLUMN dispatches.fh_task_uuid IS
  'UUID plánované úlohy z POST /openapi/v0.1/flight-task. Táž hodnota '
  'je i na letu (flights.fh_task_uuid), podle kterého ji dotahuje '
  'synchronizace — tady je proto, aby šlo z pokusu o zásah dohledat '
  'úlohu i tehdy, když se řádek letu nepodařilo založit.';

COMMENT ON COLUMN dispatches.fh_incident_uuid IS
  'Incident ze staré cesty přes POST /openapi/v0.1/workflow. Nové '
  'zásahy ho nevyplňují — workflow trigger čekal na ruční potvrzení '
  'v Message Centru, takže se přes něj nikdy automaticky neletělo. '
  'Sloupec zůstává kvůli historickým řádkům.';

-- ── Nevyhovující dok není chyba ──────────────────────────────────
--
-- Dron mimo dok, vybitá baterie nebo plné úložiště jsou normální
-- provozní stavy — u hlídek se kvůli nim let přeskočí a cron to hlásí
-- jako 'skipped', ne jako selhání. Zásah potřebuje totéž: 'failed' by
-- svítilo červeně a tvrdilo, že se něco pokazilo.
ALTER TYPE dispatch_outcome ADD VALUE IF NOT EXISTS 'suppressed_dock';
