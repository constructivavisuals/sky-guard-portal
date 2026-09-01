-- Kamery v provozu jako `online`.
--
-- ═══ Proč to bylo špatně ═══════════════════════════════════════════
-- `cameras.status` má DEFAULT 'offline' (migrace 20260824120000)
-- a nastavuje ho jedině ruční formulář v Areálech. Kamera založená
-- kýmkoli, kdo to políčko nepřepnul, tedy zůstala navždy vedená jako
-- offline — bez ohledu na to, jestli funguje.
--
-- V Areálech se to ukazuje jako červený odznak „Offline" u kamer,
-- které normálně posílají obraz i detekce.
--
-- ═══ Co tahle migrace dělá ═════════════════════════════════════════
-- Jednorázově srovná stav u kamer, které nikdo vyřadil ani neposlal
-- do údržby. Nic víc: nezavádí automatiku a nemění výchozí hodnotu.
--
-- ═══ Co NEŘEŠÍ ═════════════════════════════════════════════════════
-- Že se sloupec dál nebude udržovat sám. Až kamera vypadne, zůstane
-- vedená jako online, dokud to někdo ručně nepřepne. Skutečnou živost
-- umí říct jedině relay (`sky-events` drží na každé kameře spojení),
-- ale do portálu ji zatím neposílá.
--
-- Proto se stav kamery NEUKAZUJE v seznamu /kamery, kam se dívá
-- klient. Zůstává jen v Areálech, kde ho admin nastavuje a kde je
-- tedy jasné, že je to údaj z evidence, ne měření.

UPDATE cameras
   SET status = 'online'
 WHERE status = 'offline';

-- Ověření po nasazení:
--
--   SELECT status, count(*) FROM cameras GROUP BY status;
--
-- Očekává se, že 'offline' zmizí a přibudou ho k 'online';
-- 'maintenance' a 'decommissioned' zůstanou nedotčené.
