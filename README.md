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
