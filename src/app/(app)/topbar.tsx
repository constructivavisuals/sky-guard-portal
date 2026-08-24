import { ChevronDown, LogOut, Menu } from "lucide-react";

import { Button } from "@/components/ui.tsx";

/**
 * Stav střežení. `armed` je ostrý režim, `alarm` běžící poplach —
 * jediné místo mimo primární tlačítko, kde se smí objevit záře.
 *
 * `unknown` je samostatný stav schválně: když se stav nepodaří zjistit
 * (nedostupná databáze, žádná lokalita), nesmí to vypadat stejně jako
 * ověřené „nestřeženo“. Obojí je šedé, ale popisek se liší.
 */
export type GuardState = "armed" | "disarmed" | "alarm" | "unknown";

const GUARD_LABELS: Record<GuardState, string> = {
  armed: "Střeženo",
  disarmed: "Nestřeženo",
  alarm: "Poplach",
  unknown: "Stav neznámý",
};

function GuardBadge({ state }: { state: GuardState }) {
  const styles: Record<GuardState, string> = {
    armed:
      "border-[var(--success)]/40 text-[var(--success)] bg-[var(--success)]/10",
    disarmed: "border-[var(--border)] text-[var(--text-muted)]",
    unknown: "border-[var(--border)] text-[var(--text-muted)]",
    alarm:
      "border-[var(--danger)] text-white bg-[var(--danger)] shadow-[var(--glow-danger)]",
  };

  // Na úzkém displeji zbývá jen tečka; text se vrací od sm. Popisek
  // zůstává ve stromu pro odečítač i tehdy, když není vidět.
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-2 rounded-full border h-8 px-2 sm:px-3 text-xs font-semibold ${styles[state]}`}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${
          state === "armed"
            ? "bg-[var(--success)]"
            : state === "alarm"
              ? "bg-white animate-pulse"
              : // nestřeženo i neznámý stav jsou šedé
                "bg-[var(--text-muted)]"
        }`}
        aria-hidden="true"
      />
      <span className="sr-only sm:not-sr-only">{GUARD_LABELS[state]}</span>
    </span>
  );
}

export function Topbar({
  siteName,
  guardState,
  menuOpen,
  onMenuToggle,
}: {
  siteName: string;
  guardState: GuardState;
  menuOpen: boolean;
  onMenuToggle: () => void;
}) {
  return (
    <header className="flex h-16 shrink-0 items-center justify-between gap-2 border-b border-[var(--border)] bg-[var(--surface)] px-3 sm:px-6">
      <div className="flex items-center gap-1 sm:gap-3 min-w-0">
        <button
          type="button"
          onClick={onMenuToggle}
          aria-label="Otevřít menu"
          aria-expanded={menuOpen}
          className="-ml-1 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-[var(--text-muted)] hover:bg-[var(--surface-2)] hover:text-[var(--text)] lg:hidden"
        >
          <Menu className="h-5 w-5" aria-hidden="true" />
        </button>

        {/* Přepínač lokality — zatím jen kostra, bez dat. */}
        <button
          type="button"
          className="inline-flex items-center gap-2 rounded-lg px-2 sm:px-3 h-9 text-sm font-medium hover:bg-[var(--surface-2)] transition min-w-0"
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
