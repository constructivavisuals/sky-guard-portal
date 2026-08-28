"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { Maximize2, Pause, Play, Video } from "lucide-react";

import { formatClock } from "@/lib/format.ts";
import {
  absoluteTime,
  buildPlaylist,
  cameraIds,
  locateTime,
  nextIndex,
} from "@/lib/recordings/playback.ts";
import type { DayString } from "@/lib/recordings/timeline.ts";

import { DayTimeline } from "./timeline.tsx";

// Souvislý přehrávač dne.
//
// ═══ Co se před klientem schovává ══════════════════════════════════
// Že kamera nahrává po osmiminutových kusech. To je detail toho, jak se
// data vozí; klient chce vidět den. Osa je proto posuvník přes celých
// 24 hodin, čas nad obrazem je SKUTEČNÝ čas záznamu (ne pozice
// v souboru) a na konci souboru se navazuje samo.
//
// Seznam souborů zůstává jako druhý pohled — při montáži se podle něj
// ověřuje, že řetěz kamera → relay → portál šlape, a tam je naopak
// potřeba vidět každý kus zvlášť.
//
// ═══ Proč DVA prvky <video> ════════════════════════════════════════
// S jedním by se na každé hranici souboru přepsal `src`, prohlížeč by
// znovu navazoval spojení, stahoval hlavičku a dekodér by najížděl —
// každých osm minut viditelné cuknutí. Proto se střídají dva: v jednom
// se hraje, do druhého se mezitím načítá další. Na `ended` se jen
// prohodí, který je vidět.
//
// Skrytý prvek se NESMÍ schovat přes `display: none` — takový prvek
// prohlížeč nemusí přednačítat a celé zdvojení by bylo k ničemu.
// Proto průhlednost.

interface Row {
  id: string;
  camera_id: string;
  started_at: string;
  ended_at: string | null;
  storage_path: string | null;
  uploaded_at: string | null;
  video_expired_at: string | null;
  cameras: { name: string; sites: { timezone: string } | null } | null;
}

export function ContinuousPlayer({
  day,
  rows,
  range,
  timeZone,
}: {
  day: DayString;
  rows: readonly Row[];
  range: { from: Date; to: Date };
  timeZone: string | undefined;
}) {
  const clips = useMemo(() => buildPlaylist(rows), [rows]);
  const kamer = useMemo(() => cameraIds(rows).length, [rows]);

  const prvni = useRef<HTMLVideoElement>(null);
  const druhy = useRef<HTMLVideoElement>(null);

  /** Který prvek je vidět a hraje. */
  const [aktivni, setAktivni] = useState(0);
  /** Index souboru v aktivním prvku. */
  const [index, setIndex] = useState<number | null>(clips.length > 0 ? 0 : null);
  const [hraje, setHraje] = useState(false);
  /** Skutečný čas záznamu, ms. */
  const [cas, setCas] = useState<number | null>(
    clips.length > 0 ? clips[0].startsAt : null,
  );
  /** Kam se to muselo posunout, když klik padl do mezery. */
  const [preskok, setPreskok] = useState<number | null>(null);

  /** Kam se má skočit, jakmile prohlížeč načte hlavičku souboru. */
  const cekaSeek = useRef<number | null>(null);
  /** Má se po načtení rovnou hrát? */
  const cekaPlay = useRef(false);

  const video = useCallback(
    (slot: number) => (slot === 0 ? prvni.current : druhy.current),
    [],
  );

  // ── Adresy se NEDRŽÍ ve stavu ───────────────────────────────────
  //
  // Plynou z indexu: aktivní prvek hraje `clips[index]`, ten druhý má
  // přednačtený `clips[index + 1]`. Po prohození si nový aktivní nese
  // TÉŽ adresu, jakou měl — React tedy atribut nesáhne a přehrávání
  // nepřeruší. Kdyby to byl stav, musel by se s indexem synchronizovat
  // efektem a rozjezd by šel o render pozadu.
  const zdroje: [string | null, string | null] = [null, null];
  if (index !== null) {
    zdroje[aktivni] = clips[index]?.src ?? null;
    zdroje[1 - aktivni] = clips[index + 1]?.src ?? null;
  }

  /**
   * Skok na daný čas dne.
   *
   * Uvnitř téhož souboru je to prosté přetočení. Jinam se musí načíst
   * nový — a offset se uplatní až na `loadedmetadata`, protože do té
   * doby prohlížeč délku nezná a `currentTime` by zahodil.
   */
  const skoc = useCallback(
    (timeMs: number, prehrat: boolean) => {
      const kam = locateTime(clips, timeMs);
      if (!kam) return;

      const clip = clips[kam.index];
      setPreskok(kam.snapped ? clip.startsAt + kam.offsetSec * 1000 : null);
      setCas(absoluteTime(clip, kam.offsetSec));

      const prvek = video(aktivni);

      if (kam.index === index && prvek) {
        // Týž soubor: přetočit. Ořezat SKUTEČNOU délkou — údaj
        // z databáze je odhad a seek za konec video zasekne.
        const strop = Number.isFinite(prvek.duration) ? prvek.duration : kam.offsetSec;
        prvek.currentTime = Math.min(kam.offsetSec, Math.max(0, strop - 0.05));
        if (prehrat) void prvek.play();
        return;
      }

      cekaSeek.current = kam.offsetSec;
      cekaPlay.current = prehrat;
      setIndex(kam.index);
    },
    [clips, index, aktivni, video],
  );

  /**
   * Konec souboru: prohodit prvky a hrát dál.
   *
   * Mezera se přeskakuje — po dojetí se navazuje hned dalším, i když
   * mezi nimi byly dvě hodiny ticha. Čas nad obrazem přitom skočí,
   * a to je správně: ukazuje, kdy se to natočilo.
   */
  function dojel() {
    if (index === null) return;

    const dalsi = nextIndex(clips, index);
    if (dalsi === null) {
      setHraje(false);
      return;
    }

    const novy = 1 - aktivni;
    setAktivni(novy);
    setIndex(dalsi);
    setPreskok(null);
    setCas(clips[dalsi].startsAt);

    // Přednačtený prvek se rozjede hned. Uvolněný dostane při dalším
    // renderu adresu toho po něm, takže je připravený na příští hranici.
    void video(novy)?.play();

    // Nutně ručně: dojíždějící soubor vyfiří `pause` TĚSNĚ PŘED `ended`
    // (tak to má HTML spec), takže si `hraje` právě přepnul na false.
    // Bez tohohle by tlačítko nabízelo „přehrát“ nad běžícím videem.
    setHraje(true);
  }

  function nacetlHlavicku() {
    const prvek = video(aktivni);
    if (!prvek) return;

    if (cekaSeek.current !== null) {
      const strop = Number.isFinite(prvek.duration) ? prvek.duration : cekaSeek.current;
      prvek.currentTime = Math.min(cekaSeek.current, Math.max(0, strop - 0.05));
      cekaSeek.current = null;
    }
    if (cekaPlay.current) {
      cekaPlay.current = false;
      void prvek.play();
    }
  }

  function bezi() {
    const prvek = video(aktivni);
    if (!prvek || index === null) return;
    setCas(absoluteTime(clips[index], prvek.currentTime));
  }

  function prepnoutPrehravani() {
    const prvek = video(aktivni);
    if (!prvek) return;
    if (prvek.paused) void prvek.play();
    else prvek.pause();
  }

  if (clips.length === 0) {
    return (
      <div className="px-5 py-8 text-center text-sm text-[var(--text-muted)] sm:px-6">
        <Video className="mx-auto mb-2 h-5 w-5" aria-hidden="true" />
        Z tohohle dne není co přehrát — soubory buď ještě nedorazily, nebo jsou po lhůtě.
      </div>
    );
  }

  // Dvě kamery natáčejí týž čas současně, takže „co běželo ve tři“ nemá
  // jednu odpověď a segmenty na ose se překrývají. Filtr kamer je hned
  // nad tím, tak se na něj odkážeme místo druhého vlastního přepínače.
  if (kamer > 1) {
    return (
      <>
        <DayTimeline day={day} rows={rows} range={range} timeZone={timeZone} />
        <div className="px-5 pb-5 text-sm text-[var(--text-muted)] sm:px-6">
          Souvislé přehrávání jde jen po jedné kameře — v ten den natáčelo{" "}
          {kamer} kamer a jejich záznamy se v čase překrývají. Vyberte kameru
          filtrem nahoře.
        </div>
      </>
    );
  }

  return (
    <div>
      <div className="relative aspect-video bg-black">
        {[0, 1].map((slot) => (
          <video
            key={slot}
            ref={slot === 0 ? prvni : druhy}
            src={zdroje[slot] ?? undefined}
            // Aktivní se dívá, neaktivní se mezitím stahuje.
            preload="auto"
            playsInline
            className={`absolute inset-0 h-full w-full ${
              slot === aktivni ? "" : "pointer-events-none opacity-0"
            }`}
            onLoadedMetadata={slot === aktivni ? nacetlHlavicku : undefined}
            onTimeUpdate={slot === aktivni ? bezi : undefined}
            onEnded={slot === aktivni ? dojel : undefined}
            // Na OBOU, bez podmínky na aktivní: v okamžiku prohození
            // ještě neproběhl render, takže by nový aktivní prvek svůj
            // `play` neměl komu ohlásit. Skrytý prvek se jen přednačítá
            // a nehraje, tak odsud nic falešného nepřijde.
            onPlay={() => setHraje(true)}
            onPause={() => setHraje(false)}
          />
        ))}
      </div>

      {/* ── Ovládání ────────────────────────────────────────────────
          Vlastní, ne `controls`: nativní lišta ukazuje pozici
          V SOUBORU (0:00–8:00), tedy přesně ten detail, který se má
          schovat. Posuvníkem je osa dne pod tím. */}
      <div className="flex items-center gap-4 px-5 py-3 sm:px-6">
        <button
          type="button"
          onClick={prepnoutPrehravani}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[var(--surface-3)] text-[var(--text)] transition hover:bg-[var(--surface-2)]"
          aria-label={hraje ? "Pozastavit" : "Přehrát"}
        >
          {hraje ? (
            <Pause className="h-4 w-4" aria-hidden="true" />
          ) : (
            <Play className="h-4 w-4" aria-hidden="true" />
          )}
        </button>

        <div className="min-w-0">
          {/* Skutečný čas záznamu, ne pozice v souboru. To je celý smysl
              téhle obrazovky. */}
          <div className="text-xl font-medium leading-tight tabular-nums">
            {formatClock(cas, timeZone)}
          </div>
          <div className="text-xs text-[var(--text-muted)]">
            {preskok === null
              ? (clips[index ?? 0]?.cameraName ?? "Kamera")
              : `V tu dobu se nenatáčelo — posunuto na ${formatClock(preskok, timeZone)}`}
          </div>
        </div>

        <button
          type="button"
          onClick={() => void video(aktivni)?.requestFullscreen?.()}
          className="ml-auto flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[var(--text-muted)] transition hover:bg-[var(--surface-2)] hover:text-[var(--text)]"
          aria-label="Na celou obrazovku"
        >
          <Maximize2 className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>

      <DayTimeline
        day={day}
        rows={rows}
        range={range}
        timeZone={timeZone}
        playheadMs={cas}
        onSeek={(timeMs) => skoc(timeMs, hraje)}
      />
    </div>
  );
}
