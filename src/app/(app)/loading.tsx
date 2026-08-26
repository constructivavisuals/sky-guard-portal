// Kostra, která se ukáže hned po kliknutí v navigaci.
//
// Bez ní se po kliknutí nedělo nic, dokud server nedorenderoval celou
// stránku — u dynamických stránek to jsou stovky milisekund, ve kterých
// portál vypadá zaseklý. Next tuhle kostru navíc umí předstáhnout,
// takže se objeví okamžitě.
//
// Kopíruje rastr stránky: hlavička, blok, mřížka. Kdyby to byly jen
// obdélníky někde uprostřed, obsah by po dorenderování poskočil.

export default function Loading() {
  return (
    <div className="animate-pulse" aria-busy="true" aria-label="Načítá se">
      <header className="border-b border-[var(--line)] px-5 py-5 sm:px-8 sm:py-8">
        <div className="h-8 w-48 bg-[var(--surface-2)]" />
        <div className="mt-3 h-3.5 w-64 bg-[var(--surface-2)]" />
      </header>

      <div className="border-b border-[var(--line)] px-5 py-4 sm:px-8 sm:py-6">
        <div className="h-3 w-24 bg-[var(--surface-2)]" />
        <div className="mt-4 h-5 w-3/4 bg-[var(--surface-2)]" />
        <div className="mt-3 h-5 w-1/2 bg-[var(--surface-2)]" />
      </div>

      <div className="hairline-grid grid-cols-2 sm:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="px-5 py-4 sm:px-6 sm:py-5">
            <div className="h-3 w-16 bg-[var(--surface-2)]" />
            <div className="mt-3 h-6 w-12 bg-[var(--surface-2)]" />
          </div>
        ))}
      </div>

      <div className="border-b border-[var(--line)] px-5 py-4 sm:px-8 sm:py-6">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="flex items-center gap-3 py-3">
            <div className="h-8 w-8 shrink-0 rounded-full bg-[var(--surface-2)]" />
            <div className="h-4 flex-1 bg-[var(--surface-2)]" />
          </div>
        ))}
      </div>
    </div>
  );
}
