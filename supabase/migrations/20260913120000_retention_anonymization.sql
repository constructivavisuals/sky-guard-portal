-- ═══════════════════════════════════════════════════════════════════
-- Lhůty na data, ne jen na soubory.
--
-- Retenční job dosud mazal výhradně soubory z úložiště. Řádky zůstávaly
-- napořád — a v nich značky vozidel, adresy odesílatelů a jména
-- z evidence známých značek. SPZ je podle EDPB osobní údaj; kdo ho drží
-- bez lhůty, drží ho neoprávněně.
--
-- ═══ Anonymizace, ne mazání ════════════════════════════════════════
-- Řádek zůstane, zmizí z něj jen to, čím se dá identifikovat osoba.
-- Počty vjezdů v měsíčním reportu tak platí i po lhůtě — a platí i
-- rozpad na známé a neznámé, protože `list_match` se zachovává.
--
-- Právě kvůli tomu se musí uvolnit podmínka vehicle_passages_match_
-- needs_plate: shoda se seznamem měla dosud smysl jen u řádku se
-- značkou, což po anonymizaci neplatí. Nová podoba to dovolí jen
-- u anonymizovaného řádku, takže se nedá zapsat shoda bez značky
-- „jen tak“.
--
-- Hashovat značku by nestačilo: SPZ je krátký a vyčíslitelný řetězec,
-- takže z otisku jde původní hodnota dopočítat hrubou silou. To by byla
-- pseudonymizace vydávaná za anonymizaci.
--
-- Idempotentní: bezpečné spustit víckrát.
-- ═══════════════════════════════════════════════════════════════════

SET search_path = public, extensions;

-- ── Vjezdy ───────────────────────────────────────────────────────

ALTER TABLE vehicle_passages
  ADD COLUMN IF NOT EXISTS anonymized_at TIMESTAMPTZ;

COMMENT ON COLUMN vehicle_passages.anonymized_at IS
  'Kdy z řádku zmizela značka a jméno ze seznamu. Řádek zůstává kvůli '
  'počtům v reportu; identifikovat podle něj vozidlo už nejde.';

CREATE INDEX IF NOT EXISTS idx_vehicle_passages_to_anonymize
  ON vehicle_passages(site_id, passed_at)
  WHERE anonymized_at IS NULL;

ALTER TABLE vehicle_passages DROP CONSTRAINT IF EXISTS vehicle_passages_match_needs_plate;
ALTER TABLE vehicle_passages ADD CONSTRAINT vehicle_passages_match_needs_plate CHECK (
  list_match IS NULL OR plate IS NOT NULL OR anonymized_at IS NOT NULL
);

-- Zdroj značky u anonymizovaného řádku taky nevadí — říká, kdo ji
-- kdysi přečetl, ne jaká byla.
ALTER TABLE vehicle_passages DROP CONSTRAINT IF EXISTS vehicle_passages_source_needs_plate;
ALTER TABLE vehicle_passages ADD CONSTRAINT vehicle_passages_source_needs_plate CHECK (
  plate_source IS NULL OR plate IS NOT NULL OR anonymized_at IS NOT NULL
);

-- ── Ohlášené příjezdy ────────────────────────────────────────────
--
-- Táž značka, jen z druhé strany: řidič ji sám nahlásil dopředu.
-- Ohlášení se navíc odvolává v decision_reason zásahu, takže řádek
-- musí zůstat i po lhůtě.

ALTER TABLE announced_arrivals
  ADD COLUMN IF NOT EXISTS anonymized_at TIMESTAMPTZ;

COMMENT ON COLUMN announced_arrivals.anonymized_at IS
  'Kdy z ohlášení zmizela značka a poznámka. Řádek zůstává, protože se '
  'na něj odvolává decision_reason zásahů.';

-- Prázdná značka je po anonymizaci v pořádku; jinak ne.
ALTER TABLE announced_arrivals DROP CONSTRAINT IF EXISTS announced_arrivals_plate_check;
ALTER TABLE announced_arrivals ALTER COLUMN plate DROP NOT NULL;
ALTER TABLE announced_arrivals DROP CONSTRAINT IF EXISTS announced_arrivals_plate_present;
ALTER TABLE announced_arrivals ADD CONSTRAINT announced_arrivals_plate_present CHECK (
  (plate IS NOT NULL AND length(trim(plate)) > 0) OR anonymized_at IS NOT NULL
);

-- ── Vědra rate limitu ────────────────────────────────────────────
--
-- Klíč vědra je `ip:<adresa>` nebo `cam:<sériové číslo>`. Je to tedy
-- tabulka IP adres, která rostla donekonečna a nikdy se neuklízela —
-- a IP adresa je osobní údaj. Uklízí ji teď retenční job; index je na
-- to, aby mazání nemuselo projít celou tabulku.

CREATE INDEX IF NOT EXISTS idx_ingest_rate_limits_updated
  ON ingest_rate_limits(updated_at);

COMMENT ON TABLE ingest_rate_limits IS
  'Vědra s žetony pro omezení počtu požadavků. Klíč nese IP adresu '
  'nebo sériové číslo kamery, takže se vědra po hodině nečinnosti '
  'mažou — retenční job, viz lib/retention/rules.ts.';
