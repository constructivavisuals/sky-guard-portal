-- ═══════════════════════════════════════════════════════════════════
-- Zápis ohlášení z portálu.
--
-- Migrace 20260906120000 nechala announced_arrivals bez zápisové
-- politiky schválně: zakládal je jen řidič přes svou stránku, tedy pod
-- service_role, kterému RLS nepřekáží.
--
-- Teď je má zakládat a rušit i administrátor z přehledu ohlášení —
-- řidič se dovolá telefonem a nikdo ho nebude nutit klikat do odkazu.
-- Politika je proto přímočará: admin, a jen na lokalitu, na kterou
-- vidí. Druhá podmínka není zbytečná ani u admina: až site_is_visible()
-- přestane být „admin vidí vše“, změní se rozsah tady zároveň
-- s ostatními.
--
-- Klient ani operátor zápis nedostávají. Ohlášení je závazek dopravce
-- vůči areálu; kdo ho smí vytvořit, rozhoduje o tom, na koho nevyletí
-- dron.
--
-- Idempotentní: bezpečné spustit víckrát.
-- ═══════════════════════════════════════════════════════════════════

SET search_path = public, extensions;

DROP POLICY IF EXISTS "write_announced_arrivals" ON announced_arrivals;
CREATE POLICY "write_announced_arrivals" ON announced_arrivals
  FOR ALL TO authenticated
  USING (is_admin() AND site_is_visible(site_id))
  WITH CHECK (is_admin() AND site_is_visible(site_id));

-- SELECT zůstává širší (site_is_visible bez is_admin) z migrace
-- 20260906120000; tahle politika ho nezužuje, protože se politiky
-- sčítají.
GRANT INSERT, UPDATE, DELETE ON announced_arrivals TO authenticated;
