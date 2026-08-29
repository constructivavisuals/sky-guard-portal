# sky-watcher

Příjem záznamů ze stavebních kamer do Sky Guardu. Běží na **témže
serveru jako cam-relay Constructivy** a čte **týž inbox**.

## Kde vede hranice

Kamera posílá obě větve jedním FTP účtem; rozdělují se až tady, podle
přípony:

```
kamera ──FTP──► /opt/cam-relay/ftp-inbox/<účet>/2026-08-27/001/…
                       │
        ┌──────────────┴───────────────┐
     .dav                            .jpg
        │                              │
  sky-watcher                  watcher Constructivy
        │                              │
  Sky Guard                      časosběr, beze změny
```

Každý ignoruje přípony toho druhého, takže si soubory neberou. **Prázdné
adresáře uklízí watcher Constructivy** — inbox je jeho; kdyby je mazali
oba, přetahovali by se o složky pod rukama.

Spojkou mezi systémy je **sériové číslo kamery**, nic jiného. Táž kamera
má v každém portálu vlastní id.

## Co watcher NEMÁ

Přístup k databázi ani k úložišti. Drží jediné tajemství — `RELAY_SECRET`
— a s portálem mluví takhle:

```
1. POST /api/ingest/recording          → recording_id + jednorázová adresa
2. PUT  <upload_url>                   → soubor jde do úložiště přímo
3. POST /api/ingest/recording/confirm  → portál si velikost ověří sám
```

Adresa vede do **Hetzner Object Storage** (bucket `sky-guard-zaznamy`,
Falkenstein), ne do Supabase: video je příliš objemné — devět kamer
nepřetržitě je zhruba 300 GB denně. Relay stojí v témže datacentru,
takže je ten přenos zadarmo a nikam se neobjíždí.

Klíč k úložišti tu ale **není ani tak**: S3 klíč platí na celý bucket
a žádnou RLS nezná, takže by kompromitace téhle VPS znamenala přístup
k záznamům ze všech lokalit. Na serveru je jen tajemství, kterým jde
založit záznam u kamery, která už v portálu je — podpis pod adresou
dělá portál.

Taky nemá **žádnou závislost mimo standardní knihovnu a ffmpeg**. Žádné
psycopg, boto3 ani requests — čím míň se na cizím serveru instaluje, tím
míň se ho dá napadnout skrz závislost.

## Nasazení

```bash
rsync -av --exclude '.env' --exclude 'failed' \
  infra/sky-watcher/ root@49.13.69.91:/opt/sky-watcher/
ssh root@49.13.69.91 'cd /opt/sky-watcher && docker compose up -d --build'
```

> `.env` žije **jen na serveru** a deploy na něj nesmí sáhnout — proto
> `--exclude`. Že se to opravdu chytlo, ověří:
> `docker inspect sky-watcher --format '{{json .Config.Env}}'`

Kamera musí být v portálu vedená se svým **sériovým číslem** a
`ingest_mode = 'ftp'`. Bez toho vrátí ohlášení 404 a soubor skončí
v `failed/`.

## Provoz

```bash
docker compose logs -f sky-watcher   # co přišlo a co ne
ls -R failed/                        # co neprošlo
```

Chování při potížích:

| Co se stalo | Co watcher udělá |
|---|---|
| nečitelná cesta | rovnou do `failed/` — opakováním se nespraví |
| portál odmítl (4xx) | do `failed/`, je to vada požadavku |
| portál nedostupný (5xx, síť) | **nechá ležet** a zkusí příště |
| vyčerpaný strop úložiště (507) | **nechá ležet**, hlásí `STROP ÚLOŽIŠTĚ` |
| remux selhal | zkusí 3× a pak do `failed/` |
| záznam už portál má | jen uklidí lokál |

Soubor se nikdy nemaže kvůli chybě — neprošlý záznam je pořád záznam
z kamery a někdo se na něj má podívat.

**507 není vada souboru.** Lokalita vyčerpala strop na objem videa
(`sites.recording_quota_bytes`, výchozí 500 GB) a portál schválně
přestal přijímat, aby v Hetzneru nerostla faktura — Hetzner tvrdý limit
nenabízí. Soubory zůstávají v inboxu a jakmile retence uvolní místo,
příští průchod je vezme. Kdyby šly do `failed/`, přišla by stavba
o záznamy z celé doby, než se místo uvolní, a nikdo by je odtamtud
nevrátil.

Po každém průchodu, i prázdném, jde ping na `HEALTHCHECK_URL`. Hlídá se
ticho, tedy že watcher žije — ne že zrovna něco přišlo.

## Události: detekce člověka v reálném čase

Druhá služba ve stejném obrazu, `sky-events`. Ke každé stavební kameře
drží jedno dlouhé HTTP spojení na `eventManager.cgi?action=attach`;
kamera po něm hlásí události, jak nastávají. Když ohlásí člověka,
služba si od ní stáhne snímek ze `snapshot.cgi` a pošle detekci na
`/api/ingest/detection`.

Detekci umí **kamera sama** — model má SMD s rozlišením člověka. Portál
obraz nevyhodnocuje, jen přijímá, co kamera řekla.

### Odkud ví o kamerách

Z portálu: `GET /api/relay/cameras`, podepsaný `RELAY_SECRET` nad
prázdným tělem. Vrací stavební kamery se sériovým číslem a `lan_ip`.
Seznam se obnovuje každých pět minut, takže nová kamera naskočí bez
zásahu na VPS.

Druhý seznam v konfiguráku by se rozešel při první kameře, kterou někdo
přejmenuje nebo přepne na jinou IP — a rozešel by se **tiše**: služba by
dál poslouchala adresu, na které už nikdo není.

**Hesla ke kamerám portál nezná a znát nemá.** Berou se z `.env` na
VPS; jsou pro všechny kamery stejná. Kdyby chodila z portálu, znamenala
by jeho kompromitace přístup do vnitřní sítě každé stavby.

### Nastavení v `.env`

| Proměnná | Výchozí | K čemu |
|---|---|---|
| `CAMERA_USERNAME` | `admin` | účet do kamery |
| `CAMERA_PASSWORD` | — | **povinné**, bez něj se služba nespustí |
| `EVENT_CODES` | `SmartMotionHuman` | co se hlásí jako detekce |
| `EVENT_ACTIONS` | `Start,Pulse` | `Stop` se ignoruje — konec pohybu není detekce |
| `EVENT_CLASS` | `person` | třída zapsaná do detekce |
| `EVENT_COOLDOWN_SEC` | `30` | nejméně vteřin mezi dvěma hlášeními téhož kódu |
| `SUBSCRIBE_CODES` | `All` | co se odebírá od kamery (viz níž) |
| `HEARTBEAT_SEC` | `10` | jak často kamera posílá tep |
| `CONFIG_REFRESH_SEC` | `300` | jak často se tahá seznam kamer |

### Jak zjistit správný kód události

Odebírá se `All`, filtruje se až `EVENT_CODES`. Každý kód, který kamera
pošle, se **jednou** zaloguje — i ten nehlášený:

```
Kamera Klanečná — jeřáb hlásí kód SmartMotionHuman (hlásí se dál: ne)
```

Takže: projít se před kamerou, přečíst log, doplnit kód do `EVENT_CODES`
a restartovat službu. Hádat se nemusí nic.

```bash
docker compose logs -f sky-events | grep "hlásí kód"
```

### Prodleva mezi hlášeními

Člověk procházející záběrem vyvolá událost každou vteřinu. Bez prodlevy
by z deseti minut práce na place bylo šest set řádků v evidenci, takže
se týž kód od téže kamery hlásí nejvýš jednou za `EVENT_COOLDOWN_SEC`.

### Výpadky

Spojení se obnovuje samo: 1 s → 2 → 4 → … se stropem na 60 s a s
rozptylem, aby po výpadku proudu nenaskočily všechny kamery v jednom
rytmu. Strop je tam schválně — hodinová pauza po dvacátém pokusu by
znamenala, že se kamera po opravě sítě probere až večer.

Kamera posílá **tep** (`heartbeat=10`); bez něj by mlčící kamera
vypadala stejně jako klidná noc, což je přesně ta závada, kterou tahle
služba mít nesmí. Ticho delší než 30 s se bere jako spadlé spojení.

Výpadek portálu běžící spojení **nezavírá**. Detekce se ztratí tou
nedoručenou zprávou, ne tím, že přestaneme poslouchat.

### Do vnitřních sítí přes Tailscale

Kamery jsou v `192.168.11.0/24` (Klanečná) a `192.168.12.0/24`
(Mírovka), dostupné přes Brume subnet routery. Na VPS to znamená
`tailscale up --accept-routes`; kontejner pak jde ven přes routovací
tabulku hostitele. Když se na kameru z kontejneru nedovoláš, ale
z hostitele ano, přidej službě `network_mode: host`.

## Montáž nové kamery

Postup na místě — co nastavit v kameře, co založit v portálu předem
a jak ověřit, že záznam dorazil: **[MONTAZ.md](MONTAZ.md)**.

## Když se záznam nepřehraje v prohlížeči

```bash
python3 infra/sky-watcher/diagnostika.py zaznam.mp4 --zdroj original.dav
```

Vezme hotové `.mp4` z úložiště a řekne, proč ho přehrávač odmítá:
kodek, tag, profil, level, rozlišení, pozice `moov` a hlavně **kde leží
parametry streamu** (VPS/SPS/PPS).

**Kamery nahrávají H.264** (viz [MONTAZ.md](MONTAZ.md)) a tím je tenhle
problém vyřešený u zdroje: `avc1` je jeho obvyklý kód, přehraje ho každý
prohlížeč a ffmpeg u něj nechává parametry i ve vzorcích — ověřeno.

Historie, kvůli které to tu stojí za popsání: u **H.265** se muselo
vybrat, kam parametry přijdou, a ani jedna možnost nevyhověla oběma
stranám. `-tag:v hvc1` není přejmenování FourCC — ffmpeg při něm
parametry z jednotlivých vzorků **vyhodí** a nechá je jen v `hvcC`.
Mění-li kamera parametry za běhu (Smart Codec), ty změny se ztratí.

| | parametry | Chrome | Safari/iOS |
|---|---|---|---|
| `hev1` | in-band, u každého vzorku | ano | **ne** |
| `hvc1` | jen v `hvcC` | **ne** | ano |

Klient se dívá z obojího, takže se vybrat nedalo. Řešením bylo přepnout
kamery na H.264, ne hledat lepší tag.

Watcher u HEVC tag **nevynucuje** (píše `hev1`), protože z SD karet ještě
můžou přijít staré soubory. `HEVC_TAG=hvc1` je páka pro materiál, kde
záleží víc na iPhonu. **Relay nikdy nepřekódovává** — devět kamer
nepřetržitě by z VPS udělalo překódovací farmu.

Se `--zdroj` skript týž `.dav` přebalí i bez toho tagu a porovná — tím
odliší vadu kamery od vady remuxu. Bez zdroje to nerozhodne a řekne to.

Past při čtení výstupu: `dekóduje: ano` **není** důkaz, že to přehrávač
vezme. Když parametry chybí, ffmpeg si drží poslední známé a dojede do
konce; Chrome si postaví `VTDecompressionSession` jednou z `hvcC`
a na první jinak kódovaný vzorek spadne — `PIPELINE_ERROR_DECODE`,
VideoToolbox `-12909`. Rozhoduje řádek `parametry`, ne `dekóduje`.

## Živý obraz

Tři služby, protože každá dělá něco jiného a padat mají zvlášť:

```
prohlížeč ──wss──► Caddy ──ptá se──► sky-live   (platí lístek?)
                     │
                     └──pustí──────► go2rtc ──RTSP──► kamera v LAN
```

| Služba | Co dělá |
|---|---|
| `go2rtc` | bere RTSP z kamer a servíruje ho po websocketu jako fMP4 |
| `sky-live` | ověřuje lístky a skládá go2rtc konfigurák podle portálu |
| `caddy` | TLS a dveřník — pustí tři cesty, zbytek odmítne |

### Kdo rozhoduje o přístupu

Prohlížeč se připojuje **přímo sem**, ne přes portál: serverless funkce
minutové spojení neudrží a video by teklo přes Vercel. Relay ale
o přihlášených uživatelích nic neví, takže:

1. portál pod RLS ověří, že uživatel na kameru vidí,
2. vydá **lístek platný dvě minuty, jen na tu jednu kameru**,
3. `sky-live` ho ověří a Caddy teprve pak pustí dál.

Lístek je HMAC nad `<jméno proudu>.<vyprší>`, podepsaný
`LIVE_STREAM_SECRET`. Jméno proudu je v podpisu schválně — bez něj by
lístek na vlastní kameru otevřel i kameru na cizí stavbě.

> `LIVE_STREAM_SECRET` je **vlastní tajemství, ne `RELAY_SECRET`**.
> Tím druhým mluví relay k portálu a zakládá jím záznamy; kdyby to byla
> táž hodnota, znamenal by uniklý lístek z prohlížeče i možnost
> zakládat záznamy jménem relaye.

Že obě strany počítají podpis stejně, hlídá `npm run hranice-listek` —
porovná TypeScript v portálu s Pythonem tady, včetně případů, které
mají selhat.

### Administrace go2rtc nesmí ven

go2rtc má na `/` rozhraní, kterým jde přidat proud z **libovolné**
adresy — tedy i z vnitřní sítě stavby. Port se proto nepublikuje a Caddy
pouští jen `/api/ws`, `/api/webrtc` a `/api/frame.jpeg`. Výchozí je
odmítnutí: kdyby se seznam někdy rozšiřoval, chyba bude v tom, že něco
nejde, ne v tom, že jde všechno.

### Konfigurák se generuje, needituje

`sky-live` si každých pět minut stáhne `/api/relay/cameras` a poskládá
`live-config/go2rtc.yaml`. **Zapisuje a restartuje jen při změně** —
restart shodí divákům obraz a dělat to každých pět minut kvůli
konfiguráku, který je pořád stejný, by z živého obrazu udělalo blikající
obraz.

Hesla ke kamerám v portálu nejsou; berou se z `.env` tady a do RTSP
adresy jdou **zakódovaná** (Dahua hesla běžně obsahují `@` a `/`).

### Nastavení v `.env`

```
LIVE_STREAM_SECRET   povinné, shodné s portálem
LIVE_HOSTNAME        kamery.sky-guard.cz (pro Caddy a jeho certifikát)
CAMERA_USERNAME      admin
CAMERA_PASSWORD      heslo ke kamerám, pro všechny stejné
RTSP_MAIN_PATH       nepovinné, výchozí /cam/realmonitor?channel=1&subtype=0
RTSP_SUB_PATH        nepovinné, výchozí /cam/realmonitor?channel=1&subtype=1
RTSP_PORT            nepovinné, výchozí 554
```

Cesty jde přenastavit z prostředí schválně: **ověřené na místě zatím
nejsou** a doladění nemá vyžadovat nasazení nové verze. Jednotlivá
kamera je může přebít sloupci `rtsp_main_path` / `rtsp_sub_path`
v portálu.

Adresář na konfigurák musí být zapisovatelný pro uživatele v kontejneru:

```bash
mkdir -p live-config && sudo chown 10001 live-config
```

### Než bude doména

Portál běží pod HTTPS a **z HTTPS stránky nejde otevřít nešifrované
spojení** — na `http://100.72.12.109` se tedy prohlížeč nepřipojí, ať
je CSP nastavená jakkoli. Dokud `kamery.sky-guard.cz` nemíří na relay,
jsou dvě cesty:

- **Tailscale** — relay v tunelu už je, takže `tailscale cert` vydá
  platný certifikát na `<stroj>.<tailnet>.ts.net` a `LIVE_HOSTNAME` se
  nastaví na něj. Funguje to jen pro toho, kdo je v tailnetu, což na
  ověření stačí; klient bude potřebovat doménu.
- **Vlastní obraz mimo portál** — otevřít go2rtc přímo na relayi přes
  SSH tunel a jen se podívat, že RTSP cesty sedí. Na doladění cest je
  to nejrychlejší.

## Test

Celý řetěz proti **falešnému portálu**, bez VPS a bez Sky Guardu:

```bash
python3 infra/sky-watcher/test/test_watcher.py
python3 infra/sky-watcher/test/test_events.py
python3 infra/sky-watcher/test/test_live.py
```

Vyrobí syntetické `.dav`, postaví portál na localhostu a ověří vznik
ohlášení, časy v UTC, typ události, nahrání, potvrzení, úklid lokálu
i `.idx`, oba tvary cesty, odsunutí nečitelné cesty i odmítnutého
požadavku, a že cizí tajemství neprojde. Falešný portál ověřuje podpis
touž cestou jako ten skutečný — kdyby se obě strany rozešly v tom, co
se podepisuje, projeví se to tady.

Druhý test staví **falešnou kameru** — multipart proud s řádky `Code=`,
`snapshot.cgi` — a falešný portál, a prožene tím celý řetěz: stažení
konfigurace, čtení proudu, filtr kódů, snímek, odeslání detekce. Ověřuje
i to, na čem by naivní parser spadl: kamera posílá `data=` jako JSON na
víc řádků. Nepotřebuje ffmpeg ani síť.

Třetí staví **falešný portál a falešného dveřníka**: ověří, že se
z kamer poskládá konfigurák se správnými adresami, že se heslo do
adresy dostane zakódované, a hlavně že brána odmítne lístek na jinou
kameru, propadlý lístek i podvržený podpis. Nepotřebuje ffmpeg, go2rtc
ani síť.

Bez ffmpegu se test watcheru **přeskočí** (návratový kód 2), ne aby vypadal jako
selhání kódu. Na macOS s Homebrew bývá příčinou upgrade x265 bez
rebuildu ffmpegu: `brew reinstall ffmpeg`.
