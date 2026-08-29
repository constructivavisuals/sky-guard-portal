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

Na stavbu se hodí papír, ne telefon:

```bash
./md2pdf.sh          # MONTAZ.md → MONTAZ.pdf
```

Převádí se Markdown → HTML → tisk přes Chrome; pandoc ani wkhtmltopdf
na to nejsou potřeba. **Po každé úpravě MONTAZ.md pusť znovu** — PDF se
samo neaktualizuje a zastaralý postup na papíře je horší než žádný.

Vlastní převodník (`md2html.py`) umí jen podmnožinu Markdownu, kterou
ten dokument používá. Hlídá ho `test/test_md2html.py`: chyba v převodu
se totiž v PDF pozná jako „nějak divně to vypadá“, a to typicky až na
stavbě, kde s tím nikdo nic neudělá — rozsekaný blok kódu přitom vypadá
jako platný příkaz.

## Když se záznam nepřehraje v prohlížeči

```bash
python3 infra/sky-watcher/diagnostika.py zaznam.mp4 --zdroj original.dav
```

Vezme hotové `.mp4` z úložiště a řekne, proč ho přehrávač odmítá:
kodek, tag, profil, level, rozlišení, pozice `moov` a hlavně **kde leží
parametry streamu** (VPS/SPS/PPS).

**Kamery nahrávají H.265** kvůli objemu (H.264 by ho zdvojnásobil
a upload na Klanečné je na hraně). U H.265 se ale musí rozhodnout, kam
v MP4 přijdou parametry streamu — a ani jedna obvyklá možnost nevyhoví
oběma stranám. `-tag:v hvc1` totiž není přejmenování FourCC: ffmpeg při
něm parametry z jednotlivých vzorků **vyhodí**.

| `HEVC_TAG` | co vznikne | Chrome | Safari/iOS |
|---|---|---|---|
| `hvc1-inband` *(výchozí)* | kód `hvc1`, parametry ve vzorcích | ? | ? |
| `hvc1` | kód `hvc1`, parametry jen v `hvcC` | **ne** | ano |
| prázdné | kód `hev1`, parametry ve vzorcích | ano | **ne** |

Výchozí `hvc1-inband` skládá obojí: přebalí se bez tagu, takže
parametry zůstanou u každého vzorku, a pak se přepíše jen čtyřznakový
kód. Dekodér tak dostane víc než u kterékoli čisté varianty — z `hvcC`
i z obrazu.

> **Je to mimo specifikaci a zatím NEOVĚŘENÉ.** ISO/IEC 14496-15 říká,
> že u `hvc1` parametry ve vzorcích být nemají, a přísný přehrávač to
> odmítnout může. Otazníky v tabulce zmizí, až to projde skutečným
> Safari a Chrome. Kdyby neprošlo, záložní plán je přepnout kamery na
> **H.264** — ten přehraje každý prohlížeč, `avc1` je jeho obvyklý kód
> a ffmpeg u něj parametry ve vzorcích nechává, takže celá tahle úvaha
> u něj nevzniká.

**Relay nikdy nepřekódovává** — devět kamer nepřetržitě by z VPS
udělalo překódovací farmu a obraz by se tím i zhoršil.

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
prohlížeč ──wss──► Caddy CONSTRUCTIVY  (TLS, :443)
                        │  sky-guard-edge
                        ▼
                   sky-caddy ──ptá se──► sky-live   (platí lístek?)
                        │
                        └──pustí────────► go2rtc ──RTSP──► kamera
```

| Služba | Co dělá |
|---|---|
| `go2rtc` | bere RTSP z kamer a servíruje ho po websocketu jako fMP4 |
| `sky-live` | ověřuje lístky a skládá go2rtc konfigurák podle portálu |
| `caddy` | dveřník — pustí tři cesty, zbytek odmítne |

### Porty 80 a 443 nám nepatří

Má je Caddy Constructivy (`/opt/cam-relay`), který obsluhuje
`cam.constructiva.cz`. Dva Caddy o tytéž porty soupeřit nemůžou, takže
ten náš poslouchá jen uvnitř sítě kontejnerů a veřejnou adresu mu
předává ten první.

Rozdělení práce je schválně takhle, a ne obráceně:

| | co drží |
|---|---|
| Caddy Constructivy | TLS, certifikát, jeden blok „pošli to dál“ |
| `sky-caddy` | **kdo smí a kam** — allowlist cest a ověření lístku |

Bezpečnostní rozhodnutí tím zůstávají v tomhle repozitáři. Kdyby
allowlist bydlel v konfiguraci Constructivy, měnil by se v repozitáři,
který o Sky Guardu nic neví — a při jeho příštím nasazení by se změna
ztratila, **aniž by to někdo poznal**.

Propojení je jediná sdílená síť, `sky-guard-edge`. Je na ní **jen
dveřník**: go2rtc na ní není, takže se na jeho administraci nedá dostat
ani z kontejnerů Constructivy.

### Co potřebuje repozitář Constructivy

Dvě věci, obojí **v jejím repozitáři**, ne ručně na serveru — ruční
úprava by se při příštím nasazení přepsala a živý obraz by tiše přestal
fungovat.

1. Blok do Caddyfile — hotový k vložení je v
   [`constructiva-kamery.caddy`](constructiva-kamery.caddy):

   ```
   kamery.sky-guard.cz {
       reverse_proxy sky-caddy:80
   }
   ```

2. Její Caddy musí na sdílenou síť vidět:

   ```yaml
   services:
     caddy:
       networks: [cam, sky-guard-edge]
   networks:
     sky-guard-edge:
       external: true
   ```

Ten blok je schválně hloupý a **nikdy se nebude měnit**: žádná pravidla,
žádné cesty, žádná tajemství. Když Sky Guard přidá kameru nebo změní
ověřování, tohle zůstane, jak je.

> **Hotovo** — zaneseno v `constructiva-portal`, commit `f53ba0e`.
> Nasadit se to musí zvlášť, jejich vlastním rsync + `docker compose up`.

Síť **nepatří ani jednomu compose projektu** a zakládá se jednou ručně:

```bash
docker network create sky-guard-edge
```

`external: true` je na obou stranách schválně. Kdyby ji zakládal jeden
z nich, nenaběhl by ten druhý, dokud neběží první — a Constructiva
nesmí záviset na Sky Guardu. Takhle na sobě nezávisí; chybí-li síť,
řeknou to oba hlasitě při nasazení.

Ověření z VPS, bez veřejné adresy:

```bash
curl -i -H 'Host: kamery.sky-guard.cz' http://127.0.0.1:8880/zdravi
```

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

### Portál je na jiné doméně než stream

`kamery.sky-guard.cz` proti `sky-guard-portal.vercel.app` — pro
prohlížeč je to požadavek přes původy a go2rtc ho na websocketu odmítne
standardní kontrolou:

```
websocket: request origin not allowed by Upgrader.CheckOrigin
```

Řeší to Caddy: hlavičku `Origin` přepíše na vlastního hostitele
(`header_up Origin http://{host}`). Protože se `Host` nikam nepřepisuje
a `Origin` se odvozuje z téže hodnoty, jsou vždycky shodné — platí to
i pro náhledová nasazení portálu na měnících se adresách, které by se
do pevného seznamu vypsat nedaly.

**Díru to nedělá.** O přístupu nerozhoduje `Origin`, ale lístek, a ten
cizí stránka nezíská: vydává ho portál proti přihlášení a odpověď si
přes původy nepřečte. Kontrola původu by tedy nebránila ničemu, co by
lístek nezastavil dřív.

> Kdyby ten přepis nestačil, je úniková cesta `GO2RTC_ORIGIN=*`
> v `.env` — povolí to rovnou v go2rtc, jak to má Constructiva. Je to
> volnější (platí pro celé go2rtc, ne jen pro cesty, které pouští
> dveřník), tak jen když je potřeba.

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
LIVE_HOSTNAME        jen pro samostatný běh (viz Caddyfile); za Caddy
                     Constructivy se nepoužívá
CAMERA_USERNAME      admin
CAMERA_PASSWORD      heslo ke kamerám, pro všechny stejné
RTSP_MAIN_PATH       nepovinné, výchozí /cam/realmonitor?channel=1&subtype=0
RTSP_SUB_PATH        nepovinné, výchozí /cam/realmonitor?channel=1&subtype=1
RTSP_PORT            nepovinné, výchozí 554
GO2RTC_ORIGIN        nepovinné, prázdné; `*` jen jako úniková cesta
                     ke kontrole původu (viz výš)
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
je CSP nastavená jakkoli. Dokud `kamery.sky-guard.cz` nemíří na VPS:

- **Na doladění RTSP cest** stačí SSH tunel na `127.0.0.1:8880`
  a `curl` s hlavičkou `Host:`. Portál do toho tahat nemusíš.
- **Na zkoušku celého řetězu** je potřeba doména — bez ní nemá Caddy
  Constructivy podle čeho ten provoz rozeznat, protože se rozhoduje
  právě podle jména v požadavku.

## Test

Celý řetěz proti **falešnému portálu**, bez VPS a bez Sky Guardu:

```bash
python3 infra/sky-watcher/test/test_watcher.py
python3 infra/sky-watcher/test/test_events.py
python3 infra/sky-watcher/test/test_live.py
python3 infra/sky-watcher/test/test_md2html.py
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
