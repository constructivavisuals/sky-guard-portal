-- ═══════════════════════════════════════════════════════════════════
-- Výška návratu domů podle lokality.
--
-- V kódu byla natvrdo 100 m. Projekt ve FlightHubu má ale vlastní
-- strop — u nás 60 m — a mise, která ho překročí, se NESPUSTÍ. Chyba
-- přitom nezní jako výška: vypadá to, jako by dron nereagoval, a hledá
-- se to na úplně špatném místě. Přesně tohle stálo za nočními
-- selháními, která se sváděla na uspaný dron.
--
-- Strop je nastavení projektu, a projektů může být víc než jeden —
-- proto sloupec na lokalitě, ne konstanta.
--
-- ═══ Proč zrovna 60 ════════════════════════════════════════════════
-- Odpovídá stropu projektu, se kterým se dnes létá. Není to bezpečná
-- hodnota „obecně“: kdo má v projektu jiný limit, musí ji přenastavit,
-- jinak mu buď mise nepoletí (výš než strop), nebo poletí zbytečně
-- nízko.
--
-- Rozsah 20–500 m je jen pojistka proti překlepu. Dolní hranice je
-- výš než stromy a stožáry, horní je nad čímkoli, co by dávalo smysl
-- u areálu.
--
-- Idempotentní: bezpečné spustit víckrát.
-- ═══════════════════════════════════════════════════════════════════

SET search_path = public, extensions;

ALTER TABLE sites
  ADD COLUMN IF NOT EXISTS rth_altitude INTEGER NOT NULL DEFAULT 60;

COMMENT ON COLUMN sites.rth_altitude IS
  'Výška návratu domů v metrech, posílaná do plánované úlohy. Musí se '
  'vejít do stropu projektu ve FlightHubu — nad ním se mise nespustí '
  'a chyba nezní jako výška.';

ALTER TABLE sites DROP CONSTRAINT IF EXISTS sites_rth_altitude_sane;
ALTER TABLE sites ADD CONSTRAINT sites_rth_altitude_sane CHECK (
  rth_altitude BETWEEN 20 AND 500
);
