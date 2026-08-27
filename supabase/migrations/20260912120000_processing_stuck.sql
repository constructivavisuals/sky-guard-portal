-- ═══════════════════════════════════════════════════════════════════
-- Notifikace o nedokončeném zpracování.
--
-- Zásah i čtení značky běží v `after()`, tedy až po odeslání odpovědi
-- kameře. Když Vercel instanci ukončí dřív, práce se ztratí — fronta
-- ani opakování tam nejsou. Detekce se zapíše, zásah nevznikne, vjezd
-- zůstane bez značky, a vypadá to úplně stejně jako „kamera nemá zónu“
-- nebo „značku se nepovedlo přečíst“.
--
-- Varovací cron to teď hledá a hlásí jako `processing_stuck`. Nový
-- druh notifikace potřebuje vlastní sloupec v předvolbách — jinak by
-- se řídil sloupcem, který znamená něco jiného.
--
-- DEFAULT TRUE: je to závada běhu, ne provozní stav. Kdo o ni nestojí,
-- vypne si ji sám.
--
-- Idempotentní: bezpečné spustit víckrát.
-- ═══════════════════════════════════════════════════════════════════

SET search_path = public, extensions;

ALTER TABLE notification_prefs
  ADD COLUMN IF NOT EXISTS on_processing_stuck BOOLEAN NOT NULL DEFAULT TRUE;

COMMENT ON COLUMN notification_prefs.on_processing_stuck IS
  'Detekce bez zásahu nebo vjezd bez přečtené značky — práce v after(), '
  'která nedoběhla. Závada běhu, ne stav areálu.';
