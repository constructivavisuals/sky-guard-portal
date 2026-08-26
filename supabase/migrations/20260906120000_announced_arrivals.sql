-- ═══════════════════════════════════════════════════════════════════
-- Avizované příjezdy.
--
-- Dopravce dostane odkaz s tokenem a na samostatné stránce mimo portál
-- ohlásí, kdy a s jakou značkou přijede. Ingest to při čtení SPZ najde
-- a podle toho se rozhodne, jestli má dron vůbec vzlétnout.
--
-- Je to v podstatě denní allow seznam, který si plní někdo zvenčí:
-- known_plates drží trvalá povolení, tohle jednorázová.
--
-- ═══ Token je uložený v čitelné podobě ═════════════════════════════
-- Vědomé rozhodnutí, ne opomenutí. Hašovaný token by šlo ukázat jen
-- jednou při založení, a dopravce, který odkaz ztratí, je běžná věc —
-- administrátor by mu musel pokaždé zakládat nového. Riziko je přitom
-- omezené: token neotevírá portál, jen dovolí ohlásit příjezd na JEDNU
-- lokalitu, a kdo se dostane k databázi, může si ohlášení stejně
-- vložit rovnou. Čtení tabulky proto RLS pouští jen adminovi.
-- ═══════════════════════════════════════════════════════════════════
--
-- Idempotentní: bezpečné spustit víckrát.
-- ═══════════════════════════════════════════════════════════════════

SET search_path = public, extensions;

-- ── Dopravci ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS carriers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id UUID NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  -- Telefon nebo e-mail; volná forma schválně, ať se dá zapsat cokoli,
  -- co má dispečink po ruce.
  contact TEXT,
  -- 32 náhodných bajtů v base64url. Unikátní: podle něj se dopravce
  -- dohledává, dvakrát tentýž by znamenal dva dopravce na jeden odkaz.
  token TEXT NOT NULL UNIQUE CHECK (length(token) >= 32),
  -- Datum, po kterém odkaz přestane platit. NULL = bez omezení.
  valid_until DATE,
  -- Vypnutí místo mazání: ohlášení, která dopravce vytvořil, jsou
  -- součástí historie vjezdů a nesmí zmizet.
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON COLUMN carriers.token IS
  'Tajemství v odkazu /prijezd/<token>. Kdo ho má, smí ohlašovat '
  'příjezdy na tuhle lokalitu — nic víc.';

CREATE INDEX IF NOT EXISTS idx_carriers_site ON carriers(site_id);

-- ── Ohlášení ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS announced_arrivals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  carrier_id UUID NOT NULL REFERENCES carriers(id) ON DELETE CASCADE,
  -- Lokalita přímo, ne přes dopravce: ingest ji potřebuje v dotazu
  -- a průchod vazbou by znamenal poddotaz v každém vyhodnocení.
  site_id UUID NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  -- Ukládá se tak, jak ji řidič napsal. Porovnává se přes
  -- plate_normalize(), stejně jako known_plates.
  plate TEXT NOT NULL CHECK (length(trim(plate)) > 0),
  arrival_date DATE NOT NULL,
  note TEXT,
  -- Řidič výslovně říká, že může dorazit i v době střežení. Výchozí
  -- FALSE: kdo nic nezaškrtl, ohlásil běžný denní příjezd a noční
  -- návštěva je pořád důvod poslat dron.
  night_ok BOOLEAN NOT NULL DEFAULT FALSE,
  -- Zrušení je razítko, ne DELETE: ohlášení, na které se ingest odvolal
  -- při rozhodování o zásahu, musí zůstat dohledatelné.
  cancelled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON COLUMN announced_arrivals.night_ok IS
  'Řidič ví, že přijede i v době střežení. Bez toho se ohlášení '
  'v ostrém režimu neuplatní a dron vzlétne — ohlásit denní rozvoz '
  'nesmí být zadní vrátka na noc.';

-- Dotaz ingestu: „ohlášení na tuhle lokalitu, na dnešek, s touhle
-- normalizovanou značkou, nezrušené“. Funkční index, aby se
-- plate_normalize() nepočítal přes celou tabulku.
CREATE INDEX IF NOT EXISTS idx_announced_arrivals_lookup
  ON announced_arrivals(site_id, arrival_date, plate_normalize(plate))
  WHERE cancelled_at IS NULL;

-- Seznam pro řidiče: jeho ohlášení odteď dál.
CREATE INDEX IF NOT EXISTS idx_announced_arrivals_carrier
  ON announced_arrivals(carrier_id, arrival_date DESC);

-- Tentýž dopravce nemá proč hlásit tutéž značku na tentýž den dvakrát.
-- Zrušená ohlášení se nepočítají, aby šlo ohlásit znovu.
CREATE UNIQUE INDEX IF NOT EXISTS idx_announced_arrivals_unique
  ON announced_arrivals(carrier_id, arrival_date, plate_normalize(plate))
  WHERE cancelled_at IS NULL;

-- ── Vazba na vjezd ───────────────────────────────────────────────

ALTER TABLE vehicle_passages
  ADD COLUMN IF NOT EXISTS announced_arrival_id UUID
  REFERENCES announced_arrivals(id) ON DELETE SET NULL;

COMMENT ON COLUMN vehicle_passages.announced_arrival_id IS
  'Ohlášení, kterému vjezd odpovídal. NULL = neohlášený, nebo se '
  'značka nepřečetla natolik spolehlivě, aby se dala párovat.';

-- ── Zásah potlačený ohlášením ────────────────────────────────────

ALTER TYPE dispatch_outcome ADD VALUE IF NOT EXISTS 'suppressed_announced';

-- ── RLS ──────────────────────────────────────────────────────────
--
-- Dopravce a jeho token vidí jen admin: je to přístupový údaj, ne
-- provozní data. Stránka řidiče čte pod service_role, kterému RLS
-- nepřekáží, a token si ověřuje sama.

ALTER TABLE carriers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "read_carriers" ON carriers;
CREATE POLICY "read_carriers" ON carriers
  FOR SELECT TO authenticated
  USING (is_admin());

DROP POLICY IF EXISTS "write_carriers" ON carriers;
CREATE POLICY "write_carriers" ON carriers
  FOR ALL TO authenticated
  USING (is_admin())
  WITH CHECK (is_admin());

-- Ohlášení naopak vidí každý, kdo vidí lokalitu: je to provozní
-- informace k vjezdům, kterou operátor potřebuje.
ALTER TABLE announced_arrivals ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "read_announced_arrivals" ON announced_arrivals;
CREATE POLICY "read_announced_arrivals" ON announced_arrivals
  FOR SELECT TO authenticated
  USING (site_is_visible(site_id));

-- Zakládá a ruší je řidič přes svou stránku, tedy pod service_role.
-- Z portálu do nich nikdo nesahá; admin může nanejvýš vypnout dopravce.
DROP POLICY IF EXISTS "write_announced_arrivals" ON announced_arrivals;

-- Bez GRANTu by RLS nedostala slovo — dotaz by spadl dřív, na právech.
GRANT SELECT, INSERT, UPDATE, DELETE ON carriers TO authenticated;
GRANT SELECT ON announced_arrivals TO authenticated;
GRANT ALL ON carriers TO service_role;
GRANT ALL ON announced_arrivals TO service_role;

-- ── Razítko změny dopravce ───────────────────────────────────────

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'touch_updated_at') THEN
    EXECUTE 'DROP TRIGGER IF EXISTS trg_carriers_updated ON carriers';
    EXECUTE 'CREATE TRIGGER trg_carriers_updated
               BEFORE UPDATE ON carriers
               FOR EACH ROW EXECUTE FUNCTION touch_updated_at()';
  ELSE
    RAISE NOTICE 'Funkce touch_updated_at() neexistuje — trigger se nezakládá.';
  END IF;
END $$;
