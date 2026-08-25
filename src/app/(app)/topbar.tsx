import { isOperator, type CurrentProfile } from "@/lib/profile.ts";
import type { SiteOption } from "@/lib/site.ts";

import { SiteSwitcher } from "./site-switcher.tsx";

/**
 * Stav střežení. `armed` je ostrý režim, `alarm` běžící poplach —
 * jediné místo mimo primární tlačítko, kde se smí objevit záře.
 *
 * `unknown` je samostatný stav schválně: když se stav nepodaří zjistit
 * (nedostupná databáze, žádná lokalita), nesmí to vypadat stejně jako
 * ověřené „nestřeženo“. Obojí je tlumené, ale popisek se liší.
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
      "border-[var(--success)]/40 text-[var(--success)] bg-[var(--success)]/[0.08]",
    disarmed: "border-[var(--line-strong)] text-[var(--text-muted)]",
    unknown: "border-[var(--line-strong)] text-[var(--text-muted)]",
    alarm:
      "border-[var(--danger)] text-white bg-[var(--danger)] shadow-[var(--glow-danger)]",
  };

  // Na úzkém displeji zbývá jen tečka; text se vrací od sm. Popisek
  // zůstává ve stromu pro odečítač i tehdy, když není vidět.
  return (
    <span
      className={`inline-flex h-7 shrink-0 items-center gap-2 rounded-[var(--radius-pill)] border px-2 text-[11px] font-medium uppercase tracking-[0.1em] sm:px-3 ${styles[state]}`}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${
          state === "armed"
            ? "bg-[var(--success)]"
            : state === "alarm"
              ? "animate-pulse bg-white"
              : // nestřeženo i neznámý stav jsou tlumené
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
  siteOptions,
  selectedSiteId,
  guardState,
  profile,
}: {
  siteName: string;
  siteOptions: SiteOption[];
  selectedSiteId: string | null;
  guardState: GuardState;
  profile: CurrentProfile | null;
}) {
  // Admin a operátor přepínač mají vždycky — i s jedinou lokalitou
  // potřebují volbu „Všechny lokality“, protože pracují napříč areály
  // a bez ní by se k nefiltrovanému pohledu nedostali.
  //
  // Klientovi s jedinou lokalitou by nabízel jeho areál a „všechny“,
  // což je totéž; pro něj tam zůstává jen název. S víc lokalitami ho
  // dostane taky, jinak by mezi nimi neměl jak přepnout.
  const showSwitcher = isOperator(profile) || siteOptions.length > 1;

  return (
    <header className="flex h-16 shrink-0 items-center justify-between gap-2 border-b border-[var(--line)] bg-[var(--bg)] px-4 sm:px-8">
      <div className="flex min-w-0 items-center gap-3">
        {showSwitcher ? (
          <SiteSwitcher
            sites={siteOptions}
            selectedId={selectedSiteId}
            label={siteName}
          />
        ) : (
          <span className="truncate text-sm font-medium tracking-tight">
            {siteName}
          </span>
        )}
        <GuardBadge state={guardState} />
      </div>
    </header>
  );
}
