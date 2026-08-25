import type { ComponentProps, ReactNode } from "react";

// Tabulka v duchu design systému: žádné mezery mezi buňkami, dělí je
// vlasové linky. Na úzkém displeji se posouvá vodorovně uvnitř vlastního
// rámečku, aby se nerozjela celá stránka.

export function DataTable({
  head,
  children,
  caption,
}: {
  head: ReactNode;
  children: ReactNode;
  caption?: string;
}) {
  return (
    <div className="sm:overflow-x-auto sm:rounded-[var(--radius-card)] sm:border sm:border-[var(--border)] sm:bg-[var(--surface)]">
      <table className="stack-table w-full border-collapse text-sm sm:min-w-[720px]">
        {caption ? <caption className="sr-only">{caption}</caption> : null}
        <thead className="bg-[var(--surface-2)] text-left">
          <tr>{head}</tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

export function Th({ className = "", ...props }: ComponentProps<"th">) {
  return (
    <th
      scope="col"
      className={`border-b border-[var(--border)] px-4 py-3 font-medium text-[var(--text-muted)] whitespace-nowrap ${className}`}
      {...props}
    />
  );
}

export function Tr({ className = "", ...props }: ComponentProps<"tr">) {
  return (
    <tr
      className={`border-b border-[var(--border)] last:border-b-0 hover:bg-[var(--surface-2)]/50 ${className}`}
      {...props}
    />
  );
}

/**
 * Buňka. `label` se propíše do data-label a pod sm z něj vznikne
 * popisek vlevo v kartě — bez něj by hodnota v překlopené tabulce
 * neměla u sebe nic, co říká, co znamená.
 */
export function Td({
  className = "",
  label,
  ...props
}: ComponentProps<"td"> & { label?: string }) {
  return (
    <td
      data-label={label}
      className={`px-4 py-3 align-top ${className}`}
      {...props}
    />
  );
}

/** Údaj, který nemá lámat řádek (čas, sériové číslo). */
export function TdTight({
  className = "",
  ...props
}: ComponentProps<"td"> & { label?: string }) {
  return <Td className={`whitespace-nowrap ${className}`} {...props} />;
}
