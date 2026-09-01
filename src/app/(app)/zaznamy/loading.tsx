// Kostra seznamu. Řádky, ne dlaždice — obecná kostra ve skupině kreslí
// mřížku z přehledu a obsah po ní poskočí.

export default function Loading() {
  return (
    <div className="animate-pulse" aria-busy="true" aria-label="Načítá se">
      <header className="border-b border-[var(--line)] px-5 py-5 sm:px-8 sm:py-8">
        <div className="h-8 w-44 bg-[var(--surface-2)]" />
        <div className="mt-3 h-3.5 w-64 bg-[var(--surface-2)]" />
      </header>

      <div className="border-b border-[var(--line)] px-5 py-3 sm:px-8">
        <div className="h-3 w-full max-w-3xl bg-[var(--surface-2)]" />
      </div>

      {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
        <div
          key={i}
          className="flex items-center gap-4 border-b border-[var(--line)] px-5 py-4 sm:px-8"
        >
          <div className="h-3.5 w-28 bg-[var(--surface-2)]" />
          <div className="h-3.5 w-20 bg-[var(--surface-2)]" />
          <div className="ml-auto h-3.5 w-16 bg-[var(--surface-2)]" />
        </div>
      ))}
    </div>
  );
}
