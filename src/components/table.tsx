import type { ComponentProps, ReactNode } from "react";

// Tabulka v duchu design systému: žádné mezery mezi buňkami, dělí je
// vlasové linky, které navazují na linky mezi bloky stránky. Proto tu
// není ani rámeček, ani zaoblení — tabulka sedí přímo v bloku a její
// řádky pokračují v témž rastru.
//
// Na úzkém displeji se pod sm překlápí na karty; vodorovné posouvání
// se prstem neovládá dobře, viz .stack-table v globals.css.

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
    <div className="sm:overflow-x-auto">
      <table className="stack-table w-full border-collapse text-sm sm:min-w-[720px]">
        {caption ? <caption className="sr-only">{caption}</caption> : null}
        <thead className="text-left">
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
      className={`whitespace-nowrap border-b border-[var(--line)] bg-[var(--surface-2)] px-5 py-3 text-[11px] font-medium uppercase tracking-[0.12em] text-[var(--text-muted)] ${className}`}
      {...props}
    />
  );
}

export function Tr({ className = "", ...props }: ComponentProps<"tr">) {
  return (
    <tr
      className={`border-b border-[var(--line)] transition-colors last:border-b-0 hover:bg-[var(--surface-2)]/60 ${className}`}
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
      className={`px-5 py-3.5 align-top ${className}`}
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
