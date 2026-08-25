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
        className="inline-flex h-9 min-w-0 items-center gap-2 border border-[var(--line-strong)] px-3 text-sm font-medium tracking-tight transition hover:bg-[var(--surface-2)] disabled:pointer-events-none disabled:opacity-60"
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
            className="absolute left-0 top-full z-50 mt-1 w-64 overflow-hidden border border-[var(--line-strong)] bg-[var(--surface)] shadow-[0_20px_60px_rgba(0,0,0,0.7)]"
          >
            <Option
              siteId={ALL_SITES}
              label="Všechny lokality"
              active={selectedId === null}
              onSubmit={() => setOpen(false)}
            />
            <div className="h-px bg-[var(--line)]" />
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
        className={`flex h-10 w-full items-center justify-between gap-2 border-b border-[var(--line)] px-4 text-left text-sm tracking-tight transition last:border-b-0 ${
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
