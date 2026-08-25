import Image from "next/image";

import {
  boundsAreUsable,
  boundsAspectRatio,
  boundsSpanMeters,
  fieldOfViewDegrees,
  projectPoint,
  sectorPath,
  type AreaMapPoint,
  type MapBounds,
} from "@/lib/area-map.ts";

import { AreaMapMarkers } from "./area-map-markers.tsx";

export type { AreaMapPoint };

// Statický podklad areálu s body.
//
// Obrázek se do rámečku ROZTAHUJE, ne ořezává. Rohy určují souřadnicový
// rozsah, ne ořez — kdyby se použilo object-fit: cover, prohlížeč by
// obrázek podle poměru stran oříznul nebo zvětšil a body by se rozešly
// s tím, co je pod nimi vidět.


export function AreaMap({
  imageUrl,
  bounds,
  points,
  siteName,
}: {
  imageUrl: string | null;
  bounds: MapBounds | null;
  points: AreaMapPoint[];
  siteName: string;
}) {
  if (!imageUrl || !boundsAreUsable(bounds)) {
    return (
      <div className="border border-dashed border-[var(--line-strong)] bg-[var(--surface-2)] p-8 text-center">
        <p className="text-sm text-[var(--text-muted)]">
          Lokalita nemá nahraný podklad areálu. Doplňte obrázek a souřadnice
          rohů v nastavení lokality.
        </p>
      </div>
    );
  }

  // Body mimo výřez se zahazují tady, ne až ve stylu — přilepené
  // k okraji by lhaly o tom, kde doopravdy jsou.
  const placed = points.flatMap((point) => {
    const position = projectPoint(bounds, point.latitude, point.longitude);
    return position ? [{ point, position }] : [];
  });

  const skipped = points.length - placed.length;
  const isLocal = imageUrl.startsWith("/");

  // Výseče se kreslí v metrech. Rámeček má poměr stran taky z metrů,
  // takže jsou jednotky na obrazovce čtvercové a výseč vyjde kruhová —
  // ve stupních by se natáhla do šířky.
  const span = boundsSpanMeters(bounds);
  const sectors = placed.flatMap(({ point, position }) => {
    if (point.kind !== "camera") return [];
    if (typeof point.azimuth !== "number") return [];
    const fov = fieldOfViewDegrees(point.focalMm ?? null);
    if (fov === null) return [];
    const path = sectorPath(
      { x: position.x * span.width, y: position.y * span.height },
      point.azimuth,
      fov,
      point.rangeM ?? 30,
    );
    return path ? [{ id: point.id, path, muted: point.muted === true }] : [];
  });

  return (
    <div>
      <div
        className="relative overflow-hidden border border-[var(--line-strong)] bg-[var(--surface-2)]"
        style={{ aspectRatio: String(boundsAspectRatio(bounds)) }}
      >
        {/* fill + objectFit: fill — podklad se musí roztáhnout přesně na
            rámeček daný rohy, ne oříznout. next/image se o to postará
            a navíc pošle AVIF/WebP ve velikosti, kterou displej opravdu
            potřebuje; předloha je satelitní snímek o megabajtech.

            Cizí URL by vyžadovala remotePatterns v konfiguraci, takže
            pro ni zůstává obyčejný <img>. */}
        {isLocal ? (
          <Image
            src={imageUrl}
            alt={`Letecký podklad areálu ${siteName}`}
            fill
            sizes="(max-width: 1024px) 100vw, 50vw"
            style={{ objectFit: "fill" }}
            priority
          />
        ) : (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={imageUrl}
            alt={`Letecký podklad areálu ${siteName}`}
            className="absolute inset-0 h-full w-full"
            style={{ objectFit: "fill" }}
          />
        )}

        {sectors.length > 0 ? (
          <svg
            className="pointer-events-none absolute inset-0 h-full w-full"
            viewBox={`0 0 ${span.width} ${span.height}`}
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            {/* Každá výseč se kreslí dvakrát: nejdřív tmavý obrys, pak
                světlý přes něj. Samotná světlá čára mizela na bílých
                střechách, samotná tmavá v zeleni — přes sebe drží
                kontrast na obojím. Tloušťky jsou v metrech jako zbytek
                soustavy, jinak by čára rostla s velikostí výřezu. */}
            {sectors.map((sector) => (
              <path
                key={`${sector.id}-obrys`}
                d={sector.path}
                fill="none"
                className="stroke-black/70"
                strokeWidth={2.4}
                strokeLinejoin="round"
              />
            ))}
            {sectors.map((sector) => (
              <path
                key={sector.id}
                d={sector.path}
                className={
                  sector.muted
                    ? "fill-[var(--accent-bright)]/[0.14] stroke-[var(--accent-bright)]/80"
                    : "fill-[var(--accent-bright)]/35 stroke-[var(--accent-bright)]"
                }
                strokeWidth={1.1}
                strokeLinejoin="round"
                // Kamera, která nehlásí, má týž záběr — jen o něm nikdo
                // neví jistě. Čárkovaně, ne jinou barvou: modrá na
                // podkladu znamená pokrytí kamerou a nemá mít dva
                // významy. Teď jsou navíc offline všechny, takže by
                // jiná barva neodlišila nic.
                strokeDasharray={sector.muted ? "3 2" : undefined}
              />
            ))}
          </svg>
        ) : null}

        <AreaMapMarkers placed={placed} />
      </div>

      {skipped > 0 ? (
        <p className="mt-2 text-xs text-[var(--text-muted)]">
          {skipped === 1
            ? "Jeden bod leží mimo výřez podkladu, a proto se nekreslí."
            : `${skipped} body leží mimo výřez podkladu, a proto se nekreslí.`}
        </p>
      ) : null}
    </div>
  );
}
