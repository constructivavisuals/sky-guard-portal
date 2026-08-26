import Image from "next/image";

import {
  boundsAreUsable,
  boundsAspectRatio,
  boundsSpanMeters,
  fieldOfViewDegrees,
  projectPoint,
  projectTrack,
  sectorPath,
  trackPath,
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
  track = [],
}: {
  imageUrl: string | null;
  bounds: MapBounds | null;
  points: AreaMapPoint[];
  siteName: string;
  /** Trasa letu, seřazená v čase. Prázdná = nekreslí se. */
  track?: readonly { latitude: number; longitude: number }[];
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

  const trasa = projectTrack(bounds, track);
  // Značky vzletu a doletu v metrech, ať nerostou s velikostí výřezu.
  const znacka = Math.max(1.5, span.width / 90);
  const kresliSvg = sectors.length > 0 || trasa.segments.length > 0 || trasa.start !== null;

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

        {kresliSvg ? (
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

            {/* Trasa letu. Bílá, ne barevná: modrá na podkladu znamená
                pokrytí kamerou, oranžová a červená varování — trasa
                není ani jedno. Tmavý obrys pod ní drží kontrast na
                světlých střechách stejně jako u výsečí. */}
            {trasa.segments.map((segment, index) => (
              <path
                key={`trasa-obrys-${index}`}
                d={trackPath(segment, span)}
                fill="none"
                className="stroke-black/70"
                strokeWidth={3.2}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            ))}
            {trasa.segments.map((segment, index) => (
              <path
                key={`trasa-${index}`}
                d={trackPath(segment, span)}
                fill="none"
                className="stroke-white"
                strokeWidth={1.6}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            ))}

            {/* Vzlet dutý, dolet plný — směr letu je z čáry nepoznat. */}
            {trasa.start ? (
              <circle
                cx={trasa.start.x * span.width}
                cy={trasa.start.y * span.height}
                r={znacka}
                className="fill-black/70 stroke-white"
                strokeWidth={1.6}
              />
            ) : null}
            {trasa.end ? (
              <circle
                cx={trasa.end.x * span.width}
                cy={trasa.end.y * span.height}
                r={znacka}
                className="fill-white stroke-black/70"
                strokeWidth={1.2}
              />
            ) : null}
          </svg>
        ) : null}

        <AreaMapMarkers placed={placed} />
      </div>

      {skipped > 0 || trasa.skipped > 0 ? (
        <p className="mt-2 text-xs text-[var(--text-muted)]">
          {skipped > 0
            ? skipped === 1
              ? "Jeden bod leží mimo výřez podkladu, a proto se nekreslí."
              : `${skipped} body leží mimo výřez podkladu, a proto se nekreslí.`
            : null}
          {skipped > 0 && trasa.skipped > 0 ? " " : null}
          {trasa.skipped > 0
            ? `Trasa letu vede mimo podklad (${trasa.skipped} ${
                trasa.skipped === 1 ? "bod" : "bodů"
              }); tam se nekreslí a čára je proto přerušená.`
            : null}
        </p>
      ) : null}
    </div>
  );
}
