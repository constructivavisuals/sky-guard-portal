import { ChevronDown, LogOut } from "lucide-react";

import { Button } from "@/components/ui.tsx";

/**
 * Stav střežení. `armed` je ostrý režim, `alarm` běžící poplach —
 * jediné místo mimo primární tlačítko, kde se smí objevit záře.
 */
export type GuardState = "armed" | "disarmed" | "alarm";

const GUARD_LABELS: Record<GuardState, string> = {
  armed: "Střeženo",
  disarmed: "Nestřeženo",
  alarm: "Poplach",
};

function GuardBadge({ state }: { state: GuardState }) {
  const styles: Record<GuardState, string> = {
    armed:
      "border-[var(--success)]/40 text-[var(--success)] bg-[var(--success)]/10",
    disarmed: "border-[var(--border)] text-[var(--text-muted)]",
    alarm:
      "border-[var(--danger)] text-white bg-[var(--danger)] shadow-[var(--glow-danger)]",
  };

  return (
    <span
      className={`inline-flex items-center gap-2 rounded-full border px-3 h-8 text-xs font-semibold ${styles[state]}`}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${
          state === "armed"
            ? "bg-[var(--success)]"
            : state === "alarm"
              ? "bg-white animate-pulse"
              : "bg-[var(--text-muted)]"
        }`}
        aria-hidden="true"
      />
      {GUARD_LABELS[state]}
    </span>
  );
}

export function Topbar({
  siteName,
  guardState,
}: {
  siteName: string;
  guardState: GuardState;
}) {
  return (
    <header className="flex h-16 shrink-0 items-center justify-between gap-4 border-b border-[var(--border)] bg-[var(--surface)] px-6">
      <div className="flex items-center gap-3 min-w-0">
        {/* Přepínač lokality — zatím jen kostra, bez dat. */}
        <button
          type="button"
          className="inline-flex items-center gap-2 rounded-lg px-3 h-9 text-sm font-medium hover:bg-[var(--surface-2)] transition min-w-0"
        >
          <span className="truncate">{siteName}</span>
          <ChevronDown
            className="h-4 w-4 shrink-0 text-[var(--text-muted)]"
            aria-hidden="true"
          />
        </button>
        <GuardBadge state={guardState} />
      </div>

      <form action="/auth/odhlaseni" method="post">
        <Button type="submit" variant="ghost" className="px-3">
          <LogOut className="h-4 w-4" aria-hidden="true" />
          <span className="sr-only sm:not-sr-only">Odhlásit</span>
        </Button>
      </form>
    </header>
  );
}
