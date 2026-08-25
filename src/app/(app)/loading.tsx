// Kostra, která se ukáže hned po kliknutí v navigaci.
//
// Bez ní se po kliknutí nedělo nic, dokud server nedorenderoval celou
// stránku — u dynamických stránek to jsou stovky milisekund, ve kterých
// portál vypadá zaseklý. Next tuhle kostru navíc umí předstáhnout,
// takže se objeví okamžitě.
//
// Schválně obecná: sedí na tabulku, seznam karet i přehled. Konkrétnější
// kostra by u jiné stránky mátla víc, než by pomohla.

export default function Loading() {
  return (
    <div className="animate-pulse" aria-busy="true" aria-label="Načítá se">
      <div className="mb-6">
        <div className="h-7 w-40 rounded-lg bg-[var(--surface-2)]" />
        <div className="mt-2 h-4 w-64 rounded bg-[var(--surface-2)]" />
      </div>

      <div className="space-y-4">
        <div className="h-28 rounded-[var(--radius-card)] border border-[var(--border)] bg-[var(--surface-2)]" />
        <div className="h-20 rounded-[var(--radius-card)] border border-[var(--border)] bg-[var(--surface-2)]" />
        <div className="h-56 rounded-[var(--radius-card)] border border-[var(--border)] bg-[var(--surface-2)]" />
      </div>
    </div>
  );
}
