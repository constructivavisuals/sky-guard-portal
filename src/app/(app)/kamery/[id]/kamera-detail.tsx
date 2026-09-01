"use client";

import Link from "next/link";
import { useState, useSyncExternalStore } from "react";
import {
  Camera,
  ChevronLeft,
  History,
  Radio,
  ScanEye,
  Square,
  Video as VideoIcon,
} from "lucide-react";

import {
  umiNahravat,
  vyfot,
  zacniNahravat,
  type Nahravani,
} from "@/lib/media/zachyt.ts";

import { Prehravac } from "../../prehravac.tsx";
import { CasovaOsa } from "./casova-osa.tsx";

// Jedna kamera, tři pohledy na totéž — vzor převzatý z DMSS.
//
// ═══ Proč jedna stránka a ne tři ═══════════════════════════════════
// Živý obraz, záznam a události byly tři položky v menu a člověk mezi
// nimi musel přeskakovat s tím, že si pamatoval, o které kameře je
// řeč. Přitom je to pořád jedna kamera a jedna otázka: co se tam
// děje nebo dělo.
//
// Obraz proto zůstává NAHOŘE a nemění se; přepínají se jen záložky
// pod ním. Přepnutí ze živého na záznam tedy není navigace, ale
// změna toho, co se do téhož okna načítá.
//
// ═══ Záložky nejsou v adrese ═══════════════════════════════════════
// Schválně: navigace na serveru by při každém přepnutí znovu načetla
// stránku a obraz by se rozjížděl od nuly. Kamera v adrese je,
// záložka ne — sdílený odkaz otevře kameru, což je to podstatné.

type Zalozka = "zive" | "zaznam" | "udalosti";

const ZALOZKY = [
  { key: "zive" as const, label: "Živě", icon: Radio },
  { key: "zaznam" as const, label: "Přehrávání", icon: History },
  { key: "udalosti" as const, label: "Události", icon: ScanEye },
];

type Kvalita = "sub" | "main";

/**
 * Volba proudu, jako má DMSS tlačítko s rozlišením.
 *
 * ═══ Proč volba a ne nové výchozí nastavení ════════════════════════
 * Hlavní proud je 4K a na místě se změřil jako nepoužitelný přes
 * tunel. Měřilo se ale po UDP, kde se ztracený paket neopakuje —
 * do prohlížeče jde obraz přes go2rtc po TCP, kde se stejné přetížení
 * projeví zadrháváním, ne rozsypaným obrazem. Použitelný tedy být
 * může a záleží to na lince konkrétní stavby, což portál nepozná.
 *
 * Kdo si o detail řekne, ví, že si o něj řekl. Obráceně by první
 * dojem z živého obrazu byl zaseknutý obraz — a přesně proto tahle
 * volba jednou zmizela.
 */
const KVALITY = [
  { key: "main" as const, label: "Detailní", popis: "Hlavní proud v plném rozlišení" },
  { key: "sub" as const, label: "Plynulá", popis: "Vedlejší proud — projde i po slabší lince" },
];

const ULOZISTE_KLIC = "sky-guard.kvalita-obrazu";

/**
 * Uložená volba. Selhání se ignoruje: v anonymním okně nebo
 * s blokovaným úložištěm to vyhodí výjimku a kvůli předvolbě nemá
 * spadnout celá stránka.
 */
function nactiKvalitu(): Kvalita {
  try {
    // Jen výslovně uložená „sub" přebije výchozí. Prázdné úložiště
    // znamená „nikdo nepřepínal", tedy plné rozlišení.
    return localStorage.getItem(ULOZISTE_KLIC) === "sub" ? "sub" : "main";
  } catch {
    return "main";
  }
}

function ulozKvalitu(kvalita: Kvalita): void {
  try {
    localStorage.setItem(ULOZISTE_KLIC, kvalita);
  } catch {
    // Nevadí; platí do konce sezení.
  }
}

/** Kolik zpátky se otevírá záznam, když na něj člověk poprvé přepne. */
const VYCHOZI_ZPET_MS = 3_600_000;

export interface UdalostRow {
  id: string;
  detected_at: string;
  object_class: string;
  confidence: number | null;
  ma_zaznam: boolean;
}

export function KameraDetail({
  cameraId,
  cameraName,
  siteName,
  dosahDni,
  udalosti,
}: {
  cameraId: string;
  cameraName: string;
  siteName: string | null;
  dosahDni: number;
  udalosti: readonly UdalostRow[];
}) {
  const [zalozka, setZalozka] = useState<Zalozka>("zive");

  // Čas se čte až po hydrataci — server jede v UTC a prohlížeč v místní
  // zóně, takže vykreslený čas by se neshodl. Týž vzor jako jinde.
  const hydratovano = useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );
  // ═══ Uložená volba kvality ══════════════════════════════════════
  // Přes useSyncExternalStore, ne přes useState s efektem: na serveru
  // localStorage není, takže se serverový snímek drží na výchozí
  // hodnotě a po hydrataci se přečte skutečná volba. Efekt s setState by vyrobil
  // kaskádový render navíc a React ho právem odmítá.
  //
  // `volba` je přepnutí v tomhle sezení; dokud nikdo nepřepnul, platí
  // to uložené.
  const ulozena = useSyncExternalStore(
    () => () => {},
    nactiKvalitu,
    () => "main" as Kvalita,
  );
  const [volba, setVolba] = useState<Kvalita | null>(null);
  const [video, setVideo] = useState<HTMLVideoElement | null>(null);
  const kvalita = volba ?? ulozena;

  const [od, setOd] = useState(() => new Date(Date.now() - VYCHOZI_ZPET_MS));
  const [ted, setTed] = useState(() => Date.now());

  const dostupneOd = new Date(ted - dosahDni * 86_400_000);
  const nejpozdeji = new Date(ted);

  function nastavCas(kdy: Date) {
    const nyni = Date.now();
    setTed(nyni);
    const dolni = nyni - dosahDni * 86_400_000;
    setOd(new Date(Math.min(Math.max(kdy.getTime(), dolni), nyni)));
  }

  /** Detekce vybraného dne — jen ty se na osu vejdou smysluplně. */
  const denniDetekce = udalosti
    .map((u) => new Date(u.detected_at))
    .filter((d) => d.toDateString() === od.toDateString());

  return (
    /*
      ═══ Na velkém displeji dva sloupce ═══════════════════════════
      Na mobilu jde všechno pod sebe, jak to má DMSS. Na monitoru by
      ale stejné pořadí znamenalo obraz přes celou šířku a časovou osu
      až pod ním, mimo obrazovku — člověk by při hledání v záznamu
      rolovat nahoru a dolů mezi osou a obrazem.
      Vedle sebe je vidět obojí najednou, což je přesně to, co
      prohledávání záznamu potřebuje.
    */
    <div className="lg:grid lg:grid-cols-[minmax(0,1.7fr)_minmax(340px,1fr)] lg:items-start">
      <div className="lg:sticky lg:top-0 lg:border-r lg:border-[var(--line)]">
        {/* ── Hlavička ──────────────────────────────────────────── */}
      <div className="flex items-center gap-3 border-b border-[var(--line)] px-4 py-3 sm:px-6">
        <Link
          href="/kamery"
          aria-label="Zpět na kamery"
          className="-ml-2 flex h-9 w-9 items-center justify-center text-[var(--text-muted)] transition hover:text-[var(--text)] lg:hidden"
        >
          <ChevronLeft className="h-5 w-5" aria-hidden="true" />
        </Link>
        <div className="min-w-0">
          <h1 className="truncate text-base font-medium tracking-tight text-[var(--text)]">
            {cameraName}
          </h1>
          {siteName ? (
            <p className="truncate text-xs text-[var(--text-muted)]">{siteName}</p>
          ) : null}
        </div>
      </div>

      {/* ── Obraz ─────────────────────────────────────────────── */}
      {/*
        Klíč nese i vybraný čas: jiný okamžik je jiný proud, ne
        přetočení běžícího. Bez něj by v <video> zůstala viset
        MediaSource z minulého spojení.
      */}
      {zalozka !== "zaznam" || !hydratovano ? (
        // Živě i u událostí: nad seznamem má běžet obraz, ne černá
        // plocha. Do nahydratování taky — vybraný čas ještě není.
        <Prehravac
          // Kvalita je v klíči: jiný proud, ne přepnutí zdroje
          // v běžícím <video>.
          key={`${cameraId}-zive-${kvalita}`}
          konfiguraceUrl={`/api/kamery/${cameraId}/zivy?kvalita=${kvalita}`}
          cameraName={cameraName}
        />
      ) : (
        <Prehravac
          key={`${cameraId}-${Math.floor(od.getTime() / 1000)}`}
          konfiguraceUrl={`/api/kamery/${cameraId}/zaznam?od=${encodeURIComponent(
            od.toISOString(),
          )}`}
          cameraName={cameraName}
          onVideo={setVideo}
          zaznam={{ od, dostupneOd, nejpozdeji, onZmena: nastavCas }}
        />
      )}

      </div>

      <div className="min-w-0">
      {/* ── Záložky ───────────────────────────────────────────── */}
      <div
        role="tablist"
        aria-label="Pohled na kameru"
        className="flex border-b border-[var(--line)] bg-[var(--surface)]"
      >
        {ZALOZKY.map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={zalozka === key}
            onClick={() => setZalozka(key)}
            className={`flex flex-1 flex-col items-center justify-center gap-1 py-3 text-xs transition sm:flex-row sm:gap-2 sm:text-sm ${
              zalozka === key
                ? "border-b-2 border-[var(--accent-bright)] text-[var(--accent-bright)]"
                : "border-b-2 border-transparent text-[var(--text-muted)] hover:text-[var(--text)]"
            }`}
          >
            <Icon className="h-4 w-4" aria-hidden="true" />
            {label}
          </button>
        ))}
      </div>

      {/* ── Obsah záložky ─────────────────────────────────────── */}
      {zalozka === "zive" ? (
        <div className="px-4 py-4 sm:px-6">
          <div
            className="flex items-center gap-2"
            role="group"
            aria-label="Kvalita obrazu"
          >
            {KVALITY.map(({ key, label, popis }) => (
              <button
                key={key}
                type="button"
                aria-pressed={kvalita === key}
                onClick={() => {
                  setVolba(key);
                  ulozKvalitu(key);
                }}
                title={popis}
                className={`border px-3 py-1 text-xs transition ${
                  kvalita === key
                    ? "border-[var(--accent-bright)] text-[var(--accent-bright)]"
                    : "border-[var(--line)] text-[var(--text-muted)] hover:border-[var(--line-strong)] hover:text-[var(--text)]"
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          <p className="mt-3 text-xs text-[var(--text-muted)]">
            {kvalita === "main"
              ? `Plné rozlišení. Když se obraz zadrhává, přepněte na plynulý — volba se pamatuje. Co bylo dřív, najdete v Přehrávání; kamera drží zhruba ${dosahDni} dní zpětně.`
              : `Vedlejší proud — nižší rozlišení, zato projde i po slabší lince. Co bylo dřív, najdete v Přehrávání; kamera drží zhruba ${dosahDni} dní zpětně.`}
          </p>
        </div>
      ) : null}

      {zalozka === "zaznam" ? (
        hydratovano ? (
          <>
          <Zachyt video={video} cameraName={cameraName} />
          <CasovaOsa
            hodnota={od}
            onZmena={nastavCas}
            dostupneOd={dostupneOd}
            nejpozdeji={nejpozdeji}
            detekce={denniDetekce}
          />
          </>
        ) : (
          <p className="px-4 py-6 text-xs text-[var(--text-muted)] sm:px-6">
            Načítá se časová osa…
          </p>
        )
      ) : null}

      {zalozka === "udalosti" ? (
        <SeznamUdalosti
          udalosti={udalosti}
          onSkok={(kdy) => {
            nastavCas(kdy);
            setZalozka("zaznam");
          }}
        />
      ) : null}
      </div>
    </div>
  );
}

/**
 * Vyfotit snímek nebo natočit klip do telefonu — jako v DMSS.
 *
 * ═══ Nabízí se jen to, co prohlížeč umí ════════════════════════════
 * Nahrávání stojí na `captureStream()` a `MediaRecorder`, které Safari
 * na iOS nemá. Tlačítko se proto na iPhonu vůbec neukáže: mrtvé
 * tlačítko je horší než chybějící, protože ho člověk zmáčkne, nic se
 * nestane a hledá chybu u sebe.
 *
 * Focení umí každý prohlížeč — plátno a JPEG. Snímek se ukládá
 * v nativním rozlišení proudu, ne v tom, jak je video velké na
 * displeji.
 */
function Zachyt({
  video,
  cameraName,
}: {
  video: HTMLVideoElement | null;
  cameraName: string;
}) {
  const [nahrava, setNahrava] = useState<Nahravani | null>(null);
  const [hlaska, setHlaska] = useState<string | null>(null);

  // Schopnosti prohlížeče se zjišťují až po hydrataci — na serveru
  // není `document` a vykreslit tam tlačítko, které pak zmizí, by byla
  // neshoda.
  const umiKlip = useSyncExternalStore(
    () => () => {},
    umiNahravat,
    () => false,
  );

  async function foto() {
    if (!video) return;
    try {
      await vyfot(video, cameraName);
      setHlaska("Snímek uložen.");
    } catch (chyba) {
      setHlaska(chyba instanceof Error ? chyba.message : "Nepodařilo se vyfotit.");
    }
  }

  function klip() {
    if (nahrava) {
      nahrava.stop();
      setNahrava(null);
      return;
    }
    if (!video) return;
    try {
      setHlaska(null);
      setNahrava(
        zacniNahravat(video, cameraName, (chyba) =>
          setHlaska(chyba ? chyba.message : "Klip uložen."),
        ),
      );
    } catch (chyba) {
      setHlaska(chyba instanceof Error ? chyba.message : "Nahrávání selhalo.");
    }
  }

  const tlacitko =
    "flex flex-1 flex-col items-center gap-1.5 py-3 text-[11px] transition " +
    "text-[var(--text-muted)] hover:text-[var(--text)] disabled:opacity-40";

  return (
    <div className="border-b border-[var(--line)]">
      <div className="flex">
        <button type="button" onClick={foto} disabled={!video} className={tlacitko}>
          <Camera className="h-5 w-5" aria-hidden="true" />
          Vyfotit
        </button>

        {umiKlip ? (
          <button
            type="button"
            onClick={klip}
            disabled={!video}
            className={`${tlacitko} ${nahrava ? "text-[var(--danger)]" : ""}`}
          >
            {nahrava ? (
              <Square className="h-5 w-5 fill-current" aria-hidden="true" />
            ) : (
              <VideoIcon className="h-5 w-5" aria-hidden="true" />
            )}
            {nahrava ? "Zastavit" : "Natočit"}
          </button>
        ) : null}
      </div>

      {hlaska ? (
        <p className="px-4 pb-3 text-center text-xs text-[var(--text-muted)] sm:px-6">
          {hlaska}
        </p>
      ) : null}
    </div>
  );
}

const TRIDY: Record<string, string> = {
  person: "Člověk",
  vehicle: "Vozidlo",
  unknown: "Neurčeno",
};

function SeznamUdalosti({
  udalosti,
  onSkok,
}: {
  udalosti: readonly UdalostRow[];
  onSkok: (kdy: Date) => void;
}) {
  if (udalosti.length === 0) {
    return (
      <div className="px-4 py-10 text-center sm:px-6">
        <ScanEye
          className="mx-auto h-6 w-6 text-[var(--text-muted)]"
          aria-hidden="true"
        />
        <p className="mt-3 text-sm text-[var(--text-muted)]">
          Žádné události
        </p>
        <p className="mt-1 text-xs text-[var(--text-muted)]">
          Kamera hlásí, když u ní někdo projde.
        </p>
      </div>
    );
  }

  return (
    <ul>
      {udalosti.map((u) => {
        const kdy = new Date(u.detected_at);
        return (
          <li key={u.id}>
            {/*
              Klepnutí skočí na ten okamžik v záznamu. To je celý smysl
              toho, že jsou události a přehrávání na jedné stránce:
              jinak si člověk musel čas opsat a najít ho ručně.
            */}
            <button
              type="button"
              onClick={() => onSkok(kdy)}
              className="flex w-full items-center gap-3 border-b border-[var(--line)] px-4 py-3 text-left transition hover:bg-[var(--surface-2)] sm:px-6"
            >
              <span
                className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--warning)]"
                aria-hidden="true"
              />
              <span className="tabular-nums text-sm text-[var(--text)]">
                {kdy.toLocaleTimeString("cs-CZ", { hour12: false })}
              </span>
              <span className="text-xs text-[var(--text-muted)]">
                {kdy.toLocaleDateString("cs-CZ", {
                  day: "numeric",
                  month: "numeric",
                })}
              </span>
              <span className="text-sm text-[var(--text-dim)]">
                {TRIDY[u.object_class] ?? u.object_class}
              </span>
              {u.ma_zaznam ? (
                <span className="ml-auto text-[10px] uppercase tracking-wider text-[var(--accent-bright)]">
                  klip
                </span>
              ) : null}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
