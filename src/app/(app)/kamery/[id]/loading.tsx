// Kostra detailu kamery.
//
// Obraz zabírá celý horní díl stránky, takže se jeho místo drží černým
// obdélníkem ve stejném poměru. Bez něj se po dorenderování přesunula
// celá stránka o výšku videa dolů — na mobilu to je skoro celá
// obrazovka.
//
// Černá schválně, ne pulzující šedá: přesně tak vypadá i přehrávač,
// než naskočí obraz, takže mezi kostrou a skutečnou stránkou není vidět
// přechod.

export default function Loading() {
  return (
    <div aria-busy="true" aria-label="Načítá se kamera">
      <div className="flex items-center gap-3 border-b border-[var(--line)] px-4 py-3 sm:px-6">
        <div className="h-5 w-32 animate-pulse bg-[var(--surface-2)]" />
      </div>

      <div className="aspect-video bg-black" />

      <div className="flex border-b border-[var(--line)] bg-[var(--surface)]">
        {[0, 1, 2].map((i) => (
          <div key={i} className="flex flex-1 justify-center py-3">
            <div className="h-4 w-20 animate-pulse bg-[var(--surface-2)]" />
          </div>
        ))}
      </div>
    </div>
  );
}
