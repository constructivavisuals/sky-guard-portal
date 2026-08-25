import Link from "next/link";

// Stránkování odkazy, ne tlačítky — stránka je součást adresy, takže
// jde poslat odkazem i otevřít v nové kartě.

export const PAGE_SIZE = 50;

export function pageFromParam(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? "1", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

/** Rozsah pro .range() v supabase-js. */
export function pageRange(page: number, size: number = PAGE_SIZE) {
  const from = (page - 1) * size;
  return { from, to: from + size - 1 };
}

export function Pagination({
  page,
  total,
  basePath,
  size = PAGE_SIZE,
}: {
  page: number;
  total: number;
  basePath: string;
  size?: number;
}) {
  const pages = Math.max(1, Math.ceil(total / size));
  if (pages <= 1) return null;

  const first = (page - 1) * size + 1;
  const last = Math.min(page * size, total);

  const linkClass =
    "inline-flex h-9 items-center rounded-[var(--radius-pill)] border border-[var(--line-strong)] px-4 text-[13px] tracking-tight transition hover:border-[var(--text-muted)] hover:bg-[var(--surface-2)]";
  const disabledClass =
    "inline-flex h-9 items-center rounded-[var(--radius-pill)] border border-[var(--line)] px-4 text-[13px] tracking-tight opacity-40 pointer-events-none";

  return (
    <nav
      aria-label="Stránkování"
      className="flex flex-wrap items-center justify-between gap-4 border-t border-[var(--line)] px-5 py-4 text-[13px] sm:px-8"
    >
      <p className="text-[var(--text-muted)]">
        {first}–{last} z {total}
      </p>
      <div className="flex items-center gap-2">
        {page > 1 ? (
          <Link href={`${basePath}?strana=${page - 1}`} className={linkClass}>
            Předchozí
          </Link>
        ) : (
          <span className={disabledClass}>Předchozí</span>
        )}
        <span className="text-[var(--text-muted)]">
          {page} / {pages}
        </span>
        {page < pages ? (
          <Link href={`${basePath}?strana=${page + 1}`} className={linkClass}>
            Další
          </Link>
        ) : (
          <span className={disabledClass}>Další</span>
        )}
      </div>
    </nav>
  );
}
