"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Volume2, VolumeX, WifiOff } from "lucide-react";

// Živý obraz jedné kamery.
//
// ═══ Jak se obraz dostane do prohlížeče ════════════════════════════
// Relay (go2rtc) posílá po websocketu fragmentované MP4 a tady se to
// skládá přes MediaSource do <video>. Prohlížeč tedy nestahuje soubor
// z adresy — obraz vzniká v paměti, a proto musí CSP pouštět `blob:`
// v media-src.
//
// ═══ Proč MSE, a ne WebRTC ═════════════════════════════════════════
// WebRTC by mělo menší zpoždění (desetiny vteřiny proti zhruba
// vteřině), ale platí se za to ICE, UDP porty a průchodem přes NAT
// diváka. Na dva tři diváky, kteří se občas podívají, jestli na stavbě
// někdo je, to zpoždění nehraje roli — a MSE jede přes týž TCP jako
// zbytek portálu, takže projde i ze sítě, kde je UDP zavřené.
//
// ═══ Vlastní klient, ne knihovna go2rtc ════════════════════════════
// go2rtc svůj přehrávač nabízí, jenže načíst skript z relaye by
// znamenalo pustit v CSP cizí `script-src` — a tím rozvolnit to, co
// portál chrání. Protokol je přitom pár zpráv, takže je levnější si ho
// napsat než rozšiřovat oprávnění.
//
// ═══ Zvuk je vypnutý, dokud si ho někdo nezapne ════════════════════
// Ne kvůli slušnosti: prohlížeče samy nepustí video se zvukem, dokud
// uživatel na stránku neklikne. Kdyby se čekalo na zapnutý zvuk, obraz
// by se nerozjel vůbec. Nahrávat se zvuk nikde nebude — je to živý
// poslech.

/**
 * Kodeky, které umíme přijmout.
 *
 * Posílají se relayi, aby věděl, co má poslat a co musí překódovat.
 * H.265 je v seznamu schválně: kamery na něj nahrávají a Safari
 * i Chrome na Macu ho v MSE zvládnou — kde ne, vybere se H.264
 * a překóduje to relay.
 */
const KODEKY = [
  "avc1.640029", // H.264 high 4.1
  "avc1.64002A", // H.264 high 4.2
  "avc1.640033", // H.264 high 5.1
  "hvc1.1.6.L153.B0", // H.265 main 5.1
  "mp4a.40.2", // AAC LC
  "mp4a.40.5", // AAC HE
  "opus",
];

/**
 * Jak daleko za živým okrajem se ještě toleruje.
 *
 * Prohlížeč po zadrhnutí sítě dohání zameškané, místo aby zahodil —
 * a živý obraz se tím posune o vteřiny do minulosti a už se nesrovná.
 * Nad touhle mezí se skočí dopředu.
 */
const MAX_ZPOZDENI_SEC = 5;

/**
 * Jak dlouho se čeká na první obraz, než se to prohlásí za ticho.
 *
 * Navázaný websocket, po kterém nic neteče, vypadá zvenčí stejně jako
 * pomalé připojení — a bez téhle hlídky zůstane na obraze „připojuje
 * se“ libovolně dlouho. Deset vteřin je s rezervou víc, než kolik
 * trvá rozjezd i u hlavního proudu.
 */
const TICHO_LIMIT_MS = 10_000;

type Stav = "pripojuje" | "hraje" | "chyba";

interface Odpoved {
  url: string;
  stream: string;
  expires_in: number;
}

export function LiveView({
  cameraId,
  cameraName,
  quality,
}: {
  cameraId: string;
  cameraName: string;
  quality: "main" | "sub";
}) {
  const video = useRef<HTMLVideoElement>(null);
  const socket = useRef<WebSocket | null>(null);
  const [stav, setStav] = useState<Stav>("pripojuje");
  const [zvuk, setZvuk] = useState(false);
  const [duvod, setDuvod] = useState<string | null>(null);

  /** Kolikátý pokus o spojení. Roste prodleva, ne počet pokusů. */
  const pokus = useRef(0);
  /** Aby se po odpojení komponenty nepokoušelo o další spojení. */
  const bezi = useRef(true);
  const casovac = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Hlídka na spojení, které se naváže a mlčí. */
  const hlidka = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * Poslední verze `pripojit`.
   *
   * Plánovač musí být deklarovaný dřív než ona (volá ho z chybové
   * větve), ale zároveň ji potřebuje zavolat — přes ref se ten kruh
   * rozetne, aniž by se plánovač předával jako parametr všude dolů.
   */
  const pripojitRef = useRef<() => void>(() => {});

  const naplanovatZnovu = useCallback(() => {
    if (!bezi.current) return;
    pokus.current += 1;
    // 1 s, 2, 4… nejvýš 30. Kamera po výpadku proudu naběhne za pár
    // minut a nikdo u toho nemá sedět; hodinová pauza by ale
    // znamenala, že se obraz vrátí až večer.
    const prodleva = Math.min(30_000, 1000 * 2 ** (pokus.current - 1));
    setStav("pripojuje");
    casovac.current = setTimeout(() => pripojitRef.current(), prodleva);
  }, []);

  const pripojit = useCallback(async () => {
    if (!bezi.current) return;
    setDuvod(null);

    let konfigurace: Odpoved;
    try {
      // Lístek se bere PŘED každým spojením, ne jednou při načtení
      // stránky: platí pár minut a po výpadku sítě by ten původní
      // býval dávno propadlý.
      const odpoved = await fetch(
        `/api/kamery/${cameraId}/zivy?kvalita=${quality}`,
        { cache: "no-store" },
      );
      if (!odpoved.ok) {
        const telo = await odpoved.json().catch(() => ({}));
        setStav("chyba");
        setDuvod(
          odpoved.status === 503
            ? "Živý obraz zatím není nastavený."
            : telo?.error === "camera_without_serial"
              ? "Kamera nemá vyplněné sériové číslo, relay ji nemá jak najít."
              : "Kameru se nepodařilo otevřít.",
        );
        return;
      }
      konfigurace = await odpoved.json();
    } catch {
      setStav("chyba");
      setDuvod("Portál neodpovídá.");
      naplanovatZnovu();
      return;
    }

    const prvek = video.current;
    if (!prvek) return;

    const ws = new WebSocket(konfigurace.url);
    ws.binaryType = "arraybuffer";
    socket.current = ws;

    let ms: MediaSource | null = null;
    let adresaBlobu: string | null = null;
    let sb: SourceBuffer | null = null;
    const fronta: ArrayBuffer[] = [];

    /**
     * Fronta je nutná: SourceBuffer přijme jen jeden zápis naráz
     * a druhý během něj skončí výjimkou. Bez ní se obraz rozsype po
     * pár vteřinách, typicky až u kamery s vyšším datovým tokem.
     */
    function odbavit() {
      if (!sb || sb.updating || fronta.length === 0) return;
      try {
        sb.appendBuffer(fronta.shift()!);
      } catch {
        // Přeplněná paměť. Zahodit, co je za námi, a jet dál — je to
        // živý obraz, historie nikoho nezajímá.
        uklidit();
      }
    }

    function uklidit() {
      if (!sb || sb.updating || sb.buffered.length === 0) return;
      const konec = sb.buffered.end(sb.buffered.length - 1);
      const zacatek = sb.buffered.start(0);
      if (konec - zacatek > 30) {
        try {
          sb.remove(zacatek, konec - 10);
        } catch {
          // Nevadí; uklidí se při dalším průchodu.
        }
      }
    }

    // ── Pořadí, ve kterém se to musí odehrát ──────────────────────
    //
    // Nejdřív SE OTEVŘE SOCKET, teprve pak vzniká MediaSource. Obráceně
    // to nejde, i když se to tak nabízí: `sourceopen` je lokální
    // událost a vyfiří okamžitě, kdežto websocket potřebuje kolo po
    // síti. Odeslání kodeků z `sourceopen` by tedy proběhlo ještě ve
    // stavu CONNECTING, `send()` by vyhodil InvalidStateError —
    // a go2rtc by se nikdy nedozvěděl, co má poslat.
    //
    // Navenek to vypadá jako zdravé spojení: websocket se naváže
    // (status 101), drží, a neteče přes něj nic. Takhle to má
    // i referenční klient go2rtc.
    ws.addEventListener("open", () => {
      pokus.current = 0;

      ms = new MediaSource();
      adresaBlobu = URL.createObjectURL(ms);
      // Obraz se do <video> dostává jako blob, ne z adresy — proto
      // `media-src blob:` v CSP.
      prvek.src = adresaBlobu;

      ms.addEventListener(
        "sourceopen",
        () => {
          if (adresaBlobu) {
            // Video si zdroj drží samo; adresa už jen zabírá paměť.
            URL.revokeObjectURL(adresaBlobu);
            adresaBlobu = null;
          }
          // Relayi se řekne, co umíme; on vybere, co pošle, a co
          // nesedí, překóduje.
          const podporovane = KODEKY.filter((kodek) =>
            MediaSource.isTypeSupported(`video/mp4; codecs="${kodek}"`),
          );
          if (ws.readyState !== WebSocket.OPEN) return;
          ws.send(JSON.stringify({ type: "mse", value: podporovane.join(",") }));

          // Hlídka: mlčící spojení vypadá stejně jako pomalé. Bez ní
          // zůstane na obraze „připojuje se“ i tehdy, když už je
          // jasné, že nic nepřijde.
          hlidka.current = setTimeout(() => {
            if (fronta.length === 0 && !sb) {
              setStav("chyba");
              setDuvod("Kamera se ozvala, ale neposílá obraz.");
            }
          }, TICHO_LIMIT_MS);
        },
        { once: true },
      );
    });

    ws.addEventListener("message", (event) => {
      // Cokoli od relaye znamená, že spojení není hluché.
      if (hlidka.current) {
        clearTimeout(hlidka.current);
        hlidka.current = null;
      }

      if (typeof event.data === "string") {
        const zprava = JSON.parse(event.data);
        if (zprava.type !== "mse" || !ms) return;
        try {
          sb = ms.addSourceBuffer(zprava.value);
          // `segments`: fragmenty nesou vlastní čas a nemají se řadit
          // za sebe podle pořadí příchodu.
          sb.mode = "segments";
          sb.addEventListener("updateend", odbavit);
        } catch {
          setStav("chyba");
          setDuvod("Prohlížeč tenhle formát obrazu nepřehraje.");
        }
        return;
      }

      fronta.push(event.data as ArrayBuffer);
      odbavit();
    });

    ws.addEventListener("close", () => {
      if (!bezi.current) return;
      setStav("chyba");
      setDuvod("Spojení s kamerou se přerušilo.");
      naplanovatZnovu();
    });

    ws.addEventListener("error", () => {
      // Podrobnost websocket neřekne; `close` přijde hned po tomhle
      // a znovupřipojení řeší tam.
      setStav("chyba");
    });
  }, [cameraId, quality, naplanovatZnovu]);

  useEffect(() => {
    pripojitRef.current = () => void pripojit();
  }, [pripojit]);

  useEffect(() => {
    bezi.current = true;
    // Ne synchronně: stav se nesmí přepisovat přímo v efektu, jinak si
    // React vynutí druhý průchod renderem. Výchozí stav je stejně
    // „připojuje se“, takže se tím nic neztrácí.
    const start = setTimeout(() => void pripojit(), 0);

    return () => {
      bezi.current = false;
      clearTimeout(start);
      if (casovac.current) clearTimeout(casovac.current);
      if (hlidka.current) clearTimeout(hlidka.current);
      socket.current?.close();
      socket.current = null;
    };
  }, [pripojit]);

  return (
    <div className="border border-[var(--line)] bg-[var(--surface)]">
      <div className="relative aspect-video bg-black">
        <video
          ref={video}
          autoPlay
          muted={!zvuk}
          playsInline
          className="h-full w-full object-contain"
          onPlaying={() => setStav("hraje")}
          onTimeUpdate={(e) => {
            // Doskočit na živý okraj. Bez tohohle se obraz po každém
            // zadrhnutí posune do minulosti a už se nesrovná.
            const prvek = e.currentTarget;
            const konce = prvek.buffered;
            if (konce.length === 0) return;
            const okraj = konce.end(konce.length - 1);
            if (okraj - prvek.currentTime > MAX_ZPOZDENI_SEC) {
              prvek.currentTime = okraj - 0.5;
            }
          }}
        />

        {stav !== "hraje" ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/60 px-4 text-center">
            {stav === "chyba" ? (
              <WifiOff className="h-5 w-5 text-[var(--text-muted)]" aria-hidden="true" />
            ) : null}
            <p className="text-sm text-[var(--text-muted)]">
              {stav === "pripojuje"
                ? `Připojuje se ke kameře ${cameraName}…`
                : (duvod ?? "Obraz se nepodařilo načíst.")}
            </p>
          </div>
        ) : null}
      </div>

      <div className="flex items-center gap-3 px-4 py-2">
        <span className="text-sm font-medium">{cameraName}</span>
        {stav === "hraje" ? (
          <span className="flex items-center gap-1.5 text-xs text-[var(--text-muted)]">
            <span className="h-1.5 w-1.5 rounded-full bg-[var(--danger)]" aria-hidden="true" />
            živě
          </span>
        ) : null}

        <button
          type="button"
          onClick={() => setZvuk((z) => !z)}
          className="ml-auto flex h-8 w-8 items-center justify-center rounded-full text-[var(--text-muted)] transition hover:bg-[var(--surface-2)] hover:text-[var(--text)]"
          aria-label={zvuk ? "Vypnout zvuk" : "Zapnout poslech"}
        >
          {zvuk ? (
            <Volume2 className="h-4 w-4" aria-hidden="true" />
          ) : (
            <VolumeX className="h-4 w-4" aria-hidden="true" />
          )}
        </button>
      </div>
    </div>
  );
}
