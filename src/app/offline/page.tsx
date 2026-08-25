import type { Metadata } from "next";

export const metadata: Metadata = { title: "Offline" };

// Jediná stránka, kterou si service worker ukládá.
//
// Schválně nepoužívá ani Tailwind, ani <Image> — offline se stylopis
// z /_next/static ani obrázek z /public nenačtou, protože service
// worker cachuje jen tenhle dokument. Všechno je proto inline: barvy
// z tokenů opsané natvrdo a značka jako SVG přímo v dokumentu.
//
// Taky tu nejsou žádná data. Nemá co zastarat.

const BG = "#08090C";
const SURFACE = "#0E1014";
const BORDER = "#1E2229";
const TEXT = "#FFFFFF";
const MUTED = "#A0A6B0";

export default function OfflinePage() {
  return (
    <div
      style={{
        minHeight: "100dvh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "24px",
        background: BG,
        color: TEXT,
        // Bez var(--font-sans) schválně: proměnná je definovaná ve
        // stylopisu, který se offline nenačte, a neznámá proměnná
        // zneplatní celou deklaraci — písmo by spadlo na patkové.
        fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif",
      }}
    >
      <div style={{ width: "100%", maxWidth: "360px", textAlign: "center" }}>
        <svg
          viewBox="0 0 64 64"
          width="44"
          height="44"
          fill="none"
          stroke={TEXT}
          strokeWidth={4}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          style={{ opacity: 0.9 }}
        >
          <path d="M24 24 14 14M40 24l10-10M24 40 14 50M40 40l10 10" />
          <path d="M24 24h16v16H24z" />
          <circle cx="10" cy="10" r="6" />
          <circle cx="54" cy="10" r="6" />
          <circle cx="10" cy="54" r="6" />
          <circle cx="54" cy="54" r="6" />
        </svg>

        <div
          style={{
            marginTop: "24px",
            padding: "28px 24px",
            background: SURFACE,
            border: `1px solid ${BORDER}`,
            borderRadius: "12px",
          }}
        >
          <h1
            style={{
              margin: 0,
              fontSize: "18px",
              fontWeight: 600,
              letterSpacing: "-0.01em",
            }}
          >
            Bez připojení
          </h1>
          <p
            style={{
              margin: "8px 0 0",
              fontSize: "14px",
              lineHeight: 1.5,
              color: MUTED,
            }}
          >
            Sky Guard neukládá stav střežení do zařízení — starý údaj by se
            tvářil jako aktuální. Jakmile bude síť zpátky, stránku načtěte
            znovu.
          </p>
        </div>

        <p style={{ marginTop: "24px", fontSize: "12px", color: MUTED }}>
          Sky Guard s.r.o.
        </p>
      </div>
    </div>
  );
}
