import Link from "next/link";
import { Radar, Warehouse } from "lucide-react";
import type { ReactNode } from "react";

import {
  boundsAreUsable,
  boundsAspectRatio,
  projectPoint,
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
  kind: "dock" | "zone";
  /** Vypnutá zóna se kreslí utlumeně. */
  muted?: boolean;
  href?: string;
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
      <div className="rounded-[var(--radius-card)] border border-dashed border-[var(--border)] bg-[var(--surface-2)] p-8 text-center">
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

  return (
    <div>
      <div
        className="relative overflow-hidden rounded-[var(--radius-card)] border border-[var(--border)] bg-[var(--surface-2)]"
        style={{ aspectRatio: String(boundsAspectRatio(bounds)) }}
      >
        {/* Ne next/image: podklad se musí roztáhnout přesně na rámeček
            daný rohy, což optimalizace podle poměru stran komplikuje. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={imageUrl}
          alt={`Letecký podklad areálu ${siteName}`}
          className="absolute inset-0 h-full w-full"
          style={{ objectFit: "fill" }}
        />

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
  const tone =
    point.kind === "dock"
      ? "border-[var(--accent)] bg-[var(--accent)] text-white"
      : point.muted
        ? "border-[var(--border)] bg-[var(--surface)] text-[var(--text-muted)]"
        : "border-[var(--success)] bg-[var(--success)] text-white";

  const icon: ReactNode =
    point.kind === "dock" ? (
      <Warehouse className="h-3.5 w-3.5" aria-hidden="true" />
    ) : (
      <Radar className="h-3.5 w-3.5" aria-hidden="true" />
    );

  const body = (
    <>
      <span
        className={`inline-flex h-7 w-7 items-center justify-center rounded-full border-2 shadow-lg ${tone}`}
      >
        {icon}
      </span>
      <span className="pointer-events-none absolute left-1/2 top-8 -translate-x-1/2 whitespace-nowrap rounded bg-black/75 px-1.5 py-0.5 text-[10px] text-white">
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
