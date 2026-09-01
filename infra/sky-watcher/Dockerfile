# Watcher nemá jedinou závislost mimo standardní knihovnu a ffmpeg.
# Slim obraz je tedy dost a nic se do něj neinstaluje přes pip —
# co se neinstaluje, to se nedá kompromitovat skrz závislost.
FROM python:3.12-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
# Jeden obraz, pět služeb: watcher přebírá staré soubory z FTP, events
# visí na spojení ke kamerám, klipy vyrábějí důkazy z karty, live
# ověřuje lístky na živý obraz a playback na záznam. Sdílí portal.py,
# takže se podpis nemůže rozejít mezi nimi — a live.py, takže se
# nemůže rozejít ani ověřování lístků.
COPY watcher.py events.py live.py playback.py klipy.py portal.py /app/

# Nepouštět jako root: kontejner sahá na sdílený inbox a jediné, co
# potřebuje, je číst a mazat vlastní soubory.
RUN useradd --create-home --uid 10001 watcher

# ═══ Adresáře pro data se zakládají TADY, ne až svazkem ════════════
# Pojmenovaný svazek si při prvním připojení převezme vlastníka
# a práva z cesty v obrazu. Kdyby tu cesta nebyla, vyrobí ji Docker
# jako `root` — a kontejner pod uid 10001 do ní nezapíše.
#
# Projevilo by se to nejhůř možným způsobem: služba naběhne, detekce
# chodí dál a klipy prostě nevznikají. Přesně to se stalo.
RUN mkdir -p /fronta /failed-klipy /failed \
 && chown watcher:watcher /fronta /failed-klipy /failed

USER watcher

# Který skript se pustí, říká compose. Watcher je výchozí.
ENTRYPOINT ["python", "-u"]
CMD ["/app/watcher.py"]
