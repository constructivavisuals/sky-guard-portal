import Image from "next/image";
import Link from "next/link";
import { Cctv, Radar, Warehouse } from "lucide-react";
import type { ReactNode } from "react";

import {
  boundsAreUsable,
  boundsAspectRatio,
  boundsSpanMeters,
  fieldOfViewDegrees,
  projectPoint,
  sectorPath,
  type MapBounds,
} from "@/lib/area-map.ts";

// Statický podklad areálu s body.
//
// Obrázek se do rámečku ROZTAHUJE, ne ořezává. Rohy určují souřadnicový
// rozsah, ne ořez — kdyby se použilo object-fit: cover, prohlížeč by
// obrázek podle poměru stran oříznul nebo zvětšil a body by se rozešly
// s tím, co je pod nimi vidět.

export interface AreaMapPoint {
  id: string;
  latitude: number;
  longitude: number;
  label: string;
  kind: "dock" | "zone" | "camera";
  /** Vypnutá zóna nebo offline kamera se kreslí utlumeně. */
  muted?: boolean;
  href?: string;
  /** Kam kamera kouká. Bez azimutu se kreslí jen bod bez výseče. */
  azimuth?: number | null;
  /** Ohnisko v mm; zorný úhel se z něj dopočítává. */
  focalMm?: number | null;
  rangeM?: number | null;
}

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
            {sectors.map((sector) => (
              <path
                key={sector.id}
                d={sector.path}
                className={
                  sector.muted
                    ? "fill-[var(--text-muted)]/10 stroke-[var(--text-muted)]/30"
                    : "fill-[var(--accent-bright)]/[0.16] stroke-[var(--accent-bright)]/60"
                }
                // Tloušťka je v metrech jako zbytek soustavy; bez toho
                // by čára rostla s velikostí výřezu.
                strokeWidth={0.5}
              />
            ))}
          </svg>
        ) : null}

        {placed.map(({ point, position }) => (
          <Marker key={point.id} point={point} position={position} />
        ))}
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

function Marker({
  point,
  position,
}: {
  point: AreaMapPoint;
  position: { x: number; y: number };
}) {
  const tone = point.muted
    ? "border-[var(--line-strong)] bg-[var(--surface)] text-[var(--text-muted)]"
    : point.kind === "dock"
      ? "border-[var(--accent-bright)] bg-[var(--accent)] text-white shadow-[var(--glow-accent)]"
      : point.kind === "camera"
        ? "border-[var(--accent-bright)] bg-[var(--surface)] text-[var(--accent-bright)]"
        : "border-[var(--success)] bg-[var(--success)] text-[#00291c]";

  const icon: ReactNode =
    point.kind === "dock" ? (
      <Warehouse className="h-3.5 w-3.5" aria-hidden="true" />
    ) : point.kind === "camera" ? (
      <Cctv className="h-3.5 w-3.5" aria-hidden="true" />
    ) : (
      <Radar className="h-3.5 w-3.5" aria-hidden="true" />
    );

  const body = (
    <>
      <span
        className={`inline-flex h-6 w-6 items-center justify-center rounded-full border-2 shadow-lg ${tone}`}
      >
        {icon}
      </span>
      <span className="pointer-events-none absolute left-1/2 top-7 -translate-x-1/2 whitespace-nowrap rounded bg-black/75 px-1.5 py-0.5 text-[10px] text-white">
        {point.label}
      </span>
    </>
  );

  // -translate-*: souřadnice určuje střed bodu, ne jeho levý horní roh.
  const style = {
    left: `${position.x * 100}%`,
    top: `${position.y * 100}%`,
  } as const;

  if (point.href) {
    return (
      <Link
        href={point.href}
        style={style}
        aria-label={point.label}
        className="absolute -translate-x-1/2 -translate-y-1/2 transition-transform hover:scale-110 focus-visible:scale-110"
      >
        {body}
      </Link>
    );
  }

  return (
    <span
      style={style}
      className="absolute -translate-x-1/2 -translate-y-1/2"
      aria-label={point.label}
    >
      {body}
    </span>
  );
}
