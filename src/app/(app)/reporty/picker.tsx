"use client";

import { useRouter } from "next/navigation";
import { FileDown } from "lucide-react";

import { Button } from "@/components/ui.tsx";
import type { SiteOption } from "@/lib/site.ts";

// Výběr lokality a měsíce.
//
// Volba je součást adresy, ne stavu komponenty: report jde poslat
// odkazem a otevřít v nové kartě, a náhled se vykresluje na serveru
// z týchž dat jako PDF.

export function ReportPicker({
  sites,
  siteId,
  month,
  months,
}: {
  sites: SiteOption[];
  siteId: string;
  month: string;
  months: { value: string; label: string }[];
}) {
  const router = useRouter();

  const prejit = (novaLokalita: string, novyMesic: string) => {
    router.push(`/reporty?lokalita=${novaLokalita}&mesic=${novyMesic}`);
  };

  return (
    <div className="flex flex-wrap items-end gap-3">
      <label className="min-w-0">
        <span className="mb-1.5 block text-[11px] font-medium uppercase tracking-[0.1em] text-[var(--text-muted)]">
          Lokalita
        </span>
        <select
          value={siteId}
          onChange={(event) => prejit(event.target.value, month)}
          className="h-10 min-w-[12rem] border border-[var(--line-strong)] bg-[var(--surface)] px-3 text-sm"
        >
          {sites.map((site) => (
            <option key={site.id} value={site.id}>
              {site.name}
            </option>
          ))}
        </select>
      </label>

      <label className="min-w-0">
        <span className="mb-1.5 block text-[11px] font-medium uppercase tracking-[0.1em] text-[var(--text-muted)]">
          Měsíc
        </span>
        <select
          value={month}
          onChange={(event) => prejit(siteId, event.target.value)}
          className="h-10 min-w-[10rem] border border-[var(--line-strong)] bg-[var(--surface)] px-3 text-sm"
        >
          {months.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>

      {/* Obyčejný odkaz, ne fetch: prohlížeč si s PDF poradí sám —
          ukáže ho ve své čtečce a stáhnout jde pořád. */}
      <a href={`/api/reporty?lokalita=${siteId}&mesic=${month}`} target="_blank" rel="noreferrer">
        <Button type="button">
          <FileDown className="h-4 w-4" aria-hidden="true" />
          Stáhnout PDF
        </Button>
      </a>
    </div>
  );
}
