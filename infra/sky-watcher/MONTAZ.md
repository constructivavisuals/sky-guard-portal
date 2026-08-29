# Montáž stavební kamery

Postup pro nasazení nové FTP kamery — Klanečná, Mírovka a další. Kamery
zatím jedou na DMSS a do žádného portálu neposílají; **nasazuje se
nanovo, nic se nepřepojuje.**

Pořadí není libovolné: watcher kameru dohledá podle sériového čísla,
takže **musí být v portálu dřív, než kamera pošle první soubor.** Když
není, soubor skončí v `failed/` a musí se tam pro něj ručně.

---

## Než vyjedeš — co připravit v portálu

### 1. Lokalita

*Areály → Přidat lokalitu.*

| Pole | Klanečná / Mírovka |
|---|---|
| Název | Klanečná |
| Časové pásmo | Europe/Prague |
| **Co lokalita má** | ✅ Kamery, ❌ Dron |
| Okno střežení | vyplň skutečné (formulář ho vyžaduje) |
| Cooldown | 900 |
| Retence záznamů | 90 |
| Výška návratu | 60 (bez dronu se nepoužije) |
| Sériové číslo doku | **prázdné** |

Odškrtnutý dron je to podstatné: bez něj z menu zmizí Zásahy, Lety,
Hlídky i stav doku a na přehledu nebudou dlaždice, které pro stavbu
nedávají smysl.

### 2. Kamera

*Areály → lokalita → Kamery → Přidat kameru.*

| Pole | Hodnota | Proč |
|---|---|---|
| Název | Jeřáb / Vjezd… | jen pro lidi |
| **Sériové číslo** | z výrobního štítku | **podle tohohle watcher kameru pozná** |
| **Způsob příjmu** | FTP přes relay | jinak portál ohlášení odmítne (409) |
| Účet na relayi | viz níž | evidence, kdo se kam přihlašuje |
| **Adresa v síti (`lan_ip`)** | např. `192.168.11.51` | **bez ní kameře nepřijdou detekce** — služba událostí na ni nemá kudy |
| Zóna | **žádná** | ze stavební kamery zásah nevzniká |
| Schopnosti | nechat prázdné | u FTP kamery se nepoužívají |
| Stav | Offline | přepne se sám, až kamera pošle první soubor |

> **Adresu vyplň hned**, i když ji zjistíš až na místě. Bez ní kamera
> posílá záznamy, ale nehlásí, že někdo vlezl na stavbu — a to je
> nenápadné selhání: v portálu se tváří živá, protože záznamy chodí.

> **Sériové číslo musí sedět PŘESNĚ**, včetně velkých písmen. Opsat ze
> štítku, ne z paměti. Kamera ho posílá v cestě k souboru a portál
> hledá přesnou shodu — `BK024AAPAGB5592` a `bk024aapagb5592` jsou dvě
> různé kamery.

### 3. FTP účet na relayi

Na serveru `49.13.69.91`, v `/opt/cam-relay/.env`, proměnná `USERS`.
Formát je `účet|heslo|uid|gid`, položky oddělené mezerou.

**Účet pojmenuj sériovým číslem kamery.** Není to kosmetika: watcher
bere jako identifikaci zařízení ten adresář, který je **těsně před
adresářem s datem**. U některých firmwarů je to složka, kterou si
kamera založí sama (sériové číslo), u jiných je to rovnou kořen účtu.
Když se účet jmenuje stejně jako sériové číslo, vyjde to správně
v obou případech.

```bash
ssh root@49.13.69.91
cd /opt/cam-relay
$EDITOR .env                      # přidat účet do USERS
docker compose up -d ftp          # samotný restart změnu USERS nepromítne
```

### 4. Watcher

Jestli ještě neběží:

```bash
rsync -av --exclude '.env' --exclude 'failed' \
  infra/sky-watcher/ root@49.13.69.91:/opt/sky-watcher/
ssh root@49.13.69.91
cd /opt/sky-watcher
cp .env.example .env && $EDITOR .env     # PORTAL_URL, RELAY_SECRET
docker compose up -d --build
docker compose logs -f sky-watcher       # čekej „Sky Guard watcher: …“
```

### 5. FTP zvenčí

**Tohle je nejčastější důvod, proč první pokus nedorazí.** Za normálního
provozu je FTP vázané jen na `127.0.0.1` a kamera na něj z internetu
nedosáhne. Než bude tunel, musí se otevřít — a nestačí porty, musí se
změnit **dvě** věci v `/opt/cam-relay/docker-compose.yml`:

```yaml
    ports:
      - "0.0.0.0:21:21"                    # místo 127.0.0.1:21:21
      - "0.0.0.0:21000-21010:21000-21010"  # pasivní rozsah taky
    environment:
      ADDRESS: 49.13.69.91                 # místo 127.0.0.1
```

`ADDRESS` je to, co server ohlásí v odpovědi na `PASV`. Když zůstane
`127.0.0.1`, kamera se pro datový kanál pokusí připojit sama na sebe
a přenos spadne — **přihlášení přitom projde**, takže to vypadá jako
úplně jiná chyba.

```bash
docker compose up -d ftp          # restart změnu portů nepromítne
```

> **FTP posílá heslo v plaintextu a publikovaný port obchází ufw.**
> Docker si pravidla vkládá před ufw, takže port je otevřený i když
> `ufw status` o něm neví. Když je veřejná IP stavby pevná, omez zdroj:
>
> ```bash
> iptables -I DOCKER-USER -p tcp --dport 21 ! -s <IP-stavby> -j DROP
> ```

---

## Na místě — nastavení kamery

Webové rozhraní kamery, *Nastavení → Úložiště → Cíl → FTP*:

| Položka | Hodnota |
|---|---|
| Server | `49.13.69.91` |
| Port | `21` |
| Uživatel | účet z kroku 3 (= sériové číslo) |
| Heslo | z kroku 3 |
| Cesta k adresáři | **prázdná** (`/`) — účet je chrootovaný |
| Anonymní přihlášení | vypnuto |

Pak *Nastavení → Úložiště → Plán* nebo *Rozvrh nahrávání*:

- **Typ záznamu: pohyb (Motion).** Kontinuální nahrávání na FTP zaplní
  linku i úložiště a k ničemu není — na stavbě je zajímavý pohyb.
- Doba před/po události: 5 s / 10 s.
- Ujisti se, že cíl je **FTP**, ne jen SD karta. Některé firmwary mají
  cíl zvlášť pro záznam a zvlášť pro snímky.

**Vedlejší stream, ne hlavní.** Nativní rozlišení Dahuy (4480×2512) je
nad hardwarovým dekodérem iPhonů — video se uloží, ale na telefonu se
nepřehraje. Nastav pro FTP záznam `sub stream`.

### Kodek: H.265, a Smart Codec vypnutý

*Nastavení → Kamera → Video → Kódování* (Encode):

| Položka | Hodnota |
|---|---|
| Komprese | **H.265** (HEVC) |
| Smart Codec (H.265+) | **vypnuto** |
| Profil | Main |

**Proč H.265.** Kvůli objemu. H.264 by datový tok zhruba zdvojnásobil
a upload na Klanečné je na hraně — a při 14denní lhůtě by to znamenalo
i dvojnásobek místa proti stropu lokality
(`recording_quota_bytes`, výchozí 500 GB).

Za H.265 se ale platí tím, že se v MP4 musí rozhodnout, kam přijdou
parametry streamu, a ani jedna obvyklá možnost nevyhoví oběma stranám:

| | Chrome / desktop | Safari / iPhone |
|---|---|---|
| `hev1` — parametry u každého vzorku | ano | **ne** |
| `hvc1` — jen v hlavičce `hvcC` | **ne** | ano |

Relay proto skládá **třetí variantu**: přebalí soubor bez tagu (takže
parametry zůstanou u každého vzorku) a pak přepíše jen čtyřznakový kód
stopy na `hvc1`. Dekodér tak dostane víc než u kterékoli čisté varianty.
Nastavuje se to proměnnou `HEVC_TAG` na relayi, ne v kameře.

> **Tahle varianta je mimo specifikaci** a ověřuje se. Kdyby se
> ukázalo, že ji některý přehrávač odmítá, záložní plán je přepnout
> kamery na **H.264** — ten přehraje každý prohlížeč a celá tahle úvaha
> u něj nevzniká. Než k tomu dojde, ptej se, co zrovna platí.

**Proč vypnout Smart Codec.** To je funkce, kvůli které kamera mění
parametry kódování za běhu. Přesně na tom se lámalo přehrávání v Chrome
a dokud není třetí varianta ověřená, není důvod to riziko podstupovat.
Až ověřená bude, dá se Smart Codec zapnout zpátky a ušetřit další
objem — je to jedna z prvních věcí, kterou pak zkusit.

Záznamy pořízené dřív, kdy se vynucoval `hvc1`, se opravit nedají:
parametry se při přebalení ztratily a v souboru nejsou. Odejdou lhůtou
(14 dní).

### Detekce člověka (SMD)

*Nastavení → Událost → Chytrá detekce pohybu* (Smart Motion Detection):

| Položka | Hodnota | Proč |
|---|---|---|
| Povolit | zapnuto | bez toho kamera žádnou událost nehlásí |
| Cíl | **Člověk** | vozidlo na stavbě je bagr, ne poplach |
| Citlivost | střední | vyšší chytá i déšť a světla aut |

Do FTP ani na SD kartu se kvůli tomu nic nastavovat nemusí — události
si bere služba `sky-events` po vlastním spojení, ne přes záznam.

**Vyzkoušej to hned na místě**: projdi se před kamerou a nech běžet
log (viz Ověření níž). Kód události se u každého modelu jmenuje jinak
a tohle je jediný spolehlivý způsob, jak zjistit ten správný.

Nakonec v kameře *Test* / *Ověřit připojení* — kamera řekne, jestli se
přihlásila. To **neznamená**, že projde přenos dat; viz `ADDRESS` výš.

---

## Ověření, že záznam dorazil

Projdi to odspodu nahoru — každý krok říká, kde to případně vázne.

### 1. Přišel soubor na relay?

```bash
ssh root@49.13.69.91
ls -R /opt/cam-relay/ftp-inbox/ | head -30
```

Čekáš `<účet>/2026-08-28/001/dav/…/HH.MM.SS-HH.MM.SS[M][0@0][0].dav`.

- **Nic tam není** → kamera se nepřipojila. Zkontroluj
  `docker compose logs ftp` na relayi: přihlášení uvidíš i při
  selhaném přenosu.
- **Přihlášení ano, soubor ne** → pasivní rozsah nebo `ADDRESS`.

### 2. Zpracoval ho watcher?

```bash
cd /opt/sky-watcher && docker compose logs -f sky-watcher
```

Čekáš dva řádky:

```
Remux OK: <účet>/2026-08-28/… (2.4 MB)
Hotovo: <účet>/2026-08-28/… → 8f3c…
```

Když místo toho vidíš:

| Hláška | Co to znamená |
|---|---|
| `portál odpověděl 404` | kamera v portálu není, nebo nesedí sériové číslo |
| `portál odpověděl 409` | kamera je vedená jako podepsaná, ne FTP |
| `portál odpověděl 401` | nesedí `RELAY_SECRET` |
| `Nečitelná cesta` | kamera posílá jiný tvar cesty, pošli mi příklad |
| `portál teď nejde` | výpadek — soubor zůstane ležet a zkusí se znovu |

Odmítnuté soubory najdeš v `/opt/sky-watcher/failed/`. **Nemažou se** —
až se příčina spraví, dají se vrátit zpátky do inboxu:

```bash
cp -r /opt/sky-watcher/failed/<účet> /opt/cam-relay/ftp-inbox/
```

### 3. Je záznam v portálu?

Otevři *Areály → lokalita → Kamery*. Kamera musí mít vyplněné
**„naposledy viděna"** — to razítko píše portál při každém ohlášení,
takže je to nejrychlejší důkaz, že řetěz šlape.

### 4. Jde video přehrát?

*Záznamy* v menu (objeví se jen na lokalitě, která má kamery). Seznam
je nejnovější první a ukazuje čas, kameru se sériovým číslem, typ
události, velikost a stav:

| Stav | Co znamená |
|---|---|
| **Nahráno** | soubor je v úložišti a portál si jeho velikost ověřil — tohle je ten definitivní důkaz |
| **Přenáší se** | ohlášení prošlo, nahrání ne. Podívej se do logu watcheru |
| **Bez souboru** | řádek bez cesty; nemělo by nastat |
| **Po lhůtě** | video se po 14 dnech smazalo, řádek zůstal |

U nahraného záznamu je vpravo **Přehrát** — otevře video v nové kartě
na podepsané adrese, která platí deset minut.

Velikost je druhá věc, kterou stojí za to zkontrolovat: desítky sekund
záznamu mají jednotky MB. Pár kilobajtů znamená rozbitý remux.

Kdyby seznam nesouhlasil s tím, co říká watcher, dá se totéž vytáhnout
i v SQL Editoru:

```sql
select r.id, r.started_at, r.event_type, r.size_bytes,
       r.uploaded_at, r.storage_path
  from camera_recordings r
  join cameras c on c.id = r.camera_id
 where c.serial_number = 'BK024AAPAGB5592'
 order by r.started_at desc
 limit 10;
```

Co číst z výsledku:

- **`uploaded_at` vyplněné** = soubor je v úložišti a portál si jeho
  velikost sám ověřil. Tohle je ten definitivní důkaz.
- **`uploaded_at` prázdné, řádek existuje** = ohlášení prošlo, nahrání
  ne. Podívej se do logu watcheru.
- **`size_bytes`** sedí řádově na délku záznamu (desítky sekund =
  jednotky MB). Nula nebo pár kB znamená rozbitý remux.

Samotný soubor leží v **Hetzner Object Storage**, bucket
`sky-guard-zaznamy`, pod cestou ze `storage_path`. Starší záznamy
(`storage_backend = 'supabase'`) jsou ještě v Supabase Storage
v bucketu `zaznamy`.

---

## Ověření, že dorazila detekce

### 1. Vidí služba kameru?

```bash
ssh root@49.13.69.91 'cd /opt/sky-watcher && docker compose logs --tail 50 sky-events'
```

Hledáš dva řádky:

```
Kamera Klanečná — jeřáb (Klanečná) na 192.168.11.51
Poslouchám Klanečná — jeřáb (192.168.11.51)
```

Když tam nejsou:

| Co v logu je | Co s tím |
|---|---|
| `Žádná stavební kamera k obsluze` | kameře chybí `lan_ip` v portálu — doplň a počkej pět minut, nebo restartuj službu |
| `Spojení s … spadlo: HTTP Error 401` | špatné `CAMERA_PASSWORD` v `/opt/sky-watcher/.env` |
| `Spojení s … spadlo: … timed out` | na kameru se z VPS nedovoláš — subnet router nebo `tailscale up --accept-routes` |
| `Portál hlásí N kamer bez adresy` | přesně tolik kamer se neobsluhuje, doplň jim adresu |

### 2. Jak se ta událost doopravdy jmenuje

Nech běžet log a projdi se před kamerou:

```bash
ssh root@49.13.69.91 'cd /opt/sky-watcher && docker compose logs -f sky-events'
```

Každý kód se zaloguje **jednou**, i ten, který se nehlásí dál:

```
Kamera Klanečná — jeřáb hlásí kód SmartMotionHuman (hlásí se dál: ne)
```

Když je tam `hlásí se dál: ne`, doplň kód do `/opt/sky-watcher/.env`:

```bash
EVENT_CODES=SmartMotionHuman
```

a `docker compose up -d sky-events`. Restartovat celý obraz netřeba.

### 3. Je detekce v portálu?

*Detekce* — do minuty od průchodu tam má být řádek s tvojí kamerou,
třídou **člověk** a snímkem. Zásah z ní nevzniká: stavba nemá dron ani
zónu, a portál ho proto ani nezkouší.

Když detekce nedorazila, ale log říká `Detekce z … odeslána`, je potíž
v portálu, ne na relayi — mrkni na odpověď v logu.

| Co v logu je | Co to znamená |
|---|---|
| `(401)` | rozešel se `RELAY_SECRET` mezi VPS a Vercelem |
| `(404)` | sériové číslo v portálu nesedí se štítkem |
| `(409)` | kamera není vedená jako **FTP přes relay** |
| `(429)` | moc událostí — zvyš `EVENT_COOLDOWN_SEC` |

> Snímek může chybět a detekce přesto dorazí. Je to schválně: přijít
> o obrázek je nepříjemné, přijít o záznam, že někdo byl na stavbě, je
> něco jiného. V logu je pak `snímek ne`.

---

## Až budeš pryč

- **Zavři FTP zvenčí**, jakmile kamery odesílají a nic se neladí:

  ```bash
  cd /opt/cam-relay
  $EDITOR docker-compose.yml        # zpátky na 127.0.0.1 a ADDRESS
  docker compose up -d ftp
  docker inspect cam-ftp --format '{{json .HostConfig.PortBindings}}'
  nc -z -w 4 49.13.69.91 21 && echo OTEVRENO || echo zavreno   # z jiného stroje
  ```

  Případné dočasné pravidlo `iptables -D DOCKER-USER …` smaž ručně;
  `docker compose down` ho neuklidí.

- **Nastav hlídač.** Bez `HEALTHCHECK_URL` se o zastaveném watcheru
  nikdo nedozví. Založ check na healthchecks.io s periodou 5 min
  a grace 15 min a doplň adresu do `/opt/sky-watcher/.env`.

- **Zkontroluj druhý den ráno**, že přibyly noční záznamy. Kamera, která
  se přihlásí a pak přestane posílat, vypadá stejně jako klidná noc —
  na to je varování „kamera mlčí", ale to potřebuje aspoň jedno
  `last_seen_at`, aby mělo od čeho počítat.
