-- ═══════════════════════════════════════════════════════════════════
-- Kolik záznamů má kamera v jednotlivé dny.
--
-- Kalendář v seznamu záznamů potřebuje počty po dnech. Spočítat je na
-- klientovi by znamenalo stáhnout started_at všech záznamů lokality —
-- při pohybovém nahrávání jsou to za měsíc tisíce řádků kvůli číslu
-- v dlaždici kalendáře.
--
-- ═══ ZÁMĚRNĚ BEZ security definer ══════════════════════════════════
-- Funkce běží právy volajícího, takže se uplatní RLS nad
-- camera_recordings (site_is_visible přes kameru). Kdo na lokalitu
-- nevidí, dostane prázdný výsledek — ne chybu a hlavně ne cizí čísla.
--
-- Kdyby tu SECURITY DEFINER bylo, obešla by se RLS a stačilo by uhodnout
-- UUID lokality, aby šlo zjistit, kdy se na cizí stavbě natáčelo.
--
-- ═══ Den je den LOKALITY ═══════════════════════════════════════════
-- `AT TIME ZONE s.timezone`, ne UTC: uživatel přemýšlí v místních dnech
-- a v UTC by se každý letní večer po 22:00 přelil do dalšího dne.
-- Stejná úmluva jako v lib/recordings/timeline.ts.
--
-- Idempotentní: bezpečné spustit víckrát.
-- ═══════════════════════════════════════════════════════════════════

SET search_path = public, extensions;

CREATE OR REPLACE FUNCTION camera_recording_day_counts(
  p_site_id UUID,
  p_camera_id UUID DEFAULT NULL,
  p_from DATE DEFAULT NULL,
  p_to DATE DEFAULT NULL
)
RETURNS TABLE (day DATE, recordings BIGINT)
LANGUAGE sql STABLE AS $$
  SELECT
    (r.started_at AT TIME ZONE s.timezone)::date AS day,
    count(*) AS recordings
  FROM camera_recordings r
  JOIN cameras c ON c.id = r.camera_id
  JOIN sites s ON s.id = c.site_id
  WHERE c.site_id = p_site_id
    AND (p_camera_id IS NULL OR r.camera_id = p_camera_id)
    AND (p_from IS NULL OR (r.started_at AT TIME ZONE s.timezone)::date >= p_from)
    AND (p_to IS NULL OR (r.started_at AT TIME ZONE s.timezone)::date <= p_to)
  GROUP BY 1
  ORDER BY 1 DESC;
$$;

COMMENT ON FUNCTION camera_recording_day_counts(UUID, UUID, DATE, DATE) IS
  'Počty záznamů po dnech v pásmu lokality, nejnovější první. Bez '
  'SECURITY DEFINER — RLS volajícího platí, takže na cizí lokalitu '
  'vrátí prázdno.';

REVOKE ALL ON FUNCTION camera_recording_day_counts(UUID, UUID, DATE, DATE) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION camera_recording_day_counts(UUID, UUID, DATE, DATE)
  TO authenticated;
