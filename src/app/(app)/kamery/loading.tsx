// Kostra seznamu kamer.
//
// Obecná kostra ve skupině kreslí mřížku dlaždic z přehledu — tady
// žádná není a obsah po dorenderování poskočil. Kostra má kopírovat
// rastr TÉ stránky, jinak škodí víc, než pomáhá.

export default function Loading() {
  return (
    <div className="animate-pulse" aria-busy="true" aria-label="Načítají se kamery">
      <header className="border-b border-[var(--line)] px-5 py-5 sm:px-8 sm:py-8">
        <div className="h-8 w-40 bg-[var(--surface-2)]" />
        <div className="mt-3 h-3.5 w-72 bg-[var(--surface-2)]" />
      </header>

      <ul className="border-t border-[var(--line)]">
        {[0, 1, 2, 3, 4].map((i) => (
          <li
            key={i}
            className="flex items-center gap-4 border-b border-[var(--line)] px-4 py-3 sm:px-6"
          >
            {/* Místo pro náhled. Stejný rozměr jako v seznamu, jinak
                obsah po dorenderování poskočí právě o ten obrázek. */}
            <div className="h-12 w-20 shrink-0 bg-[var(--surface-3)] sm:h-14 sm:w-24" />
            <div className="min-w-0 flex-1">
              <div className="h-4 w-40 bg-[var(--surface-2)]" />
              <div className="mt-2 h-3 w-36 bg-[var(--surface-2)]" />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
