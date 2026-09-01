"use client";

import { useEffect, useState } from "react";

import { DroneMark } from "./logo.tsx";

// Načítání obrazu se značkou Sky Guard a procenty.
//
// ═══ Procenta nejsou ozdoba ════════════════════════════════════════
// Jsou to skutečné fáze navazování, ne odpočet na náhodném čase:
//
//   15 %  lístek od portálu
//   35 %  websocket otevřený
//   55 %  kodeky odeslané, relay ví, co poslat
//   80 %  první data dorazila
//  100 %  obraz běží
//
// Číslo tedy něco znamená: když se zastaví na 35 %, ví se, že spojení
// stojí a kodeky se neposlaly — a to je přesně ta závada, která se
// v tomhle projektu hledala nejdéle. Falešný odpočet by to zakryl.
//
// Mezi fázemi se dopočítává plynule, aby to neposkakovalo po velkých
// skocích. Nikdy ale nepřeleze cíl: dokud obraz neběží, na 100 % se
// nedostane.

const KROK_MS = 60;

export function Nacitani({
  cil,
  popis,
}: {
  /** Kam se má ukazatel dostat, 0–100. */
  cil: number;
  popis?: string;
}) {
  const [ukazano, setUkazano] = useState(0);

  // Závislost na `cil` schválně: hodinky se přestaví jen při změně
  // fáze, tedy pětkrát za celé navazování. Ref by tu byl rychlejší
  // o nic a četl by se při renderu, což React právem zakazuje.
  useEffect(() => {
    const casovac = setInterval(() => {
      setUkazano((soucasne) => {
        const rozdil = cil - soucasne;
        if (Math.abs(rozdil) < 0.5) return cil;
        // Šestina zbytku za krok: rychle se rozjede, ke konci zpomalí.
        return soucasne + rozdil / 6;
      });
    }, KROK_MS);
    return () => clearInterval(casovac);
  }, [cil]);

  const procenta = Math.round(ukazano);
  const obvod = 2 * Math.PI * 34;

  return (
    <div className="flex flex-col items-center gap-4">
      <div className="relative h-24 w-24">
        <svg className="h-full w-full -rotate-90" viewBox="0 0 80 80" aria-hidden="true">
          <circle
            cx="40"
            cy="40"
            r="34"
            fill="none"
            stroke="var(--line-strong)"
            strokeWidth="2"
          />
          <circle
            cx="40"
            cy="40"
            r="34"
            fill="none"
            stroke="var(--accent-bright)"
            strokeWidth="2"
            strokeLinecap="round"
            strokeDasharray={obvod}
            strokeDashoffset={obvod * (1 - ukazano / 100)}
            style={{
              transition: `stroke-dashoffset ${KROK_MS}ms linear`,
              filter: "drop-shadow(0 0 6px rgba(0, 153, 255, 0.55))",
            }}
          />
        </svg>
        <div className="absolute inset-0 flex items-center justify-center">
          <DroneMark className="h-7 w-auto opacity-90" />
        </div>
      </div>

      <div
        className="text-center"
        role="status"
        aria-live="polite"
        aria-label={`Načítá se, ${procenta} procent`}
      >
        <p className="text-lg font-medium tabular-nums text-[var(--text)]">
          {procenta} %
        </p>
        {popis ? (
          <p className="mt-1 text-xs text-[var(--text-muted)]">{popis}</p>
        ) : null}
      </div>
    </div>
  );
}
