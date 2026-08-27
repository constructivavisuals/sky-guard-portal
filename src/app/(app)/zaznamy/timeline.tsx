import { formatDateTime } from "@/lib/format.ts";
import {
  TIMELINE_HOURS,
  timelineSegments,
  type DayString,
} from "@/lib/recordings/timeline.ts";
import { recordingPlayback } from "@/lib/recordings/storage.ts";

// Osa dne: kdy se v ten den natáčelo.
//
// Číst deset řádků tabulky a poskládat si z časů obrázek dne jde těžko;
// osa to řekne na jeden pohled — kde je hluchý úsek a kde se pohyb
// nahromadil. Sedí přesně na den lokality, viz lib/recordings/timeline.ts.

interface Row {
  id: string;
  started_at: string;
  ended_at: string | null;
  storage_path: string | null;
  uploaded_at: string | null;
  video_expired_at: string | null;
  cameras: { name: string; sites: { timezone: string } | null } | null;
}

export function DayTimeline({
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
  const segments = timelineSegments(rows, range);

  return (
    <div className="px-5 py-5 sm:px-6">
      <div className="mb-2 flex items-baseline justify-between gap-4">
        <span className="text-[11px] font-medium uppercase tracking-[0.12em] text-[var(--text-muted)]">
          Osa dne
        </span>
        <span className="text-xs text-[var(--text-muted)] tabular-nums">{day}</span>
      </div>

      <div className="relative h-12 border border-[var(--line)] bg-[var(--surface)]">
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
            />
          );
        })}
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
