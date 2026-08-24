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
    <div className="overflow-x-auto rounded-[var(--radius-card)] border border-[var(--border)] bg-[var(--surface)]">
      <table className="w-full min-w-[720px] border-collapse text-sm">
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

export function Td({ className = "", ...props }: ComponentProps<"td">) {
  return <td className={`px-4 py-3 align-top ${className}`} {...props} />;
}

/** Údaj, který nemá lámat řádek (čas, sériové číslo). */
export function TdTight({ className = "", ...props }: ComponentProps<"td">) {
  return <Td className={`whitespace-nowrap ${className}`} {...props} />;
}
