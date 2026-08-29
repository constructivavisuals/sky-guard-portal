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

Migrace 20260911120000 proto `anon` práva na **stávající** tabulky
bere. Přihlášeným (`authenticated`) se nesahá na nic: tam RLS pracuje
a zúžení práv by rozbilo provoz.

### Na tabulky budoucí databáze nedosáhne

Výchozí práva se nastavují zvlášť pro každou roli, která objekt
zakládá. Na `ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin` ale
postgres v SQL Editoru nedosáhne — Supabase si tu roli drží pro sebe
a odpoví `permission denied to change default privileges`. Migrace to
proto zkusí, a když neprojde, jen to vypíše a pokračuje dál. Shodit
kvůli tomu celou migraci by znamenalo přijít i o `REVOKE`, který
projde a je důležitější.

Ochranu tedy nedrží databáze, ale kontrola, kterou někdo pustí:

```bash
# lokálně: pouští se sama v rámci sady
bash supabase/tests/run-local.sh

# proti produkci: obsah souboru vložit do SQL Editoru v Supabase,
# nebo přímo
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/rls_audit.sql
```

`supabase/tests/rls_audit.sql` **spadne**, když najde tabulku bez RLS
nebo tabulku, na kterou má `anon` jakékoli právo. Je čistě čtecí —
nezakládá, nemaže, nespouští transakci a nejsou v něm psql příkazy,
takže se dá pustit i proti ostré databázi. Práva se ověřují přes
`has_table_privilege()`, ne přes `information_schema`, aby se chytila
i práva udělená roli `PUBLIC`. Tabulky patřící rozšířením (PostGIS
a spol.) se přeskakují — nezaložil je portál.

Lokálně ho pouští `rls_deny_by_default.sql` hned na začátku. Zvlášť je
proto, že ten soubor zakládá testovací účty a lokality, takže na
produkci nemá co dělat.

Tabulka, která má RLS a žádnou politiku, není chyba — je zavřená pro
všechny kromě `service_role`. Kontrola ji jen vypíše jako poznámku
(`ingest_rate_limits`, `notification_log`).

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

### Rotace hlavního tajemství

Klíč každé kamery se odvozuje z `INGEST_SECRET`. Kdyby se ověřovalo jen
proti jedné hodnotě, jeho výměna by naráz zneplatnila klíče **všech**
kamer — a než by je někdo objel a přehrál, ingest by nepřijal jedinou
detekci. Nepoznalo by se to: kamera zmlkne stejně, jako když jí někdo
utrhne kabel, a portál to ohlásí až po hodině jako „kamera se
neozvala“.

Ověřuje se proto proti dvěma hodnotám naráz:

| Proměnná | Význam |
|---|---|
| `INGEST_SECRET` | nové tajemství, zkouší se první |
| `INGEST_SECRET_PREVIOUS` | to předchozí, jen po dobu přepojení |

Postup rotace:

1. Do `INGEST_SECRET_PREVIOUS` uložit současnou hodnotu, do
   `INGEST_SECRET` novou. Od téhle chvíle hlásí všechny kamery dál.
2. Přehrát kamery po jedné (`npm run kamera-klic` s novým tajemstvím
   v prostředí). Každá, která ještě jede na starém, se při detekci
   zaloguje jako „kamera jede na PŘEDCHOZÍM tajemství“ — z logu je
   vidět, kolik jich zbývá.
3. Až v logu nikdo nezbyde, `INGEST_SECRET_PREVIOUS` smazat. Tím starý
   klíč přestane platit.

Prázdná nebo shodná hodnota se ignoruje, takže krok 3 jde udělat i tak,
že se proměnná nechá prázdná.

## Stavební kamery

Klient může mít stavbu s kamerami a bez dronu, areál s dronem a bez
kamer, nebo obojí. Řídí to `sites.has_drone` a `sites.has_cameras` —
vědomé nastavení, ne odvozenina z toho, jestli je vyplněné `dock_sn`
(lokalita může na dron teprve čekat).

Stavební kamery jsou Dahua, které umí jen FTP. Přijímá je relay: soubor
remuxne do MP4 a pošle ho do portálu, který ho uloží do bucketu
`zaznamy` a založí řádek v `camera_recordings`.
Časosběr **do Sky Guardu nepatří** — je to marketingová funkce
Constructivy a snímky (`.jpg`) míří dál tam. Relay má proto dva cíle
a rozděluje je podle přípony; spojkou mezi systémy je sériové číslo
kamery, nic jiného.

### Navigace podle toho, co lokalita má

Menu, dlaždice na přehledu i varování se řídí `has_drone` a
`has_cameras`. Stavba bez dronu nemá Zásahy, Lety, Hlídky ani stav
doku; areál bez kamer nemá Detekce a Bránu. U filtru „všechny lokality“
se bere **sjednocení** — kdo má stavbu i areál, musí v menu vidět
obojí, jinak by se k půlce portálu nedostal jinak než přepnutím.

Skrytí je úklid obrazovky, ne bezpečnost: stránky samotné zůstávají
dostupné, protože klient s obojím se na `/lety` z „všech lokalit“
dostane právem. Zámkem je RLS, jako všude jinde.

Přepnutí lokality v liště volá `selectSite()`, která dělá
`revalidatePath("/", "layout")` — layout se překreslí celý, takže se
menu přizpůsobí samo.

Filtr `visibleNavItems()` bydlí v `lib/nav.ts`, ne v sidebaru. Volá ho
server (přehled) i klient (sidebar, spodní lišta), a kdyby byl
v `"use client"` modulu, dostal by server jen klientskou referenci
a spadlo by to za běhu na *„Attempted to call visibleNavItems() from
the server"*. Přesně to se jednou stalo. **Build to nechytí** —
`/prehled` je dynamická stránka a při buildu se nespustí — takže na to
je vlastní kontrola:

```bash
npm run hranice     # scripts/hranice-klient-server.mjs
```

Projde soubory bez `"use client"` a najde, kde volají hodnotu
importovanou z klientského modulu. Komponenty se nehlásí: ty se z něj
importovat smí, server je jen vykreslí.

Totéž dělení má `site.ts` (čisté, smí i klient) vs. `selected-site.ts`
(server, sahá na `cookies()`).

Dvě pravidla, která si při tom zaslouží pozor:

* **Kamera bez zóny** je varování o *zásahu*, ne o kameře — bez zóny
  z detekce zásah nevznikne. Na stavbě bez dronu tedy nedává smysl.
* **FTP kamery se do něj nepočítají vůbec.** Zónu nikdy mít nebudou,
  takže bez téhle výjimky by přehled každé stavby hlásil „5 kamer nemá
  přiřazenou zónu“ hned po zapnutí modulu.

### Dva způsoby příjmu pod jednou tabulkou

Kamera je fyzické zařízení a patří na jeden řádek v `cameras`. Rozdíl
mezi nimi je ale bezpečnostní, takže ho nese výslovný sloupec
`ingest_mode`, ne odvozenina ze souběhu nullable sloupců:

| | `http` | `ftp` |
|---|---|---|
| doručení | podepsaný požadavek na `/api/ingest` | nahrání na relay |
| ověření | HMAC klíč odvozený z `INGEST_SECRET` | **žádné** |
| co ji chrání | podpis každého požadavku | nedostupnost FTP zvenčí |
| zóna a zásah | ano | ne |

CHECK v databázi drží, že FTP kamera **nesmí mít ingest klíč** (otisk by
tvrdil, že se požadavky ověřují) a **musí mít FTP účet** (bez něj ji
watcher nedohledá).

Kontrola schopností (`detects_person` a spol.) se u FTP kamer nepoužívá:
watcher třídy objektů nezná a typ události bere z cesty k souboru.

### Tři lhůty, které se nesmí splést

| Sloupec | Co znamená | Výchozí |
|---|---|---|
| `sites.retention_days` | naše lhůta pro Supabase Storage — snímky detekcí, vjezdů, média letů | 90 dní |
| `sites.clip_retention_days` | naše lhůta pro video ze stavebních kamer | 14 dní |
| `cameras.sd_retention_days` | jak dlouho vydrží záznam na SD kartě **v kameře** | — |

Poslední z nich je údaj o zařízení, ne rozhodnutí. Constructiva má týž
sloupec pojmenovaný `retention_days` a její README před tou záměnou
varuje; tady se rovnou zakládá pod jménem, které si to splést nemůže.

### Záznam přežije video

Po uplynutí `clip_retention_days` se maže soubor v Hetzneru, ale řádek
v `camera_recordings` zůstává a vyplní se `video_expired_at`. V portálu
je pak vidět, že se v ten čas něco dělo — jen to nejde přehrát.
`storage_path` zůstává jako stopa, kde soubor byl, takže sám o sobě
není podmínkou přehratelnosti.

R2 se nikdy nepoužilo; starší poznámky o `r2_key` v komentářích byly
převzaté z Constructivy.

### Kamery nahrávají H.264

Ne H.265, a je to rozhodnutí, ne náhoda. Relay soubor jen **přebaluje,
nepřekódovává** — co kamera natočí, to klient vidí, takže se kodek musí
vyřešit v kameře.

U H.265 se v MP4 musí rozhodnout, kam se zapíšou parametry streamu
(VPS/SPS/PPS), a ani jedna možnost nevyhoví oběma stranám:

| | Chrome / desktop | Safari / iPhone |
|---|---|---|
| `hev1` — parametry u každého vzorku | ano | **ne** |
| `hvc1` — jen v hlavičce `hvcC` | **ne** | ano |

`-tag:v hvc1` totiž není přejmenování FourCC: ffmpeg při něm parametry
ze vzorků **vyhodí**. Mění-li kamera parametry za běhu (Dahua Smart
Codec), ty změny se ztratí a Chrome — který si postaví dekodér jednou
z `hvcC` — spadne na `PIPELINE_ERROR_DECODE` (VideoToolbox `-12909`).

Klient se dívá z desktopu i z iPhonu, takže se vybrat nedalo. H.264 tu
volbu ruší: `avc1` přehraje každý prohlížeč a ffmpeg u něj nechává
parametry i ve vzorcích, takže se nemá co ztratit. Platí se za to
zhruba dvojnásobným datovým tokem — což je důvod hlídat strop na
lokalitu (`recording_quota_bytes`).

Nastavení kamery včetně **vypnutého Smart Codecu** popisuje
[MONTAZ.md](infra/sky-watcher/MONTAZ.md). Watcher HEVC větev drží dál
pro staré soubory z SD karet.

**Záznamy pořízené v H.265 se opravit nedají.** Parametry, které `hvc1`
při remuxu vyhodil, v souboru nejsou a není odkud je vzít — ověřeno
měřením: nedoplní je ani `ffmpeg -c copy -tag:v hev1`, ani přepsání
FourCC. `npm run pretaguj` umí jen přepsat ten kód, což pomůže pouze
tehdy, když souboru vadil samotný kód. Jinak zbývá počkat, až odejdou
lhůtou (`clip_retention_days`, 14 dní), nebo je znovu stáhnout z SD
karty kamery.

Idempotence příjmu stojí **jen** na `sd_file_path`. Constructiva má
vedle toho ještě unique `(camera_id, started_at)` z doby před FTP
příjmem a její README ho popisuje jako past: dvojice main + sub stream
má stejný čas začátku a druhý stream se zahodí. Tady ten index záměrně
není.

### Příjem záznamů: `/api/ingest/recording`

Dva požadavky na jeden soubor. Obojí podepsané **RELAY_SECRET**, ne
klíčem kamery: relay je prostředník za víc kamer naráz a kameru
pojmenuje sériovým číslem v těle. Rotace funguje stejně jako
u `INGEST_SECRET` — po dobu přepojení se ověřuje i proti
`RELAY_SECRET_PREVIOUS` a relay na starém tajemství se zaloguje.

```
POST /api/ingest/recording          → ohlášení, vrací nahrávací adresu
PUT  <upload_url>                   → soubor jde přímo do úložiště
POST /api/ingest/recording/confirm  → potvrzení, vyplní uploaded_at
```

Ohlášení dohledá kameru podle `serial_number`, ověří idempotenci na
`sd_file_path`, založí řádek se `storage_path` a vrátí jednorázovou
adresu (platí 2 h). Kamera musí být vedená jako `ingest_mode = 'ftp'`
— kamera, která se umí podepsat sama, si relay mluvit za sebe nenechá,
jinak by se relayovým tajemstvím dal podvrhnout záznam kterékoli
kamery v portálu.

Tři věci, které stojí za pozornost:

* **Čas není omezený tolerancí podpisu.** U detekce ano, protože se
  hlásí, když se stane. Záznam se nahrává až po dotočení a po výpadku
  sítě leží ve frontě klidně den — meze jsou proto měsíc dozadu
  a pár minut dopředu.
* **Na hotový záznam se adresa nevystaví.** Ohlášení se dá zopakovat
  (relay to dělá po neúspěšném nahrání), ale jen dokud soubor
  nedorazil. Jinak by z odchyceného požadavku šlo přepsat existující
  soubor.
* **Velikost se měří, netvrdí.** Potvrzení se nezeptá relaye, jak je
  soubor velký — zeptá se úložiště. Když soubor nenajde, potvrzení
  odmítne a záznam zůstane nedokončený. `uploaded_at` má znamenat
  „soubor tam je“, ne „někdo to tvrdil“.

#### Vyzkoušení curlem

Podpis počítá `npm run relay-podpis`; vypíše hotový příkaz. Ruční HMAC
je otrava a překlep v něm vypadá jako zamítnutý podpis.

```bash
export RELAY_SECRET=…              # totéž, co má portál
export PORTAL_HOST=https://portal.sky-guard.cz
export CAMERA_SERIAL=BK024AAPAGB5592

# 1. ohlášení — vrátí recording_id a upload_url
eval "$(npm run --silent relay-podpis)"

# 2. nahrání souboru na vrácenou adresu
curl -X PUT "<upload_url>" -H 'Content-Type: video/mp4' --data-binary @klip.mp4

# 3. potvrzení
eval "$(npm run --silent relay-podpis potvrzeni <recording_id>)"
```

Bez souboru v úložišti vrátí krok 3 **409 `file_not_found`** — a to je
správně, ne chyba testu.

### Seznam záznamů, kalendář a osa dne

`/zaznamy` je obrazovka, na které se po montáži ověřuje, že řetěz
kamera → relay → portál → úložiště šlape. Filtr kamery a dne jsou
**odkazy, ne tlačítka** — filtr je součástí adresy, takže jde poslat
i otevřít v nové kartě, a celá ta část je serverová bez řádku
JavaScriptu v prohlížeči.

**Den je den lokality**, ne prohlížeče a ne UTC. Kdo se dívá na stavbu
z dovolené, musí vidět tentýž čtvrtek jako mistr na place — a v UTC by
se každý letní večer po 22:00 přelil do dalšího dne. Platí to na obou
stranách: `lib/recordings/timeline.ts` počítá hranice dne přes
`zonedTimeToUtc` (takže říjnový den vyjde jako 25 hodin, ne jako 24
posunutých) a RPC `camera_recording_day_counts` používá
`AT TIME ZONE s.timezone`.

To RPC je **záměrně bez `SECURITY DEFINER`** — běží právy volajícího,
takže se uplatní RLS a na cizí lokalitu vrátí prázdno. S ním by stačilo
uhodnout UUID lokality a šlo by zjistit, kdy se natáčelo na cizí
stavbě.

Kalendář a osa se ukazují jen u **jedné vybrané lokality**. U „všech
lokalit“ by se míchaly dny z různých pásem, což by mlčky lhalo, takže
zůstane prostý seznam. Den bez záznamů není odkaz: prázdná osa nikomu
nic neřekne.

### Živý obraz

`/zive` ukazuje, co kamera vidí právě teď. Prohlížeč se připojuje
**přímo na relay**, ne přes portál: serverless funkce minutové spojení
neudrží a video by teklo přes Vercel — u devíti kamer v HD je to řádově
jiná faktura než přenos z relaye.

Pak ale musí někdo rozhodnout o přístupu, protože relay o přihlášených
uživatelích nic neví. Pořadí je stejné jako u `/api/media` a nesmí se
prohodit:

```
GET /api/kamery/<id>/zivy?kvalita=sub
      │
      1. kamera se dohledá POD RLS, klientem uživatele
      2. teprve pak se vydá lístek, a jen na TU kameru (platí 2 min)
      3. relay lístek ověří a pustí proud
```

Kdo na lokalitu nevidí, dostane **404** — stejnou odpověď jako na
kameru, která neexistuje. Uhodnutým UUID se tedy nedá zjistit ani to,
jestli kamera je. Prohlížeč přitom nikdy nedostane adresu kamery v LAN
ani heslo; ta zůstávají na relayi.

Lístek se podepisuje `LIVE_STREAM_SECRET`, což je **jiné tajemství než
`RELAY_SECRET`**. Tím druhým mluví relay k portálu a zakládá jím
záznamy; kdyby to byla táž hodnota, znamenal by uniklý lístek
z prohlížeče i možnost zakládat záznamy jménem relaye. Že obě strany
počítají podpis stejně, hlídá `npm run hranice-listek`.

**MSE po websocketu, ne WebRTC.** WebRTC by mělo menší zpoždění
(desetiny vteřiny proti zhruba vteřině), ale platí se za to ICE, UDP
porty a průchod NATem diváka. Na dva tři diváky, kteří se občas
podívají, jestli na place někdo je, to zpoždění nehraje roli — a MSE
jede přes týž TCP jako zbytek portálu, takže projde i ze sítě, kde je
UDP zavřené.

Přehrávač je vlastní (`zive/live-view.tsx`, ~200 řádků). go2rtc svůj
nabízí, jenže načíst skript z relaye by znamenalo pustit v CSP cizí
`script-src` a tím rozvolnit to, co portál chrání.

Obraz se skládá v prohlížeči přes MediaSource, takže do `<video>` jde
jako `blob:` — proto to musí být v `media-src`. Websocket na relay musí
být v `connect-src`. Obojí se skládá z `LIVE_STREAM_BASE_URL`, která
proto musí být i v prostředí **buildu**.

Ukazuje se **jedna kamera, ne mřížka**: devět proudů naráz je devět
dekodérů v prohlížeči a to položí i slušný notebook. Výchozí je
**vedlejší** proud — hlavní je v plném rozlišení a přes LTE na stavbě se
nerozjede.

Zvuk je vypnutý, dokud si ho někdo nezapne. Ne kvůli slušnosti:
prohlížeče samy nepustí video se zvukem, dokud uživatel na stránku
neklikne, a čekat na to by znamenalo, že se obraz nerozjede vůbec.
Nahrává se z něj nic — je to živý poslech.

Provoz na relayi (go2rtc, dveřník, Caddy) popisuje
[infra/sky-watcher/README.md](infra/sky-watcher/README.md).

### Souvislý den, ne seznam souborů

Kamera nahrává po **osmiminutových kusech**. To je detail toho, jak se
data vozí — klient chce vidět den, ne dvě stě řádků. Výchozí pohled na
den je proto souvislý přehrávač:

- osa je **posuvník přes celých 24 hodin**; kliknutím se vybírá ČAS, ne
  soubor pod kurzorem,
- na konci souboru se **navazuje samo**, bez cuknutí,
- posun po ose během přehrávání skočí do správného souboru **a na
  správnou pozici v něm**,
- nad obrazem je **skutečný čas záznamu**, ne pozice v souboru.

Seznam souborů zůstává na `?pohled=soubory` — po montáži se podle něj
ověřuje, co dorazilo, jak je to velké a v jakém je to stavu. Přepínač je
v adrese, ne ve stavu komponenty, aby šel odkaz na konkrétní pohled
poslat kolegovi.

**Dva prvky `<video>`, ne jeden.** S jedním by se na každé hranici
přepsal `src`, prohlížeč by znovu navazoval spojení a najížděl dekodér —
každých osm minut viditelné cuknutí. Proto se střídají: v jednom se
hraje, do druhého se mezitím načítá další, na `ended` se jen prohodí,
který je vidět. Skrytý se schovává **průhledností, ne `display: none`** —
takový prvek prohlížeč nemusí přednačítat a celé zdvojení by bylo
k ničemu.

Nativní `controls` se nepoužívají: jejich lišta ukazuje pozici *v
souboru* (0:00–8:00), tedy přesně ten detail, který se má schovat.

Překlad mezi časem dne a pozicí v souboru je v
`lib/recordings/playback.ts`, bez Reactu a bez DOM. Aritmetika kolem
hranic souborů a mezer mezi nimi je přesně to, na čem se dá tiše ujet
o minuty, a v prohlížeči se to ladí mizerně. Pravidla:

| Kam klik padne | Kam se skočí |
|---|---|
| doprostřed záznamu | ten záznam, přesný offset |
| do mezery | **další** záznam vpřed, od začátku |
| za poslední záznam | poslední, na jeho konci |

Vpřed schválně: kdo klikne do prázdna, čeká nejbližší další dění, ne
skok zpátky do už viděného úseku. Že se posunulo, přehrávač napíše —
bez toho vypadá skok o dvě hodiny jako vada, ne jako „v tu dobu se
nenatáčelo“.

**Souvislé přehrávání jde jen po jedné kameře.** Dvě kamery natáčejí
týž čas současně, takže „co běželo ve tři“ nemá jednu odpověď a segmenty
na ose se překrývají. Když den obsahuje víc kamer, přehrávač se
nerozjede a odkáže na filtr kamer nad sebou.

### Rozhraní, která se ověřují sama

`/api/ingest/*`, `/api/relay/*`, `/api/cron/*` a `/api/sync/*` session
cookie nemají a nikdy mít nebudou — podepisují se HMAC podpisem nebo
sdíleným tajemstvím. Musí být proto vyjmuté z matcheru middlewaru,
jinak dostanou 307 na `/login` místo odpovědi.

Zapomnělo se na to **třikrát** a pokaždé se to poznalo až zvenčí,
z relaye nebo z crontabu, kde přesměrování vypadá jako výpadek sítě.
Hlídá to `middleware.test.ts`: prochází skutečné routy na disku,
každou zařadí podle toho, čím se ověřuje (`supabaseAdmin()` = vlastní
ověření, klient ze `server.ts` = session), a pustí na její adresu ten
vzor z `middleware.ts` — tedy přesně to, co udělá Next. Routu, která se
nedá zařadit, test odmítne taky: na tom rozhodnutí stojí, jestli patří
do matcheru.

Totéž hlídá i druhý seznam, `PUBLIC_PATHS`: stránka mimo skupinu
`(app)` nemá layout portálu, takže se na ni chodí bez session.

### Detekce ze stavebních kamer

Stavební kamera se podepsat neumí — a nepotřebuje to. Události z ní
přeposílá služba na relayi, která drží **vlastní `RELAY_SECRET`**.
Kdo se za kterou kameru smí podepsat, rozhoduje `ingest_mode`
v databázi, ne hlavička požadavku: kdyby si to volající směl vybrat,
stačila by kompromitace VPS k podvržení detekce od kamery **u brány**,
na které visí otevírání závory. Kamera, která se umí podepsat sama, si
relay mluvit za sebe nenechá. Je to táž hranice jako u ohlášení
záznamu, a drží ji `verify-camera.ts`.

Ze stavební detekce **zásah nevzniká**: kamera nemá zónu a stavba
nemá dron, takže se dispatch ani nezkouší. Kdyby se volal, zapsal by
u každé události varování „detekce bez zóny“ — u stavby normální stav,
ne závada — a přehlušil by ta skutečná.

Konfiguraci si relay tahá z `/api/relay/cameras`, ne z konfiguráku na
VPS. Druhý seznam by se rozešel při první kameře, kterou někdo
přejmenuje nebo přepne na jinou IP, a rozešel by se tiše: služba by
dál poslouchala adresu, na které už nikdo není. **Hesla ke kamerám
portál nezná** — ta jsou na VPS.

Podrobnosti: [infra/sky-watcher/README.md](infra/sky-watcher/README.md).

### Relay: dva watchery nad jedním inboxem

Kamera posílá obě větve **jedním FTP účtem**; rozdělují se až na relayi
podle přípony. `.dav` bere `infra/sky-watcher` a posílá do Sky Guardu,
`.jpg` zůstává watcheru Constructivy a jde do časosběru. Každý ignoruje
přípony toho druhého; prázdné adresáře uklízí ten druhý, protože inbox
je jeho.

Sky Guard watcher běží ve **vlastním adresáři a vlastním compose
projektu** (`/opt/sky-watcher`), ne uvnitř cam-relay. Dvě repozitáře,
které by si nasazovaly do jednoho místa, by si přepisovaly soubory;
takhle se sdílí jen inbox, a to jako svazek.

Podrobnosti, nasazení a provozní tabulka jsou v `infra/sky-watcher/README.md`.

### Relay nemá přístup k úložišti ani k databázi

Nabízelo by se dát relayi klíč a nechat ho zapisovat samotného. Ani
u Hetzneru to nejde: **S3 klíč platí na celý bucket a žádnou RLS
nezná**, takže by kompromitace VPS znamenala přístup k záznamům ze
všech lokalit. U Supabase to bylo ještě horší — týž klíč by otevřel
i záznamy z dronu, snímky vjezdů a logy všech klientů.

Relay proto drží jediné tajemství — klíč, kterým podepisuje ingest:

1. remuxne soubor a řekne portálu „mám záznam“ (podepsané týmž HMAC
   jako detekce z kamer),
2. portál ověří podpis, dohledá kameru podle sériového čísla, ověří
   idempotenci na `sd_file_path`, založí řádek a vrátí **jednorázovou
   nahrávací adresu**,
3. relay pošle soubor přímo na ni (platí 2 h, nahrát se dá jednou),
4. potvrdí, portál vyplní `uploaded_at` a `size_bytes`.

Řádek tedy vzniká dřív než soubor. `uploaded_at IS NULL` znamená
„záznam je, soubor ještě ne“ a v UI se to nesmí tvářit jako
přehratelné — od `video_expired_at` („bylo a už není“) se to musí
rozlišit, jinak z toho nikdo nepozná, jestli čekat, nebo ne.

Úklid po lhůtě dělá `/api/cron/retence`. U kamerových záznamů je to ale
vlastní větev, ne čtvrtý druh v téže tabulce: jede podle
`clip_retention_days` (ne `retention_days`), maže z Hetzneru (ne ze
Supabase) a `storage_path` nechává být.

> Do migrace 20260918120000 se video ze stavebních kamer **nemazalo
> vůbec**. Sloupec `video_expired_at` existoval od 20260915120000, ale
> nikdo ho nikdy nevyplňoval — retence pokrývala jen média letů,
> detekce a vjezdy.

### Video leží v Hetzneru, snímky v Supabase

Devět kamer nahrává nepřetržitě, zhruba **300 GB denně**; týden zpětně,
který klient chce, jsou přes 2 TB. To Supabase Storage nezaplatí — 3 TB
u Hetzneru stojí kolem 26 $ měsíčně a relay stojí v témže datacentru
(Falkenstein), takže je nahrávání zdarma.

Stěhovalo se **jen video**. Snímky detekcí a vjezdů zůstávají v Supabase
Storage: jsou malé a autorizace nad nimi stojí na politikách nad
`storage.objects`, které fungují.

| | kde leží | čím se autorizuje |
|---|---|---|
| video z kamer | Hetzner, bucket `sky-guard-zaznamy` | portál pod RLS, pak podpis — `/api/media` |
| snímky detekcí a vjezdů | Supabase Storage | politika nad `storage.objects` |
| média z letů | Supabase Storage | politika nad `storage.objects` |
| záznamy z doby před přechodem | Supabase, bucket `zaznamy` | politika nad `storage.objects` |

Kam který záznam patří, říká `camera_recordings.storage_backend`. Bucket
`zaznamy` se neruší — historie v něm leží dál a musí zůstat přehratelná.

Proměnné prostředí:

```
HETZNER_S3_ACCESS_KEY   povinné
HETZNER_S3_SECRET_KEY   povinné
HETZNER_S3_ENDPOINT     povinné, např. fsn1.your-objectstorage.com
HETZNER_S3_BUCKET       volitelné, výchozí sky-guard-zaznamy
HETZNER_S3_REGION       volitelné, výchozí první část endpointu (fsn1)
```

> `HETZNER_S3_ENDPOINT` a `NEXT_PUBLIC_SUPABASE_URL` musí být
> v prostředí **buildu**, ne jen běhu: skládá se z nich `media-src`
> v CSP (`next.config.ts` běží při sestavení). Když při buildu chybí,
> použijí se volnější náhradní hodnoty a nikde to nezakřičí.

### Bezpečnostní hlavičky

Politika bydlí v `src/lib/csp.ts`, ne jako řetězec v konfiguraci —
**aby šla otestovat**. Chybějící direktiva se totiž při buildu ani
v testech aplikace nijak neprojeví; pozná se až v prohlížeči u klienta
jako „video nejde“. Přesně tak tu od zavedení CSP chyběl `media-src`
a video z dronu se nedalo přehrát, aniž by si toho kdokoli všiml —
obrázky povolené byly, takže galerie vypadala funkčně.

Odkud se smí načítat médium:

| Zdroj | Proč |
|---|---|
| `'self'` | přehrávač odkazuje na `/api/media` |
| Supabase | média z letů a záznamy z doby před přechodem |
| Hetzner (oba tvary adresy) | záznamy ze stavebních kamer |

Vlastní původ **nestačí**: `/api/media` odpovídá přesměrováním
a prohlížeč kontroluje i jeho cíl. Proto tam cizí původy musí být,
i když na ně kód nikde neodkazuje přímo.

`'unsafe-eval'` je jen ve vývoji — `next dev` staví zdrojové mapy přes
`eval`. V produkci ho nepotřebuje ani jeden chunk (ověřeno grepem přes
`.next/static/chunks`), takže tam nemá co dělat. `'unsafe-inline'`
u skriptů zůstává: Next si do stránky vkládá vlastní inline skripty
a utáhnout to jde jedině nonce protaženým do všech skriptů, což je
samostatná změna.

### Čtení: `/api/media`, ne podepsaná adresa

Hetzner žádnou RLS nezná, takže se přístup ověřuje **v portálu, před
podpisem**. Pořadí se nesmí prohodit:

```
GET /api/media/zaznamy/<storage_path>
      │
      1. prefix `zaznamy` určí tabulku (camera_recordings)
      2. řádek se dohledá POD RLS, klientem přihlášeného uživatele
      3. teprve pak se podepíše adresa a vrátí 302
```

Vlastnit cestu tedy nestačí. Krok 2 je celá ochrana: řádek, na který
uživatel nevidí, RLS nevrátí a odpověď je **404 — táž jako u cesty,
která neexistuje**. Kdo nemá přístup, nepozná ani to, jestli soubor je.

Přesměrovává se schválně: minutový úsek má desítky MB a serverless
funkce nemá téct videem. Range requesty si přebere prohlížeč sám, takže
přetáčení funguje.

### Strop na objem

Hetzner tvrdý limit nenabízí — bucket roste dál a přiteče faktura. Při
300 GB denně vyjede zaseknutá retence přes rozpočet za pár dní, takže si
strop hlídáme sami: `sites.recording_quota_bytes`, výchozí **500 GB**
(dekadických, aby se to dalo porovnat s fakturou).

Po vyčerpání portál na ohlášení odpoví **507** a relay přestane
přijímat. Je to 5xx schválně: relay to nesmí brát jako vadu souboru
a odsunout ho do `failed/` — soubor zůstane ležet v inboxu a jakmile
retence uvolní místo, příští průchod ho vezme.

Objem se sčítá z `size_bytes` funkcí `site_recording_bytes()`, ne
výpisem bucketu (2 TB objektů se vypisují pomalu a platí se za to).
Sčítá se jen to, co místo doopravdy zabírá: potvrzené a ještě nesmazané.
Zdrojem je velikost, kterou portál po nahrání **změřil** v úložišti, ne
tvrzení relaye.

Od 85 % chodí varování `storage_quota` (push, s odstupem jako ostatní).

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

Zásah se ve FlightHubu zakládá přes `POST /openapi/v0.1/flight-task`
s **`task_type: "immediate"`**. Ne přes `POST /openapi/v0.1/workflow`:
Triggered Workflow čeká na ruční potvrzení v Message Centru, takže bez
kliknutí mise nevzlétne. Ověřeno naostro. Workflow trigger je proto
z kódu pryč celý — mrtvá větev, která vypadá funkčně, je horší než
žádná.

**`immediate` funguje i na vypnutý dron** — ověřeno naostro: 20 s od
příkazu do vzletu, minuta na místo. Dřív se zásah zakládal jako
`timed` s minutovým odkladem, protože se věřilo, že jinak uspaný dron
nevzlétne. Ta minuta byla ve skutečnosti jen minuta, po kterou dron
nebyl nad zónou; noční selhání, která to zdánlivě potvrzovala, měla
jinou příčinu (viz výška návratu níž).

U okamžité úlohy se `begin_at` ani `latest_begin_at` **neposílají
vůbec**. Nejsou volitelné: čas v minulosti FlightHub odmítá a „hned“
se jím zapsat nedá.

**Hlídky zůstávají `timed`.** Tam plánování dopředu není omezení, ale
záměr — rozvrh říká, kdy se má letět, a `begin_at` je ten rozvrh.

Z toho plyne, co musí být nastavené, aby zásah odletěl:

* **zóna musí mít trasu** (`zones.wayline_uuid`). Plánovaná úloha nechce
  souřadnice, chce trasu — dron po ní letí. Vybírá se ve formuláři zóny
  ze seznamu z `GET /openapi/v0.1/wayline`. Zóna bez trasy zásah
  neodešle, jen zaloguje, a přehled na to upozorní varováním.
* **lokalita musí mít sériové číslo doku** (`sites.dock_sn`) — doku,
  ne dronu.
* **lokalita musí mít rozumnou výšku návratu** (`sites.rth_altitude`,
  výchozí 60 m). Viz níž — je to nejtišší způsob, jak nevzlétnout.
* **dok musí být ve stavu, ze kterého se dá vzlétnout**: dron v doku
  a baterie nad 40 %. Táž kritéria jako u hlídek, sdílená
  v `lib/dispatch/dock-readiness.ts`. Když nevyhoví, zásah se neodešle
  a důvod je v `dispatches.decision_reason.dock`; výsledek je
  `suppressed_dock`, ne `failed` — nic se nepokazilo, jen dron nemohl
  letět.

  **Plné úložiště doku mezi kritéria nepatří.** Ověřeno u doku: dron
  vzlétne i s plnou kartou — zaplněné úložiště znamená, že se nemusí
  uložit záznam, ne že se nedá letět. A to je jiná ztráta: nahrávka,
  která se nepořídí, je nepříjemná, kdežto neodletěný zásah znamená,
  že se nad zónou nikdo nepodíval. Zaplnění se proto od 90 % hlásí
  jako varování na přehledu a notifikací z cronu, jinou větou než
  „zásah neodletí“.

Když se některý vstup pro rozhodnutí nepodaří zjistit, zásah končí
jako `suppressed_unknown` — ne jako `suppressed_disarmed`. Ty dva se
nesmí slít: první znamená „portál nevěděl“, druhý „areál nestřežil“.
Co konkrétně chybělo, je v `decision_reason.unknown_inputs`.

Režim střežení a cooldown jsou **fail-closed** (bez nich se neletí:
planý let nebo zdvojený zásah stojí víc než zmeškaná detekce),
eskalace **fail-open** (bez ní se letí na základním stupni — nižší
stupeň je pořád zásah).

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

### Výška návratu domů

V kódu byla natvrdo **100 m**. Projekt ve FlightHubu má ale vlastní
strop — u nás 60 m — a mise, která ho překročí, se **nespustí**. Chyba
přitom nezní jako výška: vypadá to, jako by dron nereagoval, a hledá
se to na úplně špatném místě. Tohle stálo za nočními selháními, která
se sváděla na uspaný dron.

Výška je proto sloupec lokality (`sites.rth_altitude`, migrace
20260916120000, rozsah 20–500 m) a nastavuje se ve formuláři areálu.
Používá ji ingest i cron hlídek; když sloupec ještě není, spadne se na
`DEFAULT_RTH_ALTITUDE`.

Hodnota, se kterou se to zkoušelo, jde do `decision_reason.rth_altitude_m`
a detail zásahu ji vypisuje. Bez toho by se u starého zásahu nedalo
zjistit, s jakou výškou se letělo — a přesně to je první otázka, když
dron nevzlétl.

Rozsah 20–500 m je pojistka proti překlepu, ne bezpečnostní hranice.
Strop si určuje projekt ve FlightHubu a portál ho nezná; kdo má
v projektu jiný limit, musí si výšku přenastavit.

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
baterie pod 40 % — zaplněné úložiště mezi důvody NEPATŘÍ, viz Zásah)
a co selhalo. Přeskočení je
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

### Osobní údaje po lhůtě

Soubory jsou jen půlka věci. Řádky zůstávaly napořád — a v nich značky
vozidel, adresy odesílatelů a jména z evidence známých značek. SPZ je
podle EDPB osobní údaj a držet ho bez lhůty nejde.

Řádky se proto **nemažou, ale anonymizují**: zůstane všechno kromě
toho, čím se dá identifikovat osoba nebo vozidlo. Počty vjezdů
v měsíčním reportu tak platí i zpětně — a platí i rozpad na známé
a neznámé, protože `list_match` se zachovává.

| Kde | Co zmizí | Co zůstane |
|---|---|---|
| `vehicle_passages` | `plate`, `confidence`, `known_label`, `known_plate_id` | čas, kamera, `list_match`, `plate_source`, `anonymized_at` |
| `announced_arrivals` | `plate`, `note` (volný text od řidiče) | datum, dopravce, `night_ok` |
| `detections` | `source_ip` | vše ostatní |
| `ingest_rate_limits` | celý řádek po hodině nečinnosti | — |

Hashovat značku by nestačilo: SPZ je krátký a vyčíslitelný řetězec,
takže z otisku jde původní hodnota dopočítat hrubou silou. To by byla
pseudonymizace vydávaná za anonymizaci.

Vědra rate limitu jsou zvláštní případ — klíč nese IP adresu, takže je
to tabulka osobních údajů, která rostla donekonečna. Mažou se po hodině
nečinnosti; plné vědro se doplní nejpozději za dvě minuty, takže se tím
o žádnou ochranu nepřijde.

Omezení `vehicle_passages_match_needs_plate` proto nově dovolí shodu se
seznamem bez značky — ale **jen** u anonymizovaného řádku. Zapsat shodu
bez značky „jen tak“ dál nejde.

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

### Nedokončené zpracování

Zásah i čtení značky běží v `after()`, tedy až po odeslání odpovědi
kameře. Fronta ani opakování tam nejsou: když Vercel instanci ukončí
dřív, práce se ztratí a nikde po ní nezůstane stopa. Detekce se zapíše,
zásah nevznikne; vjezd se zapíše, značka se nepřečte. Vypadá to úplně
stejně jako „kamera nemá zónu“ nebo „značku nešlo přečíst“.

Varovací cron proto hledá dvě stopy a hlásí je jako `processing_stuck`
(migrace 20260912120000), přehled je ukazuje mezi ostatními varováními:

* **detekce v ostrém režimu bez jediného řádku v `dispatches`**, starší
  než 10 minut. Mimo ostrý režim se zásah nezakládá schválně, a deset
  minut je rezerva na to, co se zrovna počítá.
* **vjezd se snímkem a bez `plate_read_at`** starší než hodinu. Bez
  snímku není z čeho číst, takže prázdný sloupec je tam v pořádku.

Obojí se hledá den zpět. Není to náhrada za frontu — je to způsob, jak
se o ztracené práci vůbec dozvědět.

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
