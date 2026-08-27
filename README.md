# Sky Guard Portal

Portál k dronové ochraně perimetru. Next.js 16 (App Router), Supabase,
DJI FlightHub 2.

## Spuštění

```bash
npm install
cp .env.local.example .env.local   # a vyplnit
npm run dev
```

Kontroly před pushem:

```bash
npm run build      # musí běžet první — generuje typy pro PageProps
npm run typecheck
npm run lint
npm test
```

`npm run typecheck` samotný po čerstvém klonu spadne na chybějících
typech rout. Nejdřív `build`.

## Migrace

Migrace se pouštějí ručně přes SQL Editor v Supabase, ne přes CLI.
Který soubor je na řadě, řekne:

```bash
npm run migrace                 # zkopíruje SQL do schránky
npm run migrace -- --hotovo     # po spuštění potvrdí
```

Evidenci nasazených migrací drží `supabase/nasazene-migrace.txt`.
Co v něm není, na produkci neběželo.

Schéma a RLS jde ověřit lokálně proti jednorázovému PostgreSQL
(vyžaduje `postgresql@17` a `postgis` z Homebrew):

```bash
supabase/tests/run-local.sh
```

## Loga klientů

Bucket `loga` je jediný veřejný — logo se ukazuje v hlavičce portálu
a vkládá se do PDF reportu. Vědomé rozhodnutí a zůstává.

**SVG se ale nepřijímá** (migrace 20260911180000). Je to spustitelný
dokument, ne obrázek: nese `<script>`, umí sáhnout na cizí zdroje
a otevřít se dá přímo, mimo portál, na doméně Supabase — kde adresa
platí navždy a bez ověření. Logo v PNG nebo WebP vypadá stejně.

Případná už nahraná SVG migrace nemaže (klientovi by se rozbila
hlavička), jen je vypíše, aby šla vyměnit ručně.

## IP odesílatele

`x-forwarded-for` si smí připsat kdokoli po cestě, včetně toho, kdo
požadavek posílá — **první** položka je tedy hodnota, kterou si vybral
odesílatel sám. Dala by se jí obejít vědra rate limitu, nafouknout
jejich tabulka a hlavně podvrhnout `detections.source_ip`, což je údaj,
který detail detekce ukazuje operátorovi jako doklad o původu.

`clientIp()` proto bere v tomhle pořadí:

1. `x-vercel-forwarded-for` — nastavuje edge Vercelu, odesílatel ji
   přepsat nemůže,
2. `x-real-ip` — totéž u běžných reverzních proxy,
3. **poslední** položku `x-forwarded-for` — tu připsala proxy nejblíž
   k nám.

## Práva role anon

Supabase dává rolím `anon` a `authenticated` plná práva na všechny
tabulky ve schématu `public` — jednou plošně a znovu přes
`ALTER DEFAULT PRIVILEGES` pro každou nově založenou. Úzké `GRANT`y
v migracích proto nic neomezují: širší právo už tam bylo.

Dokud je na tabulce RLS a `anon` nemá politiku, nevadí to. Vadí to ve
chvíli, kdy vznikne tabulka, u níž se na `ENABLE ROW LEVEL SECURITY`
zapomene — ta je okamžitě čitelná **i zapisovatelná** komukoli, kdo zná
veřejný anon klíč. A ten je v každé stránce portálu.

Migrace 20260911120000 proto `anon` práva na tabulky bere a mění
i výchozí práva pro tabulky příští. Přihlášeným (`authenticated`) se
nesahá na nic: tam RLS pracuje a zúžení práv by rozbilo provoz.

Hlídá to `supabase/tests/anon_and_cron_read.sql` — včetně toho, že nově
založená tabulka `anon` nic nedá, a že žádná tabulka nezůstala bez RLS.

## Ingest klíče kamer

Každá kamera se podepisuje vlastním klíčem. Klíč se nikde neukládá,
odvozuje se z `INGEST_SECRET` a sériového čísla; v databázi je jen jeho
SHA-256 otisk, aby server poznal, že kamera už nejede na společném
tajemství.

```bash
npm run kamera-klic CAM-VV-01        # vypíše klíč a SQL s otiskem
npm run kamera-klic CAM-VV-01 2      # rotace jedné kamery
```

Klíč se nastaví v kameře, vypsané SQL se pustí v SQL Editoru. Dokud
kamera otisk nemá, podepisuje se společným `INGEST_SECRET` a server to
při každé detekci zaloguje — podle toho se pozná, na které kamery se
zapomnělo.

## Co kamera umí

`cameras.detects_person`, `detects_vehicle` a `reads_plate` (migrace
20260910120000). Tři booleany, ne `text[]`: dotazy míří vždycky na jednu
schopnost („kdo čte značky“), ne na množinu, a boolean má NOT NULL
DEFAULT, takže v datech nevzniká „nevíme“.

Výchozí stav odpovídá většině: **perimetr umí osobu a nic víc**, kamera
na bránu se zaškrtne ručně. CHECK v databázi navíc drží, že
`reads_plate` bez `detects_vehicle` nejde — vjezd JE detekce vozidla
a taková kamera by si každým průjezdem sama hlásila neočekávanou
událost.

Portál z toho vyvozuje tři věci:

* **Neočekávaná detekce.** Kamera, která hlásí třídu, co podle nastavení
  neumí, se nezamítá — detekce se zapíše a zásah se rozhoduje jako
  vždycky. Přijít o záznam, že někdo byl v areálu, je horší než mít
  v evidenci řádek navíc, a potlačený zásah by byl tiché selhání toho
  druhu, který tenhle portál opravuje dokola. Událost se jen označí:
  v logu a v `detections.raw` pod vyhrazeným klíčem `portal`, aby po ní
  stopa zbyla i za měsíc. Detail detekce to ukáže oranžovým blokem.
* **Značka od kamery.** Kamera s `reads_plate` posílá `plate`
  (a nepovinně `plate_confidence`) přímo v těle požadavku na
  `/api/ingest/passage`. Model se pak volá jen tehdy, když značka chybí
  nebo je pod prahem `PLATE_CONFIDENCE_MIN` — týmž prahem, pod kterým se
  značka nepáruje se seznamem; dvě různé hranice by znamenaly značku
  dost dobrou na uložení a málo dobrou na rozhodnutí. Od kamery **bez**
  `reads_plate` se `plate` z těla ignoruje: jinak by šlo z libovolné
  ovládnuté kamery poslat vjezd s vymyšlenou allow značkou a nechat se
  odbavit. Odkud značka je, drží `vehicle_passages.plate_source`
  (`camera`/`model`) — u sporného vjezdu se musí dát poznat, kdo se
  spletl.
* **Varování na přehledu.** Kamera s `reads_plate`, od které přišly
  aspoň tři dnešní vjezdy a ani jeden se značkou. Jeden nepřečtený vjezd
  je bláto na značce, tři po sobě znamenají rozbité čtení nebo špatně
  nastavenou schopnost — a obojí vypadá v evidenci stejně jako brána,
  kterou nikdo neprojel.

Dokud migrace neproběhne, schopnosti se čtou jako `null` a **nic se
netvrdí**: neočekávaná třída se nehlásí a značka z těla se nebere, tedy
přesně jako předtím. Ingest, seznam kamer, formulář i detail vjezdu mají
záchytnou větev bez těch sloupců.

## Zásah

Zásah se ve FlightHubu zakládá jako **plánovaná úloha**
(`POST /openapi/v0.1/flight-task`, `task_type: "timed"`), stejně jako
hlídka. Ne přes `POST /openapi/v0.1/workflow`: Triggered Workflow čeká
na ruční potvrzení v Message Centru, takže bez kliknutí mise nevzlétne.
Ověřeno naostro. Workflow trigger je proto z kódu pryč celý — mrtvá
větev, která vypadá funkčně, je horší než žádná.

Z toho plyne, co musí být nastavené, aby zásah odletěl:

* **zóna musí mít trasu** (`zones.wayline_uuid`). Plánovaná úloha nechce
  souřadnice, chce trasu — dron po ní letí. Vybírá se ve formuláři zóny
  ze seznamu z `GET /openapi/v0.1/wayline`. Zóna bez trasy zásah
  neodešle, jen zaloguje, a přehled na to upozorní varováním.
* **lokalita musí mít sériové číslo doku** (`sites.dock_sn`) — doku,
  ne dronu.
* **dok musí být ve stavu, ze kterého se dá vzlétnout**: dron v doku,
  baterie nad 40 %, úložiště pod 95 %. Táž kritéria jako u hlídek,
  sdílená v `lib/dispatch/dock-readiness.ts`. Když nevyhoví, zásah se
  neodešle a důvod je v `dispatches.decision_reason.dock`; výsledek je
  `suppressed_dock`, ne `failed` — nic se nepokazilo, jen dron nemohl
  letět.

Když se některý vstup pro rozhodnutí nepodaří zjistit, zásah končí
jako `suppressed_unknown` — ne jako `suppressed_disarmed`. Ty dva se
nesmí slít: první znamená „portál nevěděl“, druhý „areál nestřežil“.
Co konkrétně chybělo, je v `decision_reason.unknown_inputs`.

Režim střežení a cooldown jsou **fail-closed** (bez nich se neletí:
planý let nebo zdvojený zásah stojí víc než zmeškaná detekce),
eskalace **fail-open** (bez ní se letí na základním stupni — nižší
stupeň je pořád zásah).

Úloha začíná **za minutu** (`begin_at` i `latest_begin_at`). Nula slacku
je schválně: dron, který vyrazí o pět minut později, přiletí k prázdné
zóně.

Vrácené `task_uuid` se ukládá do `dispatches.fh_task_uuid` a zároveň se
zakládá řádek ve `flights` s `kind = 'dispatch'`, aby let dotáhla
synchronizace. `dispatches.fh_incident_uuid` zůstává jen kvůli
historickým řádkům ze staré cesty.

`zones.location` se do FlightHubu neposílá. Zůstává kvůli mapě
a detailu zásahu, takže zóna bez souřadnic zásah nezastaví.

`FH_WORKFLOW_UUID` už nikdo nečte a není povinná.

### Zápis zásahu (migrace 20260909180000 je nutná)

Podmínka `dispatches_incident_matches_outcome` zůstala z doby workflow
triggeru a žádala u `outcome = 'sent'` vyplněné `fh_incident_uuid`. Od
přechodu na plánované úlohy se ale vyplňuje `fh_task_uuid`, takže
databáze odmítala **čtyři ze sedmi výsledků**: `sent`, `suppressed_dock`,
`suppressed_unknown` a `suppressed_announced`.

Projevovalo se to jako tiché selhání: úloha se ve FlightHubu založí
PŘED zápisem, takže dron vzlétl, ale v portálu po něm nezůstalo nic —
žádný zásah, tím pádem ani řádek letu, ani notifikace. V logu jediná
řádka „Zápis dispatche selhal“.

Opravuje to migrace `20260909180000_dispatch_outcome_constraint.sql`.
**Dokud neproběhne, žádný odeslaný zásah se nezapíše.** Pojistkou proti
opakování je `supabase/tests/dispatch_outcomes.sql`: zkouší zapsat každý
výsledek, který kód umí vyrobit.

### Stupeň a spodní hranice zóny

Stupeň neřídí let — ten je daný trasou zóny. Jde do názvu úlohy ve
FlightHubu a do odznaku v portálu, tedy do toho, jak vážně se událost
bere.

`zones.default_level` je **spodní hranice** stupně pro danou zónu: nižší
spočtený stupeň se na ni zvedne, vyšší zůstane. Neznámý objekt u hlavní
brány tak neskončí na stupni 1 jako neznámý objekt na kraji pozemku,
i když detektor viděl v obou případech totéž. Eskalace na 5 projde
i ze zóny s hranicí 2 — hranice zvedá, nikdy nesnižuje.

Do `decision_reason` se ukládá hranice i to, jestli něco zvedla
(`zone_default_level`, `zone_floor_applied`), aby z detailu šlo poznat,
odkud stupeň je. U zásahů z doby, kdy se hranice neuplatňovala, obojí
chybí a detail o ní mlčí.

### Ruční zásah z portálu

Na kartě **Zóny** areálu má každá zapnutá zóna tlačítko „poslat dron“.
Vidí ho admin a operátor; klient ne — dron mu nad areálem létá, ale
neřídí ho. Skrytí tlačítka není ochrana: roli kontroluje sama akce
a čtení zóny běží pod session uživatele, takže na cizí areál se odsud
nikdo nedostane.

Tlačítko jede **touž cestou jako detekce** — `runDispatch()` se vším,
co k němu patří. Mimo hlídané okno, během cooldownu nebo s
nepřipraveným dokem dron nevzlétne ani na povel, a operátor se to
dozví z hlášky v dialogu. Druhá sada pravidel „pro ruční zásahy“ by se
s tou první časem rozešla a přesně v tom rozdílu by vzlétl dron, který
vzlétnout neměl.

Rozdíly proti zásahu z detekce jsou jen tři:

* `dispatches.triggered_by_detection` zůstává **NULL** — tak to schéma
  popisuje od první migrace. Falešná detekce kvůli tlačítku by znamenala
  zapsat do důkazní tabulky událost, kterou nikdo neviděl.
* Stupeň je vždycky **5** a eskalace se vůbec nezjišťuje. Tlačítko
  nemačká detektor, ale operátor, který se díval na obraz; třída objektu
  v tom žádná není, takže se do `decision_reason.object_class` ukládá
  `null`.
* Kdo dron poslal, je v `decision_reason.manual.actor_id`. Zásah zapisuje
  `service_role`, takže v `audit_log` u něj žádný autor není — tohle je
  jediná stopa. Detail zásahu ji ukazuje jménem, když na profil autora
  uživatel vidí.

## Plánování hlídek

`GET /api/cron/patrols` projde zapnuté hlídky a pro ty, které mají
v příštích deseti minutách odstartovat, založí let ve FlightHubu.

**Volá se zvenčí, ne z Vercelu.** Hobby plán pouští cron nanejvýš
jednou denně, takže by pětiminutová perioda neprošla ani buildem;
`vercel.json` proto žádné `crons` nemá. Endpoint zůstává, jen ho musí
někdo spouštět — server s crontabem, Cloudflare Worker, cokoli, co umí
poslat HTTP požadavek.

Perioda má být 5 minut. Okno je delší schválně, aby vynechaný běh
dohnal ten následující; dvojímu naplánování brání unikátní index na
`(patrol_id, started_at)`.

Řádek do crontabu:

```cron
*/5 * * * * curl -fsS -m 30 -o /dev/null -H "Authorization: Bearer $CRON_SECRET" https://portal.sky-guard.cz/api/cron/patrols
```

`CRON_SECRET` musí sedět s proměnnou nastavenou ve Vercelu. Bez ní
endpoint vrací 401 a nic neplánuje — nenastavené tajemství ho vypne
úplně, aby otevřený cron nedovolil komukoli zakládat lety.

Tajemství **nepatří přímo do řádku crontabu** — `/etc/crontab` bývá
čitelný pro všechny a v `ps` je vidět celý příkaz. Načíst ho ze souboru
jen pro vlastníka:

```cron
*/5 * * * * . /etc/sky-guard.env && curl -fsS -m 30 -o /dev/null -H "Authorization: Bearer $CRON_SECRET" https://portal.sky-guard.cz/api/cron/patrols
```

```bash
printf 'CRON_SECRET=…\n' > /etc/sky-guard.env
chmod 600 /etc/sky-guard.env
```

Doména v příkladu je zástupná — nahradit skutečnou.

## Dotahování letů z DJI

`GET /api/sync/flights` projde lety, které mají úlohu ve FlightHubu
a nemají konec. Dokončené dotáhne včetně trasy a médií, běžící jen
aktualizuje. Ověřuje se týmž `CRON_SECRET`.

```cron
*/15 * * * * . /etc/sky-guard.env && curl -fsS -m 300 -o /dev/null -H "Authorization: Bearer $CRON_SECRET" https://portal.sky-guard.cz/api/sync/flights
```

Čtvrthodina stačí: média se objevují až po nahrání z doku, což trvá
minuty. Jeden běh zpracuje nejvýš deset letů a useknutí hlásí
v odpovědi (`truncated`), aby to nevypadalo jako „nic dalšího nebylo“.

Selhání jednoho letu ostatní nezastaví; jakékoli selhání ale vrací
**500**, aby `-f` v curlu poslalo mail.

Média jdou do privátního bucketu `lety` v Supabase Storage, ne do R2 —
adresa se podepisuje a první složka v cestě je UUID lokality, takže
čtení pouští táž funkce jako u řádků.

### Potvrzení nebezpečí

Po stažení médií projdou fotky z letu modelem Claude Haiku s jedinou
otázkou: je na nich člověk nebo vozidlo? Výsledek se zapíše do
`flights.threat_confirmed` a je TŘÍHODNOTOVÝ — `NULL` znamená nejistý
výsledek, ne „nic tam není“. Kontrolu vypíná chybějící
`ANTHROPIC_API_KEY`: běh se pak jen zaloguje a pokračuje, protože
chybějící nastavení není selhání a `curl -f` by kvůli němu chodil
mailem po každé čtvrthodině.

Tentýž endpoint dělá druhý průchod: dobírá dokončené lety, u kterých
kontrola dřív selhala. Bez něj by se na ně už nikdo nepodíval —
jakmile má let `ended_at`, první dotaz ho nevybere. Okno je týden,
pak se na let rezignuje a zůstane u „nekontrolováno“.

Na jeden let se posílá nejvýš osm fotek a snímek nad 5 MB se
přeskakuje (limit API). Přeskočený snímek se počítá jako nepřečtený,
takže závěr spadne na `NULL` — tvrdit „nic tam není“ na základě části
snímků by lhalo.

Endpoint vrací souhrn, co naplánoval, co přeskočil (dron mimo dok,
baterie pod 40 %, zaplněné úložiště) a co selhalo. Přeskočení je
normální provozní stav a končí stavem 200; jakékoli **selhání vrací
500**, aby `-f` v curlu poslalo mail. Bez toho by běh, ve kterém
selhalo plánování všech hlídek, prošel tiše.

## Úklid úložiště

`GET /api/cron/retence` maže soubory starší než `sites.retention_days`
(výchozí 90 dní, nastavuje se u areálu). Volá se **jednou denně**.

```cron
17 3 * * * . /etc/sky-guard.env && curl -fsS -m 300 -o /dev/null -H "Authorization: Bearer $CRON_SECRET" https://portal.sky-guard.cz/api/cron/retence
```

**Mažou se jen soubory, řádky zůstávají.** Detekce, vjezd i let jsou
důkazy a mizet nesmí; po lhůtě jen přestanou nést obrázek. Cesta se
přitom v databázi vynuluje, aby UI nenabízelo odkaz na soubor, který už
není — „snímek se nepodařilo načíst“ vypadá jako porucha, kdežto
„snímek už není“ je stav, který se dá vysvětlit.

Cesta se nuluje **až po** úspěšném smazání. Kdyby se zapsala dřív
a mazání selhalo, soubor by v úložišti zůstal navždy a nikdo by o něm
nevěděl.

Jeden běh smaže nejvýš 500 souborů; zbytek vezme zítřek a useknutí je
vidět v souhrnu jako `truncated`.

## Push notifikace

### Klíče

```bash
npm run vapid
```

Vypíše dvojici VAPID klíčů a **nikam je nezapíše**. Veřejný patří do
`NEXT_PUBLIC_VAPID_PUBLIC_KEY` (jde do prohlížeče, bez něj se odběr
nedá založit), privátní do `VAPID_PRIVATE_KEY` (zůstává na serveru).
Volitelně `VAPID_SUBJECT`, výchozí je `mailto:info@sky-guard.cz`.

Bez obou klíčů se notifikace tiše neposílají a v logu je o tom řádek.
Není to chyba běhu — zásahy a synchronizace jedou dál.

**Změna klíčů zneplatní všechny existující odběry.** Push služba je
váže na veřejný klíč, kterým vznikly; uživatelé si notifikace budou
muset povolit znovu.

### Odesílá se ze tří míst

| Kdy | Kde | Druh |
|---|---|---|
| po zápisu zásahu | `lib/dispatch/run.ts`, v `after()` | `dispatch_sent` / `dispatch_suppressed` |
| po potvrzení nálezu | `lib/flights/sync.ts` | `threat_confirmed` |
| mlčící kamera, dok | `GET /api/cron/varovani` | `camera_silent` / `dock_problem` |

```cron
*/30 * * * * . /etc/sky-guard.env && curl -fsS -m 60 -o /dev/null -H "Authorization: Bearer $CRON_SECRET" https://portal.sky-guard.cz/api/cron/varovani
```

Zásah je událost — stane se jednou a jednou se ohlásí. Mlčící kamera
je **stav**: mlčí i za půl hodiny. Cron proto drží v `notification_log`
odstup (6 h) na dvojici lokalita–událost, jinak by posílal totéž při
každém běhu a uživatel by si notifikace vypnul — čímž by přišel
i o zásahy.

### Předvolby

Po lokalitách, v `/nastaveni`. Kdo si předvolby neuložil, dostává
výchozí sadu: zapnuto všechno kromě potlačených zásahů. Tiché hodiny
platí v čase lokality.

**Potvrzený nález tiché hodiny ignoruje.** Vypnout se dá, umlčet ne:
„v noci mě neruš“ neznamená „a nevadí, že mi na pozemku někdo je“.

### Proč web-push

Ověřeno, ne odhadnuto: balíček je čistě JavaScriptový, závisí jen na
vestavěných modulech Node (`crypto`, `https`, `url`, `util`), nemá
jediný `.node` soubor, `binding.gyp` ani install skript. Na Vercelu
tedy běží v Node runtime bez dalšího zařizování a ruční podpis VAPID
přes Web Crypto by byl řádově víc kódu bez výhody.

Odběr, na který push služba odpoví **404 nebo 410**, se maže hned.
Mrtvé odběry se jinak hromadí a každý stojí jedno volání po síti při
každé další notifikaci.

## Dohled nad cronem

Tři endpointy volá cron zvenčí, ne Vercel. Když se crontab rozbije,
vyprší certifikát nebo někdo přehodí `CRON_SECRET`, portál se nezmění:
hlídky prostě přestanou létat a na obrazovce to vypadá jako klidná noc.

Každý běh se proto zapíše do `cron_runs` (jméno, čas, souhrn) a přehled
hlásí varování, když je poslední běh starší než **trojnásobek**
intervalu dané úlohy. Trojnásobek, ne dvojnásobek: jeden vynechaný běh
je běžná věc, tři po sobě ne.

| Úloha | Endpoint | Interval |
|---|---|---|
| `patrols` | `/api/cron/patrols` | 5 min |
| `flights` | `/api/sync/flights` | 15 min |
| `warnings` | `/api/cron/varovani` | 30 min |

Intervaly jsou v `lib/cron/runs.ts` a musí sedět s crontabem výš —
jinak bude portál hlásit poplach na úlohu, která jezdí podle plánu.

Zapisuje se i neúspěšný běh: „doběhlo to a selhalo“ a „vůbec to
nedoběhlo“ jsou dvě různé diagnózy. Záznamy se drží týden a starší maže
sám zápis — samostatná úloha na úklid by byla čtvrtý cron, který může
taky přestat běžet.

Prázdná tabulka **není** v pořádku a hlásí se jako „úloha zatím nikdy
neproběhla“. Když ale chybí celá tabulka (migrace neběžela), přehled
mlčí — varovat na základě něčeho, co neexistuje, by bylo totéž tiché
selhání, jen obráceně.

Běhy čte **operátor a admin**, klient ne (migrace 20260911120000):
jsou to provozní čísla přes celý systém, tedy i o cizích areálech,
a zaseklý cron klient stejně nespraví. Přehled proto varování o cronu
klientovi vůbec nesestavuje — prázdná odpověď z RLS by jinak vypadala
jako „úloha nikdy neproběhla“.

### Hlídač zvenčí (healthchecks.io)

Všechno výš žije **uvnitř** portálu. Když umře VPS, `cron_runs` zestárne
a přehled to ukáže — jenže notifikaci o tom posílá `varovani`, tedy
právě ten mrtvý cron. Nikdo se nic nedozví, dokud si sám neotevře
portál.

Proto dead man's switch: healthchecks.io čeká na signál a když nepřijde
do nastaveného okna, ozve se samo. Hlídá **ticho**, ne chybu, takže
funguje i tehdy, když celý stroj zhasne.

Čtyři checky, jeden na úlohu. Period a grace se nastavují v jejich
rozhraní; hodnoty odpovídají intervalům z `lib/cron/runs.ts` a toleranci
trojnásobku, kterou používá přehled:

| Check | Period | Grace | Slug |
|---|---|---|---|
| Sky Guard — hlídky | 5 min | 10 min | `skyguard-patrols` |
| Sky Guard — lety z DJI | 15 min | 30 min | `skyguard-flights` |
| Sky Guard — varování | 30 min | 60 min | `skyguard-warnings` |
| Sky Guard — úklid úložiště | 1 den | 2 dny | `skyguard-retention` |

Pingat se dá ze dvou míst a stačí jedno z nich; opakovaný ping bere
healthchecks.io jako jeden.

**1) Z crontabu na VPS.** Doloží, že stroj žije a endpoint odpověděl
2xx. `curl -f` skončí nenulově při 4xx i 5xx, takže se `&&` neprovede
a hlídači nic nepřijde — což je přesně to, co má vyvolat poplach:

```cron
*/5  * * * * . /etc/sky-guard.env && curl -fsS -m 30  -o /dev/null -H "Authorization: Bearer $CRON_SECRET" https://portal.sky-guard.cz/api/cron/patrols  && curl -fsS -m 10 -o /dev/null "$HC_PATROLS"
*/15 * * * * . /etc/sky-guard.env && curl -fsS -m 300 -o /dev/null -H "Authorization: Bearer $CRON_SECRET" https://portal.sky-guard.cz/api/sync/flights  && curl -fsS -m 10 -o /dev/null "$HC_FLIGHTS"
*/30 * * * * . /etc/sky-guard.env && curl -fsS -m 60  -o /dev/null -H "Authorization: Bearer $CRON_SECRET" https://portal.sky-guard.cz/api/cron/varovani && curl -fsS -m 10 -o /dev/null "$HC_WARNINGS"
17 3 * * *   . /etc/sky-guard.env && curl -fsS -m 300 -o /dev/null -H "Authorization: Bearer $CRON_SECRET" https://portal.sky-guard.cz/api/cron/retence  && curl -fsS -m 10 -o /dev/null "$HC_RETENTION"
```

Adresy patří do `/etc/sky-guard.env` vedle tajemství, ne do crontabu —
kdo zná ping URL, umí hlídače umlčet:

```bash
printf 'CRON_SECRET=…\nHC_PATROLS=https://hc-ping.com/UUID-1\nHC_FLIGHTS=https://hc-ping.com/UUID-2\nHC_WARNINGS=https://hc-ping.com/UUID-3\nHC_RETENTION=https://hc-ping.com/UUID-4\n' > /etc/sky-guard.env
chmod 600 /etc/sky-guard.env
```

**2) Z endpointu samotného.** Volitelné, zapíná se proměnnými ve
Vercelu — `HEALTHCHECK_URL_PATROLS`, `HEALTHCHECK_URL_FLIGHTS`,
`HEALTHCHECK_URL_WARNINGS`, `HEALTHCHECK_URL_RETENTION` (tytéž adresy).
Přidává jedinou věc, kterou z crontabu poznat nejde: **jak běh dopadl**.
Úspěch pingne prostou adresu, běh s nenulovým `failed` pošle
`<adresa>/fail`, takže se v healthchecks.io rozliší „neproběhlo“ od
„proběhlo a selhalo“.

Ping jde ven **dřív** než zápis do `cron_runs`: kdyby byla nedostupná
databáze, hlídač se to musí dozvědět právě proto, že evidence uvnitř
portálu v tu chvíli nefunguje. Nikdy nevyhazuje a nikdy nemění výsledek
běhu — nenastavená proměnná znamená „tuhle úlohu zvenčí nehlídáme“
a mlčí.

Adresa musí být **https**; `http://` se odmítne, protože nešifrovaný
ping prozradí komukoli po cestě, kdy co běží.

## Avizované příjezdy

Dopravce dostane odkaz `/prijezd/<token>` a na samostatné stránce mimo
portál ohlásí, kdy a s jakou značkou přijede. Ingest to při čtení SPZ
najde a podle toho se rozhodne, jestli má dron vzlétnout. V podstatě
denní allow seznam, který si plní někdo zvenčí: `known_plates` drží
trvalá povolení, `announced_arrivals` jednorázová.

Odkazy zakládá admin na `/dopravci`. Token je 32 náhodných bajtů
v base64url; stránka je v `PUBLIC_PATHS` middlewaru a má vlastní
omezení počtu požadavků, stejným mechanismem jako ingest.

### Tři pravidla

| Kdy vjezd nastal | night_ok | Co se stane |
|---|---|---|
| mimo ostrý režim | jedno | ohlášení kryje, zásah ze značky neodejde |
| v ostrém režimu | ano | ohlášení kryje |
| v ostrém režimu | ne | ohlášení NEKRYJE, značka se řeší normálně |

Poslední řádek je ten podstatný: ohlásit denní rozvoz nesmí být zadní
vrátka na noc.

### Co ohlášení nezruší

**První zásah za VOZIDLO už v tu chvíli dávno odešel.** Rozhodnutí
o něm nečeká na přečtení značky a čekat nesmí — vjezd v nočním okně
spustí výjezd okamžitě a SPZ dorazí jako doplněk. Ohlášení tedy ruší
jen to, co by spustila značka; dron, který vzlétl na dvojce, se
odvolat nedá.

Aby se to dalo rozhodnout dřív, musela by značku posílat sama kamera
v těle požadavku (ANPR na bráně to umí). Zatím to `/api/ingest/passage`
nepřijímá.

### Přehled v portálu

`/prijezdy` ukazuje, co dopravci avizovali: datum, značku, dopravce,
poznámku, jestli platí i na noc a jestli už vozidlo dorazilo (vazba na
`vehicle_passages`). Výchozí rozsah je **dnes a dál**; historie je za
přepínačem, protože je to archiv, ne provozní pohled.

Vidí ho admin, operátor i klient — každý svou lokalitu, jak určí RLS.
Zakládat a rušit může jen admin (migrace 20260907120000): ohlášení je
závazek dopravce vůči areálu a kdo ho smí vytvořit, rozhoduje o tom, na
koho nevyletí dron.

Sloupec „Dorazilo“ rozlišuje tři stavy: odkaz na vjezd, „Čeká se“
u budoucích a **„Nedorazilo“** u ohlášení, kterému den prošel. Poslední
z nich není chyba, ale je to jiný stav než „ještě může přijet“.

### Párování

Značka se porovnává přes `plate_normalize()`, stejně jako
`known_plates`, a jen když ji model přečetl **spolehlivě** (jistota nad
`PLATE_CONFIDENCE_MIN`). Odbavit cizí auto kvůli špatně přečtené značce
je díra v ostraze, ne kosmetická nepřesnost.

Zásah s výsledkem `suppressed_announced` se zapisuje jen tam, kde by
jinak nějaký vznikl, tedy u deny značky. Vazba na ohlášení se přesto
ukládá na vjezd vždycky — i když nekrylo — a je vidět ve sloupci
„Ohlášeno“ na `/vjezdy`.

## Měsíční report

`/reporty` — výběr lokality a měsíce, náhled na stránce a tlačítko na
PDF (`GET /api/reporty?lokalita=…&mesic=YYYY-MM`).

Náhled i PDF čtou **stejná data** jedním loaderem
(`lib/reports/data.ts`). Kdyby si každý sahal pro čísla sám, lišila by
se — a report, ve kterém stojí jiné číslo než na stránce, ze které se
stáhl, je horší než žádný.

Přístup určuje RLS: lokalita se čte klientem přihlášeného uživatele,
takže klient dostane svou a admin kteroukoli. Cizí i neexistující id
končí stejně, na 404. Provozní část (dostupnost, přeskočené hlídky
a důvody) se do reportu přidává jen adminovi.

Hranice měsíce se počítají v pásmu lokality, ne v UTC — u letního času
je to rozdíl dvou hodin na obou koncích, což posune celý den nočních
detekcí.

### Fonty a diakritika

PDF staví **pdf-lib** s `@pdf-lib/fontkit` a vloženým **DM Sans** (týmž
písmem, kterým mluví portál i web). Vzor je z `constructiva-portal`,
kde jsou obě cesty vedle sebe a rozdíl je právě v diakritice: starší
report na jsPDF jede na Helvetice z PDF standardu, která české znaky
nemá, a řeší to přepisem „ě“ na „e“.

Fonty leží v `src/lib/fonts/` a do serverless funkce je dostane
`outputFileTracingIncludes` v `next.config.ts`. Bez toho by PDF
lokálně vypadalo dobře a na Vercelu spadlo zpátky na Helveticu —
nejhorší druh chyby. Kdyby soubory přesto chyběly, generování
nespadne, jen se použije Helvetica.

Subsetting je u DM Sans **zapnutý**. V constructiva-portal je u Interu
vypnutý, protože tamní subsetter rozbil složené glyfy s diakritikou;
u DM Sans to změřeno neplatí (text se vykreslí i vyextrahuje správně)
a font zabere 4 kB místo 29. Při změně písma je potřeba to přeměřit —
je to vlastnost fontu, ne knihovny.

### Obrázky

Snímky nálezů se před vložením zmenšují přes `sharp` na 320 px. Bez
toho má jedna fotka z dronu klidně 6 MB a report by se nedal poslat
mailem; s ním má celý report jednotky až desítky kB. `sharp` je
nativní modul, ale Next ho používá i pro optimalizaci obrázků, takže
na Vercelu je doma.

Do reportu se vejde nejvýš 12 nálezů se snímkem. Useknutí se **vypíše
do reportu** — tichý ořez by u bezpečnostního přehledu tvrdil „víc
jich nebylo“.
