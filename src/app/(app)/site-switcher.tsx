"use client";

import { Check, ChevronDown } from "lucide-react";
import { useState } from "react";

import { ALL_SITES, type SiteOption } from "@/lib/site.ts";

import { selectSite } from "./actions.ts";

/**
 * Přepínač lokality. Každá položka je vlastní formulář nad server
 * akcí — díky tomu přepnutí funguje i bez JS a cookie se nastavuje
 * na serveru, takže filtr platí hned při dalším vykreslení.
 */
export function SiteSwitcher({
  sites,
  selectedId,
  label,
}: {
  sites: SiteOption[];
  selectedId: string | null;
  label: string;
}) {
  const [open, setOpen] = useState(false);
  const disabled = sites.length === 0;

  return (
    <div className="relative min-w-0">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        className="inline-flex items-center gap-2 rounded-lg px-2 sm:px-3 h-9 text-sm font-medium hover:bg-[var(--surface-2)] transition min-w-0 disabled:opacity-60 disabled:pointer-events-none"
      >
        <span className="truncate">{label}</span>
        <ChevronDown
          className="h-4 w-4 shrink-0 text-[var(--text-muted)]"
          aria-hidden="true"
        />
      </button>

      {open ? (
        <>
          <button
            type="button"
            aria-label="Zavřít výběr lokality"
            onClick={() => setOpen(false)}
            className="fixed inset-0 z-40 cursor-default"
          />
          <div
            role="menu"
            className="absolute left-0 top-full z-50 mt-1 w-64 overflow-hidden rounded-[var(--radius-card)] border border-[var(--border)] bg-[var(--surface)] p-1 shadow-xl"
          >
            <Option
              siteId={ALL_SITES}
              label="Všechny lokality"
              active={selectedId === null}
              onSubmit={() => setOpen(false)}
            />
            <div className="my-1 h-px bg-[var(--border)]" />
            {sites.map((site) => (
              <Option
                key={site.id}
                siteId={site.id}
                label={site.name}
                active={site.id === selectedId}
                onSubmit={() => setOpen(false)}
              />
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}

function Option({
  siteId,
  label,
  active,
  onSubmit,
}: {
  siteId: string;
  label: string;
  active: boolean;
  onSubmit: () => void;
}) {
  return (
    <form action={selectSite} onSubmit={onSubmit}>
      <input type="hidden" name="siteId" value={siteId} />
      <button
        type="submit"
        role="menuitem"
        aria-current={active ? "true" : undefined}
        className={`flex w-full items-center justify-between gap-2 rounded-lg px-3 h-9 text-left text-sm transition ${
          active
            ? "bg-[var(--surface-2)] font-medium"
            : "text-[var(--text-muted)] hover:bg-[var(--surface-2)] hover:text-[var(--text)]"
        }`}
      >
        <span className="truncate">{label}</span>
        {active ? (
          <Check className="h-4 w-4 shrink-0 text-[var(--accent)]" aria-hidden="true" />
        ) : null}
      </button>
    </form>
  );
}
