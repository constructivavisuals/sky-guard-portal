-- ═══════════════════════════════════════════════════════════════════
-- Přístup k lokalitám per uživatel.
--
-- Do teď platilo, že kdo má profil, vidí všechny lokality — což bylo
-- v pořádku, dokud byl portál jednonájemní. site_grants to mění na
-- explicitní seznam: admin vidí vše, ostatní jen to, na co mají řádek.
--
-- Politiky se nemění. Všechny čtecí politiky z migrace
-- 20260824120000 vedou přes site_is_visible() — buď přímo (sites,
-- zones, cameras, detections, dispatches), nebo přes flight_is_visible()
-- (flights, media). Přepsáním jedné funkce se rozsah zúží všude naráz;
-- právě kvůli tomu je ta nepřímost v politikách od začátku.
--
-- Mimo site_is_visible zůstávají schválně:
--   profiles   — vlastní řádek nebo admin, není vázaný na lokalitu,
--   audit_log  — jen admin,
--   zápisy     — is_admin() / site_is_manager(), tedy admin.
--
-- Idempotentní: bezpečné spustit víckrát.
-- ═══════════════════════════════════════════════════════════════════

SET search_path = public, extensions;

-- ── site_grants — kdo na kterou lokalitu vidí ────────────────────

CREATE TABLE IF NOT EXISTS site_grants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  site_id UUID NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Dvojice je unikátní: dva stejné granty by nic nepřidaly a jen
-- komplikovaly odebrání přístupu.
CREATE UNIQUE INDEX IF NOT EXISTS idx_site_grants_unique
  ON site_grants(profile_id, site_id);
-- Opačný směr: „kdo má přístup na tuhle lokalitu“.
CREATE INDEX IF NOT EXISTS idx_site_grants_site ON site_grants(site_id);

-- Udělení a odebrání přístupu je bezpečnostní událost, patří do logu.
DROP TRIGGER IF EXISTS site_grants_audit ON site_grants;
CREATE TRIGGER site_grants_audit
  AFTER INSERT OR UPDATE OR DELETE ON site_grants
  FOR EACH ROW EXECUTE FUNCTION audit_row();

-- ── Přepsaná viditelnost lokality ────────────────────────────────
-- SECURITY DEFINER je tu nutnost, ne pohodlí: funkce čte site_grants,
-- na které samotné leží RLS. Bez DEFINER by se politika na site_grants
-- vyhodnocovala uvnitř funkce, kterou volá politika na sites — a to
-- se buď zacyklí, nebo (u SELECT policy) vrátí prázdno a nikdo by
-- neviděl nic.

CREATE OR REPLACE FUNCTION site_is_visible(p_site_id UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT p_site_id IS NOT NULL AND (
    is_admin()
    OR EXISTS (
      SELECT 1 FROM site_grants g
      WHERE g.site_id = p_site_id
        AND g.profile_id = auth.uid()
    )
  );
$$;

-- ── RLS nad site_grants ──────────────────────────────────────────

ALTER TABLE site_grants ENABLE ROW LEVEL SECURITY;

-- Uživatel si smí ověřit, kam ho pustili; cizí granty nevidí.
DROP POLICY IF EXISTS "read_site_grants" ON site_grants;
CREATE POLICY "read_site_grants" ON site_grants
  FOR SELECT TO authenticated
  USING (profile_id = auth.uid() OR is_admin());

-- Udělovat a odebírat přístup smí jen admin — jinak by si držitel
-- grantu mohl přidat další lokality.
DROP POLICY IF EXISTS "write_site_grants" ON site_grants;
CREATE POLICY "write_site_grants" ON site_grants
  FOR ALL TO authenticated
  USING (is_admin())
  WITH CHECK (is_admin());

-- Supabase přiděluje práva novým tabulkám přes ALTER DEFAULT
-- PRIVILEGES, ale explicitně je to nezávislé na tom nastavení.
-- Bez GRANTu by RLS nedostala slovo — dotaz by spadl dřív, na právech.
GRANT SELECT, INSERT, UPDATE, DELETE ON site_grants TO authenticated;
GRANT ALL ON site_grants TO service_role;
