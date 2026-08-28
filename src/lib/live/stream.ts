// Jména proudů a adresy živého obrazu.
//
// Čisté, bez sítě: skládání adresy je přesně to, co se snadno rozejde
// mezi portálem a relayem, a otestovat se to dá bez obojího.

/** Který proud kamery. */
export const STREAM_QUALITIES = ["main", "sub"] as const;
export type StreamQuality = (typeof STREAM_QUALITIES)[number];

export function isStreamQuality(value: unknown): value is StreamQuality {
  return value === "main" || value === "sub";
}

/**
 * Jméno proudu v go2rtc.
 *
 * Sériové číslo, ne UUID kamery: relay zná kamery podle sériového čísla
 * všude jinde (příjem záznamů, události) a druhý identifikátor by se
 * dřív nebo později rozešel.
 *
 * Vedlejší proud má příponu `_sub` — musí sedět s live.py, které
 * konfiguraci go2rtc generuje.
 */
export function streamName(serialNumber: string, quality: StreamQuality): string {
  return quality === "sub" ? `${serialNumber}_sub` : serialNumber;
}

/**
 * Adresa websocketu, na který se prohlížeč připojí.
 *
 * `https:` se překlápí na `wss:`, protože jinak by portál pod HTTPS
 * spojení odmítl jako nezabezpečené. Tenhle převod je tu schválně
 * jednou: ručně skládaná adresa v komponentě by se u prvního
 * testovacího prostředí na http rozešla.
 */
export function liveSocketUrl(options: {
  baseUrl: string;
  stream: string;
  token: string;
}): string {
  const zaklad = options.baseUrl.replace(/\/+$/, "");
  const ws = zaklad.replace(/^http:/, "ws:").replace(/^https:/, "wss:");
  const dotaz = new URLSearchParams({ src: options.stream, token: options.token });
  return `${ws}/api/ws?${dotaz.toString()}`;
}
