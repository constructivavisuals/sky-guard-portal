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
| Zóna | **žádná** | ze stavební kamery zásah nevzniká |
| Schopnosti | nechat prázdné | u FTP kamery se nepoužívají |
| Stav | Offline | přepne se sám, až kamera pošle první soubor |

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

**Vedlejší stream, ne hlavní.** Nativní rozlišení Dahuy (4480×2512
v HEVC) je nad hardwarovým dekodérem iPhonů — video se uloží, ale na
telefonu se nepřehraje. Nastav pro FTP záznam `sub stream`.

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

Zatím **jen přes databázi** — obrazovka se záznamy je fáze 5 a ještě
není. V SQL Editoru:

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

Samotný soubor si stáhneš v *Storage → zaznamy* v Supabase; cesta je
`storage_path`.

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
