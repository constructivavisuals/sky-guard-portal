-- ═══════════════════════════════════════════════════════════════════
-- Push notifikace.
--
-- Tři tabulky:
--   push_subscriptions  kam posílat (jedno zařízení = jeden řádek)
--   notification_prefs  co komu posílat, po lokalitách
--   notification_log    kdy naposledy odešlo opakující se varování
--
-- ═══ Proč se tady MAZAT smí ════════════════════════════════════════
-- Jinde v portálu platí, že důkazy se nemažou. Tohle důkazy nejsou:
-- odběr je adresa zařízení, které už nemusí existovat, a push služba
-- na mrtvý odběr odpovídá 410. Neposbírané odběry se hromadí a každý
-- z nich stojí jedno volání po síti při každé notifikaci. Mazat se
-- proto musí — jak z UI („odhlásit zařízení“), tak automaticky.
-- ═══════════════════════════════════════════════════════════════════
--
-- Idempotentní: bezpečné spustit víckrát.
-- ═══════════════════════════════════════════════════════════════════

SET search_path = public, extensions;

-- ── Odběry ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  -- Adresa u push služby (Google, Mozilla, Apple). Unikátní: tentýž
  -- prohlížeč vrací tentýž endpoint, takže opakované povolení má
  -- odběr přepsat, ne založit druhý.
  endpoint TEXT NOT NULL UNIQUE,
  -- Veřejný klíč prohlížeče a autentizační tajemství. Bez obojího se
  -- obsah nedá zašifrovat, proto NOT NULL.
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  -- Ať uživatel v seznamu zařízení pozná, které je které.
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Kdy na něj naposledy něco úspěšně odešlo. NULL = zatím nikdy.
  last_used_at TIMESTAMPTZ
);

COMMENT ON TABLE push_subscriptions IS
  'Zařízení, kterým se posílají push notifikace. Řádek maže uživatel '
  'z nastavení, nebo odesílání samo, když push služba vrátí 404/410.';

CREATE INDEX IF NOT EXISTS idx_push_subscriptions_profile
  ON push_subscriptions(profile_id);

-- ── Předvolby ────────────────────────────────────────────────────
--
-- Po lokalitách, ne globálně: kdo hlídá dva areály, nemusí chtít
-- hlášení z obou stejně.
--
-- Výchozí hodnoty jsou schválně „zapnuto“ u všeho kromě potlačených
-- zásahů. Kdo si notifikace povolil, chce je dostávat; potlačený zásah
-- je ale běžný provozní stav (mimo režim, cooldown) a v noci by to
-- byla řada zbytečných probuzení.

CREATE TABLE IF NOT EXISTS notification_prefs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  site_id UUID NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  on_dispatch_sent BOOLEAN NOT NULL DEFAULT TRUE,
  on_dispatch_suppressed BOOLEAN NOT NULL DEFAULT FALSE,
  on_threat_confirmed BOOLEAN NOT NULL DEFAULT TRUE,
  on_camera_silent BOOLEAN NOT NULL DEFAULT TRUE,
  on_dock_problem BOOLEAN NOT NULL DEFAULT TRUE,
  -- Tiché hodiny v místním čase lokality. Obě NULL = neruší se nikdy.
  -- quiet_from > quiet_to znamená okno přes půlnoc, stejná úmluva jako
  -- u armed_from/armed_to.
  quiet_from TIME,
  quiet_to TIME,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Buď obojí, nebo nic. Jedna hranice sama okno neurčuje.
  CONSTRAINT quiet_hours_complete CHECK (
    (quiet_from IS NULL) = (quiet_to IS NULL)
  ),
  -- Prázdné okno by se dalo číst jako „nikdy“ i „pořád“.
  CONSTRAINT quiet_hours_not_empty CHECK (
    quiet_from IS NULL OR quiet_from <> quiet_to
  )
);

COMMENT ON COLUMN notification_prefs.quiet_from IS
  'Tiché hodiny v časovém pásmu lokality. Potvrzený nález je ignoruje '
  'schválně — na pozemku někdo je a to se dozvědět musí.';

-- Jedna sada předvoleb na dvojici uživatel–lokalita.
CREATE UNIQUE INDEX IF NOT EXISTS idx_notification_prefs_profile_site
  ON notification_prefs(profile_id, site_id);

-- ── Kdy naposledy odešlo opakující se varování ───────────────────
--
-- Nad rámec zadání, a schválně. Mlčící kamera mlčí dál i za čtvrt
-- hodiny, takže bez tohohle by cron poslal totéž varování při každém
-- běhu — což je nejrychlejší cesta k tomu, aby si uživatel notifikace
-- vypnul úplně. Zásahy a nálezy sem nepatří, ty jsou jednorázové
-- události.

CREATE TABLE IF NOT EXISTS notification_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id UUID NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  -- Druh varování ('camera_silent', 'dock_problem').
  kind TEXT NOT NULL,
  -- Čeho se týká: id kamery, nebo 'dock'. Dvě mlčící kamery se hlásí
  -- zvlášť, jinak by druhá zapadla pod odstupem té první.
  target TEXT NOT NULL,
  last_sent_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_notification_log_event
  ON notification_log(site_id, kind, target);

-- ── RLS ──────────────────────────────────────────────────────────
--
-- Odběry i předvolby jsou přísně osobní: ani admin nemá důvod vidět,
-- z jakého zařízení kdo chodí. Odesílání běží pod service_role, které
-- RLS obchází.

ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "own_push_subscriptions" ON push_subscriptions;
CREATE POLICY "own_push_subscriptions" ON push_subscriptions
  FOR ALL TO authenticated
  USING (profile_id = auth.uid())
  WITH CHECK (profile_id = auth.uid());

ALTER TABLE notification_prefs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "own_notification_prefs" ON notification_prefs;
CREATE POLICY "own_notification_prefs" ON notification_prefs
  FOR ALL TO authenticated
  -- Vlastní řádek A jen k lokalitě, na kterou uživatel vidí. Bez té
  -- druhé podmínky by šlo z existence řádku odvodit, které lokality
  -- v portálu vůbec jsou.
  USING (profile_id = auth.uid() AND site_is_visible(site_id))
  WITH CHECK (profile_id = auth.uid() AND site_is_visible(site_id));

-- Log je čistě serverová evidence odstupů. Přihlášeným uživatelům
-- k ničemu není, takže se jim nezpřístupňuje vůbec — RLS bez jediné
-- politiky nepustí nikoho.
ALTER TABLE notification_log ENABLE ROW LEVEL SECURITY;

-- Bez GRANTu by RLS nedostala slovo — dotaz by spadl dřív, na právech.
GRANT SELECT, INSERT, UPDATE, DELETE ON push_subscriptions TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON notification_prefs TO authenticated;
GRANT ALL ON push_subscriptions TO service_role;
GRANT ALL ON notification_prefs TO service_role;
GRANT ALL ON notification_log TO service_role;

-- ── Razítko změny předvoleb ──────────────────────────────────────

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'touch_updated_at') THEN
    EXECUTE 'DROP TRIGGER IF EXISTS trg_notification_prefs_updated ON notification_prefs';
    EXECUTE 'CREATE TRIGGER trg_notification_prefs_updated
               BEFORE UPDATE ON notification_prefs
               FOR EACH ROW EXECUTE FUNCTION touch_updated_at()';
  ELSE
    RAISE NOTICE 'Funkce touch_updated_at() neexistuje — trigger se nezakládá.';
  END IF;
END $$;
