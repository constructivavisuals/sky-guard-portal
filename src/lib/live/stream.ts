// Jména proudů a adresy — živý obraz i přehrávání ze záznamu.
//
// Čisté, bez sítě: skládání adresy je přesně to, co se snadno rozejde
// mezi portálem a relayem, a otestovat se to dá bez obojího.

/** Který proud kamery. */
export const STREAM_QUALITIES = ["sub", "main"] as const;
export type StreamQuality = (typeof STREAM_QUALITIES)[number];

export function isStreamQuality(value: unknown): value is StreamQuality {
  return value === "sub" || value === "main";
}

/**
 * Jméno proudu v go2rtc pro ŽIVÝ obraz.
 *
 * Sériové číslo, ne UUID kamery: relay zná kamery podle sériového čísla
 * všude jinde (příjem záznamů, události) a druhý identifikátor by se
 * dřív nebo později rozešel. Přípona `_sub` musí sedět s live.py,
 * které konfiguraci go2rtc generuje.
 *
 * ═══ Výchozí je HLAVNÍ proud ═══════════════════════════════════════
 * Kdysi se změřil jako rozpadlý přes tunel, ale měřilo se `ffplay` po
 * UDP, kde se ztracený paket neopakuje. Do prohlížeče jde obraz přes
 * go2rtc po TCP a v provozu se ukázalo, že projde — pomohlo i to, že
 * se do Hetzneru nesypou průběžná data.
 *
 * Vedlejší proud zůstává jako volba pro linku, která na plné
 * rozlišení nestačí. Pořadí je tedy obrácené než dřív: nabízí se to
 * lepší a ustupuje se, když to nejde.
 *
 * Pokud se na nějaké stavbě obraz zadrhává, není to důvod měnit
 * výchozí hodnotu pro všechny — divák si přepne a volba se mu
 * v prohlížeči pamatuje.
 */
export function streamName(
  serialNumber: string,
  quality: StreamQuality = "main",
): string {
  return quality === "main" ? serialNumber : `${serialNumber}_sub`;
}

/**
 * Jak daleko zpátky sahá karta v kameře.
 *
 * Není to lhůta záznamů v Hetzneru (`sites.clip_retention_days`) —
 * ta platí pro klipy u detekcí. Tohle je fyzická kapacita karty a
 * musí sedět s tím, co je nastavené v kameře; postup výpočtu je
 * v MONTAZ.md („Dva stropy, platí ten nižší“).
 *
 * Sedm dní odpovídá 256GB kartě při 3 Mbit/s. Kdo dá větší kartu nebo
 * nižší tok, zvedne si to proměnnou.
 */
export const PLAYBACK_REACH_DAYS = Number(
  process.env.PLAYBACK_REACH_DAYS ?? "7",
);

/**
 * Jméno proudu pro PŘEHRÁVÁNÍ z karty.
 *
 * ═══ Čas je uvnitř jména schválně ══════════════════════════════════
 * Lístek se podepisuje přes jméno proudu. Když je čas jeho součástí,
 * platí lístek na jeden okamžik a na žádný jiný — jiný čas je jiné
 * jméno a podpis nesedí. Kdyby čas šel vedle jako parametr adresy,
 * otevřel by jeden lístek celý týden zpátky.
 *
 * Tvar MUSÍ sedět s `JMENO_RE` v playback.py na relayi:
 *
 *   ^([A-Za-z0-9_-]{1,64})-pb-(\d{9,12})$
 *
 * Epocha je v SEKUNDÁCH a v UTC. Na místní čas kamery ji převádí až
 * relay — portál o zóně kamery nic neví a vědět nemá.
 */
export function playbackStreamName(
  serialNumber: string,
  odEpochSeconds: number,
): string {
  return `${serialNumber}-pb-${Math.floor(odEpochSeconds)}`;
}

function socketUrl(options: {
  baseUrl: string;
  path: string;
  stream: string;
  token: string;
}): string {
  const zaklad = options.baseUrl.replace(/\/+$/, "");
  // `https:` se překlápí na `wss:`, protože jinak by portál pod HTTPS
  // spojení odmítl jako nezabezpečené. Tenhle převod je tu schválně
  // jednou: ručně skládaná adresa v komponentě by se u prvního
  // testovacího prostředí na http rozešla.
  const ws = zaklad.replace(/^http:/, "ws:").replace(/^https:/, "wss:");
  const dotaz = new URLSearchParams({ src: options.stream, token: options.token });
  return `${ws}${options.path}?${dotaz.toString()}`;
}

/** Adresa websocketu se živým obrazem. */
export function liveSocketUrl(options: {
  baseUrl: string;
  stream: string;
  token: string;
}): string {
  return socketUrl({ ...options, path: "/api/ws" });
}

/**
 * Adresa websocketu s přehráváním ze záznamu.
 *
 * Prefix `/zaznam` odděluje Caddy: pod ním sedí DRUHÁ instance go2rtc
 * a druhý vrátný (sky-playback). Živý obraz a záznam se tím nemíchají
 * — restart té první nemá utnout běžící přehrávání.
 */
export function playbackSocketUrl(options: {
  baseUrl: string;
  stream: string;
  token: string;
}): string {
  return socketUrl({ ...options, path: "/zaznam/api/ws" });
}
