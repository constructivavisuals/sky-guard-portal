// Kam se po přihlášení smí odejít.
//
// Vlastní soubor, ne kousek přihlašovacího formuláře: je to čistá
// funkce a testy pro ni musí jít pustit bez JSX, které Node při
// odstraňování typů neumí.

/**
 * Kam se po přihlášení smí odejít.
 *
 * Podmínka „začíná lomítkem“ nestačí: `//evil.tld` je protokolově
 * relativní adresa, projde jí a odnese uživatele na cizí web — a to
 * po ÚSPĚŠNÉM přihlášení, takže to nevzbudí podezření. Stejně tak
 * `/\evil.tld`, které některé prohlížeče přeloží na `//`.
 *
 * Cíl se proto skládá proti vlastnímu původu a pustí se, jen když
 * u něj zůstal.
 */
export function bezpecnyCil(raw: string | null, origin?: string): string {
  const VYCHOZI = "/prehled";
  if (!raw || !raw.startsWith("/")) return VYCHOZI;
  // Druhý znak rozhoduje: // i /\ vedou ven.
  if (raw[1] === "/" || raw[1] === "\\") return VYCHOZI;

  const base = origin ?? (typeof window === "undefined" ? "" : window.location.origin);
  if (!base) return VYCHOZI;

  try {
    const cil = new URL(raw, base);
    if (cil.origin !== new URL(base).origin) return VYCHOZI;
    return `${cil.pathname}${cil.search}${cil.hash}`;
  } catch {
    return VYCHOZI;
  }
}
