-- ═══════════════════════════════════════════════════════════════════
-- Klient jako profil: firma a logo.
--
-- Portál dosud znal jen uživatele s rolí a granty na lokality. Pro
-- předání klientovi chybí to, čím se klient představuje — název firmy
-- a logo, které uvidí ve svém portálu.
--
-- Logo se ukládá do úložiště, v databázi je jen CESTA k souboru, ne
-- URL. URL se skládá až při vykreslení; kdyby se uložila celá, po
-- změně domény projektu by všechna loga zmizela.
--
-- Idempotentní: bezpečné spustit víckrát.
-- ═══════════════════════════════════════════════════════════════════

SET search_path = public, extensions;

ALTER TABLE profiles ADD COLUMN IF NOT EXISTS company_name TEXT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS logo_path TEXT;

COMMENT ON COLUMN profiles.company_name IS
  'Firma, za kterou klient portál používá. Zobrazuje se mu v liště.';
COMMENT ON COLUMN profiles.logo_path IS
  'Cesta k logu v úložišti (bucket loga), ne URL. NULL = bez loga.';

-- Cesta, ne URL. Kdyby sem někdo uložil celou adresu, vykreslení by
-- složilo nesmysl — a chyba by se projevila až u klienta.
ALTER TABLE profiles DROP CONSTRAINT IF EXISTS profiles_logo_path_is_path;
ALTER TABLE profiles ADD CONSTRAINT profiles_logo_path_is_path CHECK (
  logo_path IS NULL OR logo_path !~ '^[a-z]+://'
);

ALTER TABLE profiles DROP CONSTRAINT IF EXISTS profiles_company_name_length;
ALTER TABLE profiles ADD CONSTRAINT profiles_company_name_length CHECK (
  company_name IS NULL OR char_length(company_name) BETWEEN 1 AND 200
);
