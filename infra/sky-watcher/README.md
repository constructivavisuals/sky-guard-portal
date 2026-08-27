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

Kdyby měl klíč k úložišti, byl by to klíč ke **všem** bucketům všech
klientů: Supabase S3 klíč se na jeden bucket omezit nedá a obchází RLS.
Takhle je na serveru jen tajemství, kterým jde založit záznam u kamery,
která už v portálu je.

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
| remux selhal | zkusí 3× a pak do `failed/` |
| záznam už portál má | jen uklidí lokál |

Soubor se nikdy nemaže kvůli chybě — neprošlý záznam je pořád záznam
z kamery a někdo se na něj má podívat.

Po každém průchodu, i prázdném, jde ping na `HEALTHCHECK_URL`. Hlídá se
ticho, tedy že watcher žije — ne že zrovna něco přišlo.

## Montáž nové kamery

Postup na místě — co nastavit v kameře, co založit v portálu předem
a jak ověřit, že záznam dorazil: **[MONTAZ.md](MONTAZ.md)**.

## Test

Celý řetěz proti **falešnému portálu**, bez VPS a bez Sky Guardu:

```bash
python3 infra/sky-watcher/test/test_watcher.py
```

Vyrobí syntetické `.dav`, postaví portál na localhostu a ověří vznik
ohlášení, časy v UTC, typ události, nahrání, potvrzení, úklid lokálu
i `.idx`, oba tvary cesty, odsunutí nečitelné cesty i odmítnutého
požadavku, a že cizí tajemství neprojde. Falešný portál ověřuje podpis
touž cestou jako ten skutečný — kdyby se obě strany rozešly v tom, co
se podepisuje, projeví se to tady.

Bez ffmpegu se test **přeskočí** (návratový kód 2), ne aby vypadal jako
selhání kódu. Na macOS s Homebrew bývá příčinou upgrade x265 bez
rebuildu ffmpegu: `brew reinstall ffmpeg`.
