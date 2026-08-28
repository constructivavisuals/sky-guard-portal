"use client";

import { useRef } from "react";

import { formatDateTime } from "@/lib/format.ts";
import { positionPercent, timeAtPercent } from "@/lib/recordings/playback.ts";
import { recordingPlayback } from "@/lib/recordings/storage.ts";
import {
  TIMELINE_HOURS,
  timelineSegments,
  type DayString,
} from "@/lib/recordings/timeline.ts";

// Osa dne: kdy se v ten den natáčelo, a zároveň ovládání přehrávače.
//
// Číst deset řádků tabulky a poskládat si z časů obrázek dne jde těžko;
// osa to řekne na jeden pohled — kde je hluchý úsek a kde se pohyb
// nahromadil. Sedí přesně na den lokality, viz lib/recordings/timeline.ts.
//
// ═══ Dvě role, jedna komponenta ════════════════════════════════════
// Bez `onSeek` je to obrázek. S ním je to posuvník přes celý den:
// klikne se kamkoli a přehrávač skočí na TEN ČAS, ne na soubor pod
// kurzorem. Který soubor to je, se uživatel nedozví a nemá ho to
// zajímat — je to detail toho, jak kamera data ukládá.
//
// Že je to jedna komponenta a ne dvě, je schválně: dvě kopie kreslení
// segmentů by se při první úpravě rozešly a diagnostický pohled by
// ukazoval jiný den než přehrávač.

interface Row {
  id: string;
  started_at: string;
  ended_at: string | null;
  storage_path: string | null;
  uploaded_at: string | null;
  video_expired_at: string | null;
  cameras: { name: string; sites: { timezone: string } | null } | null;
}

/** O kolik popojede šipka na klávesnici. Minuta je pod jedním pixelem. */
const KROK_MS = 60_000;
const VELKY_KROK_MS = 15 * KROK_MS;

export function DayTimeline({
  day,
  rows,
  range,
  timeZone,
  playheadMs,
  onSeek,
}: {
  day: DayString;
  rows: readonly Row[];
  range: { from: Date; to: Date };
  timeZone: string | undefined;
  /** Kde stojí přehrávání. Bez něj se ukazatel nekreslí. */
  playheadMs?: number | null;
  /** Když chybí, je osa jen obrázek. */
  onSeek?: (timeMs: number) => void;
}) {
  const segments = timelineSegments(rows, range);
  const bar = useRef<HTMLDivElement>(null);

  const playhead =
    playheadMs === null || playheadMs === undefined
      ? null
      : positionPercent(playheadMs, range);

  function seekZUdalosti(clientX: number) {
    const prvek = bar.current;
    if (!prvek || !onSeek) return;
    const rect = prvek.getBoundingClientRect();
    if (rect.width <= 0) return;
    onSeek(timeAtPercent(((clientX - rect.left) / rect.width) * 100, range));
  }

  function klavesa(event: React.KeyboardEvent) {
    if (!onSeek) return;
    const ted = playheadMs ?? range.from.getTime();
    const krok = event.shiftKey ? VELKY_KROK_MS : KROK_MS;

    const posun: Record<string, number> = {
      ArrowRight: krok,
      ArrowLeft: -krok,
      PageUp: VELKY_KROK_MS,
      PageDown: -VELKY_KROK_MS,
    };

    if (event.key in posun) {
      event.preventDefault();
      onSeek(ted + posun[event.key]);
      return;
    }
    if (event.key === "Home") {
      event.preventDefault();
      onSeek(range.from.getTime());
    }
    if (event.key === "End") {
      event.preventDefault();
      onSeek(range.to.getTime());
    }
  }

  return (
    <div className="px-5 py-5 sm:px-6">
      <div className="mb-2 flex items-baseline justify-between gap-4">
        <span className="text-[11px] font-medium uppercase tracking-[0.12em] text-[var(--text-muted)]">
          Osa dne
        </span>
        <span className="text-xs text-[var(--text-muted)] tabular-nums">{day}</span>
      </div>

      <div
        ref={bar}
        className={`relative h-12 border border-[var(--line)] bg-[var(--surface)] ${
          onSeek
            ? "cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-bright)]"
            : ""
        }`}
        {...(onSeek
          ? {
              // Posuvník, ne tlačítko: hodnota je čas a dá se po ní
              // jezdit šipkami. Odečítá se jako čas dne, ne jako číslo.
              role: "slider",
              tabIndex: 0,
              "aria-label": "Čas v ose dne",
              "aria-valuemin": range.from.getTime(),
              "aria-valuemax": range.to.getTime(),
              "aria-valuenow": playheadMs ?? range.from.getTime(),
              "aria-valuetext": formatDateTime(
                new Date(playheadMs ?? range.from.getTime()).toISOString(),
                timeZone,
              ),
              onClick: (e: React.MouseEvent) => seekZUdalosti(e.clientX),
              onKeyDown: klavesa,
            }
          : {})}
      >
        {/* Hodinové rysky. Ne všech 24 — na mobilu by se slily. */}
        {TIMELINE_HOURS.map((hour) => (
          <div
            key={hour}
            className="absolute top-0 bottom-0 border-l border-[var(--line)]"
            style={{ left: `${(hour / 24) * 100}%` }}
            aria-hidden="true"
          />
        ))}

        {segments.map(({ row, left, width }) => {
          const stav = recordingPlayback(row);
          return (
            <div
              key={row.id}
              className={`absolute top-1 bottom-1 ${
                stav === "ready"
                  ? "bg-[var(--accent-bright)]"
                  : stav === "pending"
                    ? "bg-[var(--warning)]"
                    : "bg-[var(--text-muted)]/50"
              }`}
              style={{ left: `${left}%`, width: `${width}%` }}
              title={`${formatDateTime(row.started_at, timeZone)} — ${
                row.cameras?.name ?? "kamera"
              }`}
              // Segment nesmí brát klik na sebe: klikáním se vybírá ČAS,
              // ne soubor. Bez tohohle by se kurzor nad záznamem choval
              // jinak než nad mezerou.
              aria-hidden="true"
            />
          );
        })}

        {playhead === null ? null : (
          <div
            className="pointer-events-none absolute -top-0.5 -bottom-0.5 w-0.5 bg-[var(--text)] shadow-[0_0_0_1px_var(--surface)]"
            style={{ left: `${playhead}%` }}
            aria-hidden="true"
          />
        )}
      </div>

      <div className="mt-1 flex justify-between text-[10px] tabular-nums text-[var(--text-muted)]">
        {TIMELINE_HOURS.map((hour) => (
          <span key={hour}>{String(hour).padStart(2, "0")}:00</span>
        ))}
        <span>24:00</span>
      </div>
    </div>
  );
}
