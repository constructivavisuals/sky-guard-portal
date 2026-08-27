# Watcher nemá jedinou závislost mimo standardní knihovnu a ffmpeg.
# Slim obraz je tedy dost a nic se do něj neinstaluje přes pip —
# co se neinstaluje, to se nedá kompromitovat skrz závislost.
FROM python:3.12-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY watcher.py /app/watcher.py

# Nepouštět jako root: kontejner sahá na sdílený inbox a jediné, co
# potřebuje, je číst a mazat vlastní soubory.
RUN useradd --create-home --uid 10001 watcher
USER watcher

ENTRYPOINT ["python", "-u", "/app/watcher.py"]
