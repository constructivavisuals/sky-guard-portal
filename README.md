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

Endpoint vrací souhrn, co naplánoval, co přeskočil (dron mimo dok,
baterie pod 40 %, zaplněné úložiště) a co selhalo. Přeskočení je
normální provozní stav a končí stavem 200; jakékoli **selhání vrací
500**, aby `-f` v curlu poslalo mail. Bez toho by běh, ve kterém
selhalo plánování všech hlídek, prošel tiše.
