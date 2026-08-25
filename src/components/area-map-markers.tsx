"use client";

import Link from "next/link";
import { Cctv, Radar, Warehouse } from "lucide-react";
import { useRef, useState, type ReactNode } from "react";

import type { AreaMapPoint, MapPosition } from "@/lib/area-map.ts";

// Body na podkladu areálu.
//
// Popisky se ukazují až při najetí myší, zaměření z klávesnice nebo
// klepnutí — na dvou stech metrech leží body blízko sebe a trvale
// vypsané popisky se překrývaly natolik, že se nedaly přečíst.
//
// Na dotykovém displeji není najetí myší, takže první klepnutí popisek
// ukáže a teprve druhé otevře detail. Na myši se nic takového neděje:
// tam popisek ukáže najetí a klepnutí rovnou otevírá.

export interface PlacedPoint {
  point: AreaMapPoint;
  position: MapPosition;
}

export function AreaMapMarkers({ placed }: { placed: PlacedPoint[] }) {
  const [activeId, setActiveId] = useState<string | null>(null);
  // Typ ukazovátka z posledního stisku. onClick sám o sobě nerozliší
  // myš od prstu.
  const pointerType = useRef<string>("mouse");

  return (
    <>
      {/* Klepnutí mimo bod popisek schová. Vrstva je pod body, takže
          jim klepnutí nebere. */}
      <span
        aria-hidden="true"
        className="absolute inset-0"
        onClick={() => setActiveId(null)}
      />

      {placed.map(({ point, position }) => {
        const active = activeId === point.id;

        const body = (
          <>
            <MarkerDot point={point} active={active} />
            <span
              className={`pointer-events-none absolute left-1/2 top-7 -translate-x-1/2 whitespace-nowrap rounded bg-black/85 px-1.5 py-0.5 text-[10px] text-white transition-opacity ${
                active ? "opacity-100" : "opacity-0"
              }`}
            >
              {point.label}
            </span>
          </>
        );

        const style = {
          left: `${position.x * 100}%`,
          top: `${position.y * 100}%`,
          // Aktivní bod nahoru, ať jeho popisek nezakryje soused.
          zIndex: active ? 2 : 1,
        } as const;

        const shared = {
          style,
          "aria-label": point.label,
          // Stav popisku i pro test: bez něj se z venku nedá poznat,
          // jestli je bod aktivní, a chování dvojího klepnutí by šlo
          // ověřit jen odhadem.
          "data-active": active ? "1" : "0",
          onPointerDown: (event: React.PointerEvent) => {
            pointerType.current = event.pointerType;
          },
          onMouseEnter: () => {
            if (pointerType.current !== "touch") setActiveId(point.id);
          },
          onMouseLeave: () => {
            if (pointerType.current !== "touch") setActiveId(null);
          },
          onFocus: () => setActiveId(point.id),
          onBlur: () => setActiveId(null),
        };

        // -translate-*: souřadnice určuje střed bodu, ne jeho levý horní roh.
        const className =
          "absolute -translate-x-1/2 -translate-y-1/2 transition-transform hover:scale-110 focus-visible:scale-110";

        if (point.href) {
          return (
            <Link
              key={point.id}
              href={point.href}
              className={className}
              {...shared}
              onClick={(event) => {
                // Prst: první klepnutí jen ukáže popisek, druhé otevře.
                if (pointerType.current === "touch" && !active) {
                  event.preventDefault();
                  setActiveId(point.id);
                }
              }}
            >
              {body}
            </Link>
          );
        }

        return (
          <span key={point.id} className={className} {...shared}>
            {body}
          </span>
        );
      })}
    </>
  );
}

function MarkerDot({ point, active }: { point: AreaMapPoint; active: boolean }) {
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

  return (
    <span
      className={`inline-flex h-6 w-6 items-center justify-center rounded-full border-2 shadow-lg ${tone} ${
        active ? "ring-2 ring-white/70" : ""
      }`}
    >
      {icon}
    </span>
  );
}
