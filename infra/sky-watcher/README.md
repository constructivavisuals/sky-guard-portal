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

## Archiv je na kartě, do Hetzneru jde jen důkaz

Kamera natáčí 24/7 na vlastní SD kartu a přepisuje ji dokola. Klient se
podívá týden zpátky **přímo z karty** přes RTSP playback — stejnou
cestou, jakou používá DMSS. Průběžný archiv se nikam neodesílá.

Do Hetzneru odchází jediná věc: **krátký klip kolem každé detekce**.
To je důkaz, a ten musí přežít i krádež kamery.

```
kamera ─ SD karta 24/7 ─┬─ playback RTSP ──> sky-playback ──> divák
                        └─ klip u detekce ──> sky-klipy ────> Hetzner
```

Co to znamená: bez internetu kamera natáčí dál a záznam se dožene, až
se linka vrátí. Co to nezvládne: když kameru někdo ukradne, zůstanou
z ní jen klipy u detekcí. Byl to vědomý obchod — viz historii rozhodnutí
níž.

### Změřeno na místě

Tohle rozhodlo o všem ostatním. Měřeno přes tunel na skutečné kameře:

| | výsledek |
|---|---|
| živý hlavní proud (4K) | **rozpadlý** |
| živý vedlejší proud | čistý |
| playback hlavní proud | **rozpadlý** |
| playback vedlejší proud | čistý (s `-rtsp_transport tcp`) |
| vedlejší proud přes UDP | **rozpadlý** |

Dva závěry, oba se propisují do kódu:

**Hlavní proud přes tunel neprojde.** Není to kodek ani kontejner, je to
objem dat. Vedlejší proud proto obsluhuje živý obraz, přehrávání
i klipy — a musí se nastavit na nejvyšší rozlišení, které linka utáhne
(viz MONTAZ.md; D1 už nestačí).

**Vždycky TCP.** UDP při ztrátě paketu nic neopakuje a přes tunel se
pakety ztrácejí. Obraz z toho vyjde rozsypaný, ale proud vypadá platně
— tatáž třída závady jako dělené snímky v DHAV. `ffplay` i `ffmpeg`
jedou UDP jako výchozí, takže se to musí říct pokaždé.

Playback URL, která funguje:

```
rtsp://<kamera>/cam/playback?channel=1&subtype=1&starttime=...&endtime=...
```

Čas je **místní podle kamery**, ne UTC, a `endtime` zabírá.

### Vlastní instance go2rtc

Přehrávání má svou (`sky-go2rtc-playback`), oddělenou od živého obrazu.
Důvod je v `live.py`: ta při každé změně seznamu kamer přepíše
konfigurák a zavolá `/api/restart`. U živého obrazu to znamená vteřinu
bez obrazu, u přehrávání konec každého běžícího sezení.

Proudy se do ní zakládají **za běhu**, přes `PUT /api/streams`, vždy na
jeden konkrétní čas. Jméno proudu ten čas nese:

```
<sériové číslo>-pb-<epocha UTC>
```

Tím se nemusel měnit lístek: `live.overit_listek` podepisuje jméno
proudu, takže lístek na 14:00 nejde použít na 3:00 — je to jiné jméno
a podpis nesedí. Kdyby šel čas zvlášť jako parametr, otevřel by jeden
lístek celý týden.

Proud bez diváka se po minutě ruší, ale ne hned: při posunu na časové
ose se prohlížeč na chvíli odpojí a okamžité rušení by znamenalo nové
spojení na kameru po každém šťouchnutí.

Vynucení TCP jde přes `ffmpeg:` zdroj, protože nativní RTSP klient
go2rtc přepínač transportu **nemá** (`#transport=` umí jen WebSocket).

Výchozí chování ale nestačí: šablona `rtsp` v go2rtc má
`-rtsp_flags prefer_tcp`, což TCP jen **preferuje** a při potížích
spadne na UDP — tedy přesně tam, kde se obraz rozpadá. Proto vlastní
vstupní šablona v `playback-config/go2rtc.yaml`:

```yaml
ffmpeg:
  playback: "-fflags nobuffer -flags low_delay -timeout {timeout} -user_agent go2rtc/ffmpeg -rtsp_transport tcp -i {input}"
```

a zdroj se na ni jen odkáže:

```
ffmpeg:rtsp://...#input=playback
```

Pojmenovaná šablona, ne argumenty psané rovnou do adresy, ze dvou
důvodů: zdroj pak nemá mezery ani složené závorky, které se při dvojím
průchodu kódováním (jednou do API, podruhé při rozboru `#` parametrů)
můžou rozejít — a v logu je vidět `#input=playback` místo změti.

Zbytek šablony je opsaný z výchozí schválně. `-timeout` je to, co
odpojí mrtvou kameru místo věčného čekání; vlastní šablona ho jinak
tiše zahodí.

**Když go2rtc odmítne PUT, důvod je v TĚLE odpovědi**, ne v hlavičce
(`http.Error(w, err.Error(), 400)`). `playback.py` ho proto čte
a dává do logu — bez něj je z toho holé „400" a hádá se, jestli je
špatně adresa, šablona, nebo zápis do konfiguráku.

### Klipy kolem detekcí

`events.py` po odeslané detekci položí úkol do fronty (adresář se
soubory JSON, sdílený svazek). `klipy.py` počká, až kamera úsek dopíše
na kartu, a vytáhne ho **z karty přes playback** — tedy včetně toho, co
bylo *před* detekcí.

Proto z karty a ne ze živého obrazu: ze živého jde nahrát jen to, co
teprve přijde, a to zajímavé se stane pár vteřin předtím, než kamera
člověka pozná. Zachytit to živě by znamenalo držet trvalé spojení na
každou kameru — přesně ten trvalý tok, kterého se tahle architektura
zbavuje.

Když playback nevyjde, je záchrana: klip se vezme ze živého vedlejšího
proudu dopředu. Přijde se o pre-roll, ale důkaz zůstane. Hlásí se to
jako varování — je to zhoršený stav, ne rovnocenná cesta.

### Portálová strana

Hotová. Lístky vydává `/api/kamery/<id>/zaznam?od=<ISO čas>` a časová
osa je na `/osa`.

Lístek se vydává **týmž kódem** jako na živý obraz — jen na jiné jméno
proudu. Ověřuje ho `playback.py`, které si `overit_listek` importuje
z `live.py`, takže se ty dvě strany nemají jak rozejít. Hlídá to
`npm run hranice-listek`, kde je mezi případy i lístek na jeden čas
zkoušený na jiný.

Přehrávač je jedna komponenta pro obojí (`src/app/(app)/prehravac.tsx`):
rozdíl mezi „teď“ a „minulý čtvrtek ve tři“ je jen v tom, odkud si vzít
lístek. Skládání obrazu je stejné, protože go2rtc posílá v obou
případech totéž.

Časová osa má **skoky, ne táhlo**. Je to úmyslné: každý posun znamená
zavřít proud a otevřít nový, tedy nové spojení na kameru a čekání na
klíčový snímek. Táhlo by slibovalo plynulost, kterou pod ním nikdo
nemá.

**Volba `main` v živém obrazu zmizela.** Podle měření je hlavní proud
přes tunel nepoužitelný, takže nabízet „Detailní“ znamenalo nabízet
rozbitý obraz. Relay proud `<sériové>` pořád generuje — go2rtc se ke
kameře připojí až když si o něj někdo řekne, takže nepoužitý nic
nestojí — ale lístek se na něj nevydává, takže je nedosažitelný.

### Co ještě zbývá

- **FTP se dá vypnout.** Klipy teď chodí z karty, takže pohybové
  nahrávání na FTP je nadbytečné. Watcher zatím zůstává kvůli starým
  souborům a jako záchrana.
- **Caddyfile** se nepodařilo ověřit `caddy validate` — na stroji, kde
  se to psalo, nebyl Docker. Ověřit při nasazení.
- **`PLAYBACK_REACH_DAYS`** v portálu (výchozí 7) musí sedět s tím, co
  karta doopravdy drží. Je to jen mez pro časovou osu, ne pravda o
  kartě — postup výpočtu je v MONTAZ.md.

### Když se proud založí a nic se nepřehraje

Signatura: lístek se vydá, `sky-playback` hlásí „Přehrávání otevřeno",
websocket vrátí 101 — a obraz nenaskočí.

Znamená to, že se **nedokončilo vyjednání kodeků**. Prohlížeč posílá
po otevření socketu `{"type":"mse","value":"avc1…"}` a teprve na to
go2rtc rozjede zdroj. Bez toho spojení drží a neteče přes něj nic;
`prehravac.tsx` to má u sebe popsané, protože se na tom už jednou
pálilo.

Rozhodne to jeden pohled do **DevTools → Network → WS → Messages**:

- **žádná odchozí zpráva** → vada je v prohlížeči, ne na relayi;
- **zpráva odešla a nic se nevrátilo** → vada je za go2rtc; zvedni
  `log: level` v `playback-config/go2rtc.yaml` na `debug`, jinak
  o startu zdroje nic nenapíše.

Nejzrádnější příčina je **chybějící vstupní šablona**. go2rtc na ni
neupozorní: neznámé jméno vrátí beze změny a `{input}` v něm nemá co
nahradit, takže ffmpeg dostane jako celý vstup slovo `playback` — bez
`-i` a bez adresy. Proud se přesto založí a websocket naváže.
`sky-playback` proto při startu čte `GET /api/config` a chybějící
šablonu hlásí jako ERROR.

### Co změřit na místě

Adresa playbacku funguje, ale zbytek ne. Před ostrým provozem:

1. Jak dlouho trvá od otevření proudu k prvnímu snímku? To je cena
   jednoho posunu na časové ose.
2. Kolik současných přehrávání kamera unese, aniž by trpěl živý obraz?
   Strop je v `PLAYBACK_MAX_STREAMS`, výchozí 12 je odhad.
3. Co udělá proud, když dojede na `endtime`? Očekává se, že ho go2rtc
   uvidí jako odpojený zdroj a připojí se znovu od `starttime` — tedy
   skok na začátek. Okno je proto 4 hodiny (`PLAYBACK_WINDOW_SEC`).

## Když se záznam nepřehraje v prohlížeči

```bash
python3 infra/sky-watcher/diagnostika.py zaznam.mp4 --zdroj original.dav
```

Vezme hotové `.mp4` z úložiště a řekne, proč ho přehrávač odmítá:
kodek, tag, profil, level, rozlišení, pozice `moov` a hlavně **kde leží
parametry streamu** (VPS/SPS/PPS).

**Kamery nahrávají H.264** a je to jediný podporovaný stav. `avc1` je
jeho obvyklý kód, přehraje ho každý prohlížeč a ffmpeg u něj parametry
streamu (SPS/PPS) nechává **i ve vzorcích** — ověřeno. Nemá se tedy co
ztratit, ani když je kamera mění za běhu.

Platí se za to zhruba dvojnásobným datovým tokem oproti H.265.

### H.265 se vzdalo — co se u něj zkusilo

Ať se to nevymýšlí znovu. Problém: `-tag:v hvc1` parametry ze vzorků
**vyhodí** a nechá jen ty první v `hvcC`, takže se ztrácejí jejich
změny za běhu.

| Pokus | Výsledek |
|---|---|
| `hev1` (parametry ve vzorcích) | Chrome ano, **Safari a iOS ne** |
| `hvc1` (parametry v `hvcC`) | Safari ano, **Chrome `-12909`** |
| přepis kódu po přebalení (`hvc1` + parametry ve vzorcích) | syntetické vzorky prošly, **reálný záznam rozpadlý obraz** — je to mimo ISO/IEC 14496-15 |
| `-bsf:v hevc_mp4toannexb` | **žádný účinek** |
| `hvc1` + Smart Codec vypnutý + I-frame 15 + ffmpeg 7.1.5 | **`-12909` i na iPhonu** |

K tomu filtru: převádí z `hvcC` do Annex-B, jenže `.dav` už Annex-B je,
takže se neuplatní — ffmpeg to i řekne (`The input looks like it is
Annex B already`) a výstup vyšel bajt po bajtu shodně jako bez něj.

Poslední řádek tabulky to uzavřel: padalo to i tam, kde `hvc1` předtím
hrálo. Podezření se tím posunulo od tagu k samotnému přebalení `.dav`
— a tam taky bylo, viz [Zvuk shazoval remux](#zvuk-shazoval-remux).
Celá tahle tabulka měřila následek, ne příčinu: soubory z ní vůbec
neprošly cestou přes rozpoznaný kontejner.

**HEVC větev ve watcheru zůstává jen pro staré soubory** z SD karet.
Když přijde záznam v H.265, watcher to napíše do logu jako varování —
po přepnutí kamer to znamená buď starý soubor, nebo kameru, kterou
někdo zapomněl přepnout.

**Relay nikdy nepřekódovává** — devět kamer nepřetržitě by z VPS
udělalo překódovací farmu.

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

### Websocket se naváže, ale nic neteče

Status 101 a `size: 0` znamená, že si klient s go2rtc nerozuměl
v prvním kroku. Protokol je jednoduchý a **záleží na pořadí**:

```
1. otevře se websocket                    (klient → /api/ws?src=…)
2. TEPRVE PAK vzniká MediaSource
3. na `sourceopen` klient pošle kodeky     {"type":"mse","value":"avc1…"}
4. go2rtc odpoví MIME typem                {"type":"mse","value":"video/mp4; codecs=…"}
5. a pak už tečou binární fragmenty
```

Body 1 a 2 se nesmí prohodit. `sourceopen` je lokální událost a vyfiří
okamžitě, kdežto websocket potřebuje kolo po síti — odeslání kodeků
z `sourceopen` by tedy proběhlo ještě ve stavu `CONNECTING`, `send()`
by vyhodil `InvalidStateError` a go2rtc by se nikdy nedozvěděl, co má
poslat. **Navenek to vypadá jako zdravé spojení**, jen přes něj nic
neteče.

Kde se to hledá:

```bash
# obraz z kamery vůbec — obchází celý MSE
curl -s -o /dev/null -w '%{http_code} %{size_download}\n' \
  'http://127.0.0.1:8880/api/frame.jpeg?src=<SERIAL>_sub&token=<lístek>'
```

Když tohle vrátí JPEG o desítkách kB, RTSP i přihlášení ke kameře jsou
v pořádku a chyba je na websocketu, ne u kamery.

### Záznam se nepřehraje, ale živý obraz z téže kamery ano

To je silná stopa: dekodér prohlížeče ten obsah **umí** — 4K H.265
přes MSE z go2rtc jede. Rozdíl je v tom, co z `.dav` vyrobí přebalení,
ne v kodeku ani v rozlišení.

Nejpodezřelejší je, **kterým pokusem** se soubor přebalil. `.dav` je
kontejner (DHAV); když ho ffmpeg rozpozná, dostane obraz i časování.
Když se musí vnutit `-f hevc`, čte se soubor jako holý Annex-B —
rámování kontejneru se pak bere jako obrazová data a časové značky
nejsou vůbec. **Takový remux skončí úspěšně** a vyrobí MP4, které se
tváří platně, ale dekodér z něj skládá nesmysl.

Watcher to od teď hlásí:

```bash
docker compose logs sky-watcher | grep -E 'VNUTIT|nesedí|použitelnou délku'
```

- `Remux musel VNUTIT formát` → kontejner se nerozpoznal, soubor je
  podezřelý
- `Délka přebaleného souboru nesedí` → rozbité časování; délka se
  porovnává s rozsahem, který kamera píše do názvu souboru

Když je log čistý a záznam se přesto nepřehraje, na řadě je porovnání
souboru: `diagnostika.py` na staženém MP4 a proti němu segment
z go2rtc.

### Zvuk shazoval remux

To byla ta příčina. Kamera nahrává i zvuk, a to jako `pcm_alaw` —
kodek, který se do MP4 zabalit **nedá**. Bez `-an` proto první pokus
o přebalení (rozpoznaný kontejner DHAV) skončil chybou:

```
Could not find tag for codec pcm_alaw in stream #1
```

Watcher to ale nevzdal: sáhl po záchranném `-f h264`, které soubor
čte jako holý Annex-B. Ten pokus **projde** a vyrobí MP4 bez časování
a s rámováním kontejneru v obraze. Tak vznikal ten rozpadlý obraz
i `-12909`, a proto to vypadalo jako vada kodeku — cestou přes
rozpoznaný kontejner ani jeden z těch souborů nešel.

Ověřeno protipokusem: 30 s odebraných přímo z RTSP téže kamery se
`-c copy` do MP4 (4K, H.264, `avc1`) hraje v Chrome bez potíží. Právě
u něj bylo taky potřeba `-an` — se stejnou hláškou.

Watcher teď zvuk zahazuje rovnou (`-an`) a obraz se přebaluje
z kontejneru, jak má. Nic se tím neztrácí: zvuk se v portálu
nikde nepřehrává. Hlídá to `test/test_watcher.py` — bez `-an` ten
test neprojde.

To ale byla jen první ze dvou vad. Po ní záznam prošel rozpoznaným
kontejnerem a **pořád se nepřehrál** — viz dál.

### Dělené snímky: demuxer DHAV je neskládá zpátky

Tohle byla ta druhá vada a příčina rozpadlého obrazu.

Kamera velký snímek — u 4K typicky I-snímek — rozdělí do několika
úseků kontejneru. Mají stejné číslo snímku a rostoucí **podčíslo**.
Jenže `libavformat/dhav.c` podčíslo načte a víc s ním neudělá nic:

```c
dhav->frame_subnumber = avio_r8(s->pb);   // a dál nikde
```

Z každého úseku tedy vznikne samostatný paket a z něj samostatný
vzorek MP4. Dekodér dostane půlku řezu:

```
error while decoding MB 54 16, bytestream -5
```

Soubor přitom vypadá zdravě: jedna stopa, `avc1`, 3840×2160, správný
počet snímků, délka sedí, časové značky sedí. Rozbitá jsou **jen
obrazová data**. Proto to tak dlouho vypadalo na kodek — a proto RTSP
nahrávka z téže kamery hraje: ta přes DHAV vůbec nejde.

`read_chunk`, `dhav_read_packet` i `parse_ext` jsou v ffmpegu 5.1
(běží na relayi) a v současném masteru bajt po bajtu **stejné**.
Upgrade s tím tedy nepohne.

#### Oprava: dvoufázový remux

```
.dav ──[fáze 1: demuxer DHAV]──> holý Annex-B ──[fáze 2]──> MP4
```

Ve druhé fázi se stream rámuje podle **startovacích značek**, ne podle
paketů kontejneru — a tím se rozdělené kusy složí zpátky do celých
snímků. Roury se propojují přímo, takže se nikde nedrží celý záznam
v paměti.

Druhá fáze potřebuje `-r`: holý Annex-B žádné časování nenese a ffmpeg
by jinak dosadil svých 25/1. Frekvence se bere z `avg_frame_rate`, což
u DHAV pochází z pole `0x81` rozšířené hlavičky, tedy od kamery.
(`r_frame_rate` je odhad z časových značek a vychází dvojnásobný.)

Ověřeno: obrazový stream z opraveného souboru je **bajt po bajtu
shodný** s tím z nedělené předlohy. Nic se neztrácí ani nepřidává.

Přímé přebalení zůstává jako záchrana, když dvoufázový remux selže —
lepší vadný záznam než žádný.

#### Rozbor konkrétního souboru

```bash
python3 infra/sky-watcher/dav-rozbor.py zaznam.dav
```

Čte DHAV **nezávisle na ffmpegu** a řekne, co v souboru je: rozpis
typů úseků, kolik snímků je dělených, jestli sedí rámování, a nakonec
porovná svoje čtení s tím, co z téhož souboru vyleze demuxeru ffmpegu.

Hledá dvě věci, obě vidět ve zdrojáku demuxeru:

| Nález | Co to znamená |
|---|---|
| úseky nezačínající startovací značkou | dělené snímky, demuxer je neskládá — viz výš |
| úseky jiného typu než `0xfd`/`0xfc`/`0xf0` | spadnou do obrazové stopy, protože demuxer posílá do obrazu všechno, co není `0xf0` |

Vadu umí vyrobit i test: `test_delene_snimky` postaví syntetický DHAV
s dělenými snímky, ověří, že přímé přebalení je rozbité, a že watcher
z něj přesto složí týž stream jako z nedělené předlohy.

### Změna nezabrala? Nejdřív ověř, že vůbec dorazila

Skoro pokaždé jde o to, že nová hodnota **není v běžícím kontejneru** —
ne o to, že by byla špatně. `.env` se čte při VYTVOŘENÍ kontejneru,
`Caddyfile` je bind mount z disku serveru, a go2rtc si konfiguraci čte
při startu. Restart samotný ani jedno nepřenačte.

```bash
# 1. Vidí služba proměnnou? První řádek logu vypisuje nastavení.
docker compose logs sky-live | head -1

# 2. Má Caddy v kontejneru NOVÝ soubor? (bind mount ze serveru)
docker exec sky-caddy grep -c 'header_up Origin' /etc/caddy/Caddyfile

# 3. Vygenerovala se konfigurace, jak má?
docker exec sky-go2rtc head -8 /config/go2rtc.yaml

# 4. Přečetl si ji go2rtc? Zápis sám nestačí.
docker compose logs sky-live | grep -i 'restart go2rtc'
```

Když něco nesedí, v tomhle pořadí:

```bash
# soubory z repa na server (BEZ .env — to žije jen tam)
rsync -av --exclude '.env' --exclude 'live-config' \
  infra/sky-watcher/ root@49.13.69.91:/opt/sky-watcher/

# a teprve pak. --force-recreate kvůli .env: samotné `up -d`
# u změny proměnných kontejner nemusí přestavět.
docker compose up -d --force-recreate sky-live caddy
docker compose restart go2rtc
```

> `docker compose restart` **nestačí** na změnu v `.env` — restartuje
> týž kontejner s týmž prostředím. A `--force-recreate` zase nepomůže,
> když nový `Caddyfile` na serveru vůbec není: kontejner se přestaví
> nad starým souborem.

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
