"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  Maximize,
  Minimize,
  Pause,
  Play,
  Volume2,
  VolumeX,
  WifiOff,
} from "lucide-react";

import { Nacitani } from "@/components/nacitani.tsx";

// Přehrávač obrazu z kamery — živého i ze záznamu na její SD kartě.
//
// ═══ Jedna komponenta pro obojí ════════════════════════════════════
// Rozdíl mezi „teď“ a „minulý čtvrtek ve tři“ je JEN v tom, odkud si
// vzít lístek a adresu — viz `konfiguraceUrl`. Skládání obrazu je pak
// úplně stejné, protože go2rtc posílá v obou případech totéž.
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
 * Která implementace MediaSource je k dispozici.
 *
 * ═══ Na iPhonu není `MediaSource` ══════════════════════════════════
 * Safari na iOS ho nikdy nemělo; od iOS 17.1 nabízí `ManagedMediaSource`,
 * kde o zahazování rozhoduje systém. Kód psaný jen proti `MediaSource`
 * na telefonu spadne na `ReferenceError` — a spadne UVNITŘ obsluhy
 * události `open`, tedy tam, kde ho nikdo nechytí. Websocket zůstane
 * otevřený, kodeky se nepošlou a na obraze navěky svítí „připojuje
 * se“. Přesně tak se to projevilo.
 *
 * Vrací `null`, když prohlížeč neumí ani jedno. Pak nemá cenu otevírat
 * spojení: divák se má dozvědět, že to jeho prohlížeč nepřehraje, ne
 * čekat na obraz, který nemůže přijít.
 */
function vyberMediaSource(): {
  trida: typeof MediaSource;
  rizena: boolean;
} | null {
  if (typeof window === "undefined") return null;
  const okno = window as unknown as Record<string, unknown>;
  if (typeof okno.ManagedMediaSource === "function") {
    return { trida: okno.ManagedMediaSource as typeof MediaSource, rizena: true };
  }
  if (typeof okno.MediaSource === "function") {
    return { trida: okno.MediaSource as typeof MediaSource, rizena: false };
  }
  return null;
}

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

/**
 * Kam se dostalo navazování. Ukazuje se jako procenta — viz Nacitani.
 *
 * Jsou to skutečné fáze, ne odpočet: když se ukazatel zastaví na 35 %,
 * je jasné, že websocket stojí a kodeky se neposlaly. Přesně tuhle
 * závadu jsme hledali nejdéle.
 */
const POSTUP = {
  start: 5,
  listek: 15,
  socket: 35,
  kodeky: 55,
  data: 80,
  hraje: 100,
} as const;

interface Odpoved {
  url: string;
  stream: string;
  expires_in: number;
}

/**
 * Osa pro celou obrazovku — jen to nutné.
 *
 * Plná osa má popisky, rysky, značky detekcí a kalendář; na šířku
 * telefonu by z ní zbyla tlačenice přes celý obraz. Tady stačí, kde
 * v dosahu karty divák je a možnost se posunout — na přesné hledání
 * je osa pod obrazem, po otočení zpátky.
 */
function OsaVCeleObrazovce({
  od,
  dostupneOd,
  nejpozdeji,
  onZmena,
}: {
  od: Date;
  dostupneOd: Date;
  nejpozdeji: Date;
  onZmena: (kdy: Date) => void;
}) {
  const celek = nejpozdeji.getTime() - dostupneOd.getTime();
  const podil = celek > 0 ? (od.getTime() - dostupneOd.getTime()) / celek : 0;

  function skoc(e: React.PointerEvent<HTMLDivElement>) {
    const r = e.currentTarget.getBoundingClientRect();
    const p = Math.min(Math.max((e.clientX - r.left) / r.width, 0), 1);
    onZmena(new Date(dostupneOd.getTime() + p * celek));
  }

  return (
    <div className="flex min-w-0 flex-1 items-center gap-3">
      <div
        role="slider"
        tabIndex={0}
        aria-label="Čas záznamu"
        aria-valuemin={dostupneOd.getTime()}
        aria-valuemax={nejpozdeji.getTime()}
        aria-valuenow={od.getTime()}
        onPointerDown={skoc}
        className="relative h-8 flex-1 cursor-pointer touch-none"
      >
        <div className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 bg-white/25" />
        <div
          className="absolute top-1/2 h-1 -translate-y-1/2 bg-[var(--accent-bright)]"
          style={{ left: 0, width: `${Math.min(Math.max(podil, 0), 1) * 100}%` }}
        />
        <div
          className="absolute top-1/2 h-3.5 w-1 -translate-x-1/2 -translate-y-1/2 bg-white"
          style={{ left: `${Math.min(Math.max(podil, 0), 1) * 100}%` }}
        />
      </div>
      <span className="shrink-0 text-xs tabular-nums text-white">
        {od.toLocaleTimeString("cs-CZ", { hour12: false })}
      </span>
    </div>
  );
}

/** Telefon naležato. Výška odděluje mobil od monitoru. */
const NALEZATO = "(orientation: landscape) and (max-height: 500px)";

function odberOrientace(zmena: () => void): () => void {
  const dotaz = window.matchMedia(NALEZATO);
  dotaz.addEventListener("change", zmena);
  return () => dotaz.removeEventListener("change", zmena);
}

/** Co se zrovna děje. Bez toho jsou procenta jen číslo. */
function popisPostupu(postup: number, kamera: string): string {
  if (postup >= POSTUP.data) return "Skládá se obraz";
  if (postup >= POSTUP.kodeky) return "Čeká se na obraz z kamery";
  if (postup >= POSTUP.socket) return "Domlouvá se formát";
  if (postup >= POSTUP.listek) return `Připojuje se ke kameře ${kamera}`;
  return "Ověřuje se přístup";
}

export function Prehravac({
  konfiguraceUrl,
  cameraName,
  onVideo,
  zaznam,
}: {
  /**
   * Odkud si vzít lístek a adresu websocketu.
   *
   * Parametr, ne pevná cesta: TÝŽ přehrávač obsluhuje živý obraz
   * (`/api/kamery/<id>/zivy`) i přehrávání ze záznamu
   * (`/api/kamery/<id>/zaznam?od=…`). Obě routy vracejí totéž —
   * `{ stream, url, expires_in }` — a co se přehrává, rozhoduje ta
   * adresa, ne tahle komponenta. Dvě kopie MSE kódu vedle sebe by se
   * rozešly při první opravě.
   */
  konfiguraceUrl: string;
  cameraName: string;
  /** Prvek videa ven — pro focení a nahrávání. */
  onVideo?: (prvek: HTMLVideoElement | null) => void;
  /**
   * Jen u přehrávání ze záznamu: co má umět celá obrazovka navíc.
   * U živého obrazu se posouvat ani zrychlovat nedá, tak se to
   * nenabízí.
   */
  zaznam?: {
    od: Date;
    dostupneOd: Date;
    nejpozdeji: Date;
    onZmena: (kdy: Date) => void;
  };
}) {
  const video = useRef<HTMLVideoElement>(null);
  const socket = useRef<WebSocket | null>(null);
  const [stav, setStav] = useState<Stav>("pripojuje");
  const [postup, setPostup] = useState<number>(POSTUP.start);
  const [pozastaveno, setPozastaveno] = useState(false);
  const [zrychleno, setZrychleno] = useState(false);
  /** Přiblížení obrazu prsty: násobek a posun ve zlomcích plochy. */
  const [lupa, setLupa] = useState({ merítko: 1, x: 0, y: 0 });
  /**
   * Leží na obraze prst?
   *
   * Ve stavu, ne v ref: během gesta se vypíná plynulý přechod, aby
   * obraz šel přesně za prsty. Ref se při renderu číst nesmí a React
   * to hlídá — a má pravdu, protože z něj vykreslené hodnoty by se
   * neaktualizovaly.
   */
  const [gesto, setGesto] = useState(false);

  // ═══ Otočení telefonu naležato = celá obrazovka ══════════════════
  // Fullscreen API se nepoužívá schválně: Safari na iOS ho na jiném
  // prvku než <video> nemá, a na <video> by převzalo obraz i ovládání
  // svým přehrávačem — přišli bychom o osu i o tlačítka.
  //
  // Místo toho se roztáhne vlastní vrstva přes celé okno. Vypadá to
  // stejně, funguje to všude a ovládání zůstává naše.
  //
  // Podmínka na výšku odděluje telefon naležato od monitoru: ten je
  // taky „na šířku", ale nikdo tam obraz přes celou obrazovku nechce.
  //
  // Přes useSyncExternalStore, ne přes useState s efektem: media query
  // JE vnější zdroj a tohle je přesně to, na co ten hook je. Serverový
  // snímek je `false`, takže se na serveru vykreslí normální okno.
  const naLezato = useSyncExternalStore(
    odberOrientace,
    () => window.matchMedia(NALEZATO).matches,
    () => false,
  );

  // ═══ Otočení nestačí, musí být i tlačítko ════════════════════════
  // Aplikace přidaná na plochu má v manifestu `orientation: portrait`,
  // takže se NEOTOČÍ — a s ní ani obraz. Totéž když má člověk
  // zamčenou orientaci v ovládacím centru. Na otáčení se tedy spolehnout
  // nedá a bez tlačítka by se do celé obrazovky nedostal vůbec.
  //
  // `null` znamená „rozhoduje otočení". Jakmile někdo sáhne na
  // tlačítko, rozhoduje ono — dvě věci, které si přetahují tentýž
  // stav, jsou horší než jasné pořadí.
  const [rucne, setRucne] = useState<boolean | null>(null);
  const celaObrazovka = rucne ?? naLezato;

  // Přiblížení platí jen v celé obrazovce: v malém okně se přiblížený
  // obraz nedá rozumně posouvat a člověk by nevěděl, čím to je.
  const zoom = celaObrazovka ? lupa : { merítko: 1, x: 0, y: 0 };
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
    setPostup(POSTUP.start);
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
      const odpoved = await fetch(konfiguraceUrl, { cache: "no-store" });
      if (!odpoved.ok) {
        const telo = await odpoved.json().catch(() => ({}));
        setStav("chyba");
        setDuvod(
          odpoved.status === 503
            ? "Živý obraz zatím není nastavený."
            : telo?.error === "camera_without_serial"
              ? "Kamera nemá vyplněné sériové číslo, relay ji nemá jak najít."
              : telo?.error === "beyond_card_reach"
                ? `Takhle daleko zpátky karta v kameře nesahá (drží zhruba ${
                    telo?.detail?.reach_days ?? "?"
                  } dní).`
                : telo?.error === "od_in_future"
                  ? "Do budoucnosti se podívat nedá."
                  : "Kameru se nepodařilo otevřít.",
        );
        return;
      }
      konfigurace = await odpoved.json();
      setPostup(POSTUP.listek);
    } catch {
      setStav("chyba");
      setDuvod("Portál neodpovídá.");
      naplanovatZnovu();
      return;
    }

    const prvek = video.current;
    if (!prvek) return;

    const mse = vyberMediaSource();
    if (!mse) {
      // Bez MediaSource se obraz složit nedá. Spojení se ani neotevírá:
      // viselo by a vypadalo jako výpadek kamery.
      setStav("chyba");
      setDuvod("Tenhle prohlížeč neumí přehrát živý obraz. Na iPhonu ho zvládne Safari od iOS 17.1.");
      return;
    }

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
      setPostup(POSTUP.socket);

      ms = new mse.trida();
      if (mse.rizena) {
        // ManagedMediaSource (iOS 17.1+) chce `srcObject`, ne adresu
        // blobu, a bez `disableRemotePlayback` se Safari pokusí proud
        // poslat na AirPlay a obraz se nerozjede. Takhle to má
        // i referenční klient go2rtc.
        prvek.disableRemotePlayback = true;
        prvek.srcObject = ms;
      } else {
        adresaBlobu = URL.createObjectURL(ms);
        // Obraz se do <video> dostává jako blob, ne z adresy — proto
        // `media-src blob:` v CSP.
        prvek.src = adresaBlobu;
        prvek.srcObject = null;
      }

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
          // Ptát se musí TÉ implementace, která se použila:
          // ManagedMediaSource podporuje jinou množinu než MediaSource
          // a odpověď z té druhé by neplatila.
          const podporovane = KODEKY.filter((kodek) =>
            mse.trida.isTypeSupported(`video/mp4; codecs="${kodek}"`),
          );
          if (ws.readyState !== WebSocket.OPEN) return;
          ws.send(JSON.stringify({ type: "mse", value: podporovane.join(",") }));
          setPostup(POSTUP.kodeky);

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

        // ═══ Chybu od relaye je potřeba ukázat ═══════════════════
        // go2rtc posílá po témže websocketu zprávy typu `error`.
        // Dokud se zahazovaly, vypadala každá z nich stejně: obraz
        // nenaskočil a nikdo nevěděl proč. Nejčastější je 404 od
        // kamery, což NENÍ závada spojení — na kartě prostě z té doby
        // není záznam.
        if (zprava.type === "error") {
          const text = String(zprava.value ?? "");
          setStav("chyba");
          setDuvod(
            /404|not found/i.test(text)
              ? "Z téhle doby na kartě v kameře záznam není."
              : `Relay obraz neposlal: ${text.slice(0, 120)}`,
          );
          return;
        }

        if (zprava.type !== "mse" || !ms) return;
        try {
          sb = ms.addSourceBuffer(zprava.value);
          // `segments`: fragmenty nesou vlastní čas a nemají se řadit
          // za sebe podle pořadí příchodu.
          sb.mode = "segments";
          sb.addEventListener("updateend", odbavit);
          setPostup(POSTUP.data);
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
  }, [konfiguraceUrl, naplanovatZnovu]);

  useEffect(() => {
    pripojitRef.current = () => void pripojit();
  }, [pripojit]);

  // Prvek videa ven, ať se z něj dá vyfotit snímek nebo natočit klip.
  useEffect(() => {
    onVideo?.(video.current);
    return () => onVideo?.(null);
  }, [onVideo]);

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

  // ═══ Přiblížení obrazu dvěma prsty ═══════════════════════════════
  // Stejné gesto jako na ose, jen výsledkem je zvětšení obrazu.
  // Prohlížeč by na to sám nešel: `<video>` roztáhnout dvěma prsty
  // neumí a zoom celé stránky by zvětšil i ovládání.
  const prsty = useRef(new Map<number, { x: number; y: number }>());
  const stisk = useRef<{ rozestup: number; merítko: number } | null>(null);
  const tazeni = useRef<{ x: number; y: number; poc: { x: number; y: number } } | null>(null);

  function rozestupPrstu(): number {
    const [a, b] = [...prsty.current.values()];
    if (!a || !b) return 1;
    return Math.max(Math.hypot(a.x - b.x, a.y - b.y), 1);
  }

  function obrazDown(e: React.PointerEvent) {
    prsty.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    setGesto(true);
    if (prsty.current.size === 2) {
      tazeni.current = null;
      stisk.current = { rozestup: rozestupPrstu(), merítko: lupa.merítko };
    } else if (prsty.current.size === 1 && lupa.merítko > 1) {
      tazeni.current = { x: e.clientX, y: e.clientY, poc: { x: lupa.x, y: lupa.y } };
    }
  }

  function obrazMove(e: React.PointerEvent) {
    if (!prsty.current.has(e.pointerId)) return;
    prsty.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

    const s = stisk.current;
    if (s && prsty.current.size >= 2) {
      const merítko = Math.min(6, Math.max(1, (s.merítko * rozestupPrstu()) / s.rozestup));
      setLupa((l) => ({ ...l, merítko }));
      return;
    }

    const t = tazeni.current;
    if (t && lupa.merítko > 1) {
      // Posun je omezený tak, aby se nedalo vytáhnout obraz mimo
      // rámeček — jinak člověk skončí u černé plochy a neví proč.
      const mez = (lupa.merítko - 1) / 2;
      setLupa((l) => ({
        ...l,
        x: Math.min(mez, Math.max(-mez, t.poc.x + (e.clientX - t.x) / 300)),
        y: Math.min(mez, Math.max(-mez, t.poc.y + (e.clientY - t.y) / 300)),
      }));
    }
  }

  function obrazUp(e: React.PointerEvent) {
    prsty.current.delete(e.pointerId);
    if (prsty.current.size < 2) stisk.current = null;
    if (prsty.current.size === 0) {
      setGesto(false);
      tazeni.current = null;
      // Zpátky na celý obraz, když se přiblížení skoro vrátilo —
      // jinak zůstane o procento zvětšený a nejde srovnat.
      if (lupa.merítko < 1.05) setLupa({ merítko: 1, x: 0, y: 0 });
    }
  }

  /** Zrychlení podržením prstu vpravo — jako u videa na YouTube. */
  function drzenimZrychli(drzet: boolean) {
    const prvek = video.current;
    if (!prvek) return;
    setZrychleno(drzet);
    prvek.playbackRate = drzet ? 4 : 1;
  }

  function prepniChod() {
    const prvek = video.current;
    if (!prvek) return;
    if (prvek.paused) {
      void prvek.play();
      setPozastaveno(false);
    } else {
      prvek.pause();
      setPozastaveno(true);
    }
  }

  const obrazTridy = celaObrazovka
    ? "fixed inset-0 z-50 bg-black"
    : "relative aspect-video max-h-[75vh] bg-black";

  return (
    <div
      className={
        celaObrazovka ? "" : "border border-[var(--line)] bg-[var(--surface)]"
      }
    >
      {/*
        `max-h`: bez něj je na širokém monitoru 16:9 přes celou šířku
        vyšší než obrazovka a člověk musí rolovat, aby viděl spodek
        obrazu. Video uvnitř má object-contain, takže se jen olemuje
        černou, nic se neořízne. Platí i na mobilu na šířku.
      */}
      <div
        className={obrazTridy}
        onPointerDown={obrazDown}
        onPointerMove={obrazMove}
        onPointerUp={obrazUp}
        onPointerCancel={obrazUp}
        style={celaObrazovka ? undefined : undefined}
      >
        <video
          ref={video}
          autoPlay
          muted={!zvuk}
          playsInline
          className="h-full w-full touch-none object-contain"
          style={{
            transform: `scale(${zoom.merítko}) translate(${zoom.x * 100}%, ${zoom.y * 100}%)`,
            transition: gesto ? "none" : "transform 120ms ease-out",
          }}
          onPlaying={() => {
            setStav("hraje");
            setPostup(POSTUP.hraje);
          }}
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

        {/* ── Zrychlení podržením vpravo ─────────────────────────
            Jen v celé obrazovce a jen u záznamu: u živého obrazu není
            co dohánět. Plocha je vpravo, protože tam palec při držení
            telefonu naležato leží. */}
        {celaObrazovka && zaznam ? (
          <div
            className="absolute inset-y-0 right-0 w-1/3"
            onPointerDown={() => drzenimZrychli(true)}
            onPointerUp={() => drzenimZrychli(false)}
            onPointerCancel={() => drzenimZrychli(false)}
            onPointerLeave={() => drzenimZrychli(false)}
            aria-hidden="true"
          />
        ) : null}

        {zrychleno ? (
          <div className="pointer-events-none absolute right-6 top-1/2 -translate-y-1/2 border border-[var(--line-strong)] bg-black/70 px-3 py-1.5 text-sm font-medium text-[var(--text)]">
            4× ▶▶
          </div>
        ) : null}

        {stav !== "hraje" ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/70 px-4 text-center backdrop-blur-[2px]">
            {stav === "chyba" ? (
              <>
                <WifiOff className="h-6 w-6 text-[var(--text-muted)]" aria-hidden="true" />
                <p className="max-w-xs text-sm text-[var(--text-muted)]">
                  {duvod ?? "Obraz se nepodařilo načíst."}
                </p>
              </>
            ) : (
              <Nacitani cil={postup} popis={popisPostupu(postup, cameraName)} />
            )}
          </div>
        ) : null}

        {/* ── Ovládání v celé obrazovce ──────────────────────────
            Nahoře jméno a východ, dole chod a zjednodušená osa.
            Všechno v překryvu nad obrazem, protože na šířku telefonu
            není kam jinam. */}
        {celaObrazovka ? (
          <>
            <div className="pointer-events-none absolute inset-x-0 top-0 flex items-center gap-3 bg-gradient-to-b from-black/70 to-transparent px-4 py-3">
              <span className="text-sm font-medium text-white">{cameraName}</span>
              <button
                type="button"
                onClick={() => setRucne(false)}
                aria-label="Zmenšit"
                className="pointer-events-auto ml-auto flex h-9 w-9 items-center justify-center text-white/80 transition active:scale-95"
              >
                <Minimize className="h-5 w-5" aria-hidden="true" />
              </button>
            </div>

            <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent px-4 pb-3 pt-8">
              <div className="flex items-center gap-4">
                <button
                  type="button"
                  onClick={prepniChod}
                  aria-label={pozastaveno ? "Přehrát" : "Zastavit"}
                  className="flex h-11 w-11 shrink-0 items-center justify-center border border-white/30 bg-black/40 text-white transition active:scale-95"
                >
                  {pozastaveno ? (
                    <Play className="h-5 w-5" aria-hidden="true" />
                  ) : (
                    <Pause className="h-5 w-5" aria-hidden="true" />
                  )}
                </button>

                {zaznam ? (
                  <OsaVCeleObrazovce
                    od={zaznam.od}
                    dostupneOd={zaznam.dostupneOd}
                    nejpozdeji={zaznam.nejpozdeji}
                    onZmena={zaznam.onZmena}
                  />
                ) : (
                  <span className="text-xs text-white/70">živě</span>
                )}
              </div>
            </div>
          </>
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

        {/* Celá obrazovka tlačítkem, ne jen otočením: v aplikaci
            přidané na plochu je orientace zamčená na výšku a otočení
            se nekoná. Viz `rucne` výš. */}
        <button
          type="button"
          onClick={() => setRucne(true)}
          className="ml-auto flex h-8 w-8 items-center justify-center rounded-full text-[var(--text-muted)] transition hover:bg-[var(--surface-2)] hover:text-[var(--text)]"
          aria-label="Na celou obrazovku"
        >
          <Maximize className="h-4 w-4" aria-hidden="true" />
        </button>

        <button
          type="button"
          onClick={() => setZvuk((z) => !z)}
          className="flex h-8 w-8 items-center justify-center rounded-full text-[var(--text-muted)] transition hover:bg-[var(--surface-2)] hover:text-[var(--text)]"
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
