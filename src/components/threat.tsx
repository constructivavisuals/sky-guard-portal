import { ShieldAlert, ShieldCheck, ShieldQuestion, Shield } from "lucide-react";
import type { ReactNode } from "react";

// Jak dopadla kontrola fotek z letu.
//
// Stavy jsou ČTYŘI, ne tři, a slévat je nesmíme:
//
//   potvrzeno      model na snímcích někoho našel
//   nic nenalezeno prošel všechny snímky a nenašel nic
//   nejisté        snímky se nepodařilo spolehlivě přečíst
//   nekontrolováno kontrola vůbec neproběhla
//
// Poslední dva vypadají v databázi stejně (threat_confirmed IS NULL)
// a rozlišuje je threat_checked_at. Pro člověka u obrazovky je v tom
// zásadní rozdíl: „nevíme, co na těch snímcích je“ znamená podívat se
// sám, „ještě jsme se nedívali“ znamená počkat.

export interface ThreatState {
  threat_confirmed: boolean | null;
  threat_checked_at: string | null;
  threat_note?: string | null;
}

type Tone = "danger" | "success" | "warning" | "neutral";

interface Vzhled {
  tone: Tone;
  label: string;
  icon: ReactNode;
  /** Co to znamená, když u sebe není poznámka od modelu. */
  fallback: string;
}

function vzhled(state: ThreatState): Vzhled {
  if (!state.threat_checked_at) {
    return {
      tone: "neutral",
      label: "Nekontrolováno",
      icon: <Shield className="h-5 w-5" aria-hidden="true" />,
      fallback:
        "Fotky z letu zatím neprošly kontrolou. Proběhne při nejbližší synchronizaci s FlightHubem.",
    };
  }

  if (state.threat_confirmed === true) {
    return {
      tone: "danger",
      label: "Nebezpečí potvrzeno",
      icon: <ShieldAlert className="h-5 w-5" aria-hidden="true" />,
      fallback: "Model našel na snímcích z letu člověka nebo vozidlo.",
    };
  }

  if (state.threat_confirmed === false) {
    return {
      tone: "success",
      label: "Nic nenalezeno",
      icon: <ShieldCheck className="h-5 w-5" aria-hidden="true" />,
      fallback: "Na snímcích z letu není člověk ani vozidlo.",
    };
  }

  return {
    tone: "warning",
    label: "Nejistý výsledek",
    icon: <ShieldQuestion className="h-5 w-5" aria-hidden="true" />,
    fallback:
      "Snímky se nepodařilo spolehlivě přečíst. Není to „nic tam není“ — projděte je sami.",
  };
}

const TONES: Record<Tone, { text: string; border: string; bg: string }> = {
  danger: {
    text: "text-[var(--danger)]",
    border: "border-[var(--danger)]/45",
    bg: "bg-[var(--danger)]/[0.1]",
  },
  success: {
    text: "text-[var(--success)]",
    border: "border-[var(--success)]/35",
    bg: "bg-[var(--success)]/[0.07]",
  },
  warning: {
    text: "text-[var(--warning)]",
    border: "border-[var(--warning)]/45",
    bg: "bg-[var(--warning)]/[0.1]",
  },
  neutral: {
    text: "text-[var(--text-muted)]",
    border: "border-[var(--line-strong)]",
    bg: "bg-[var(--surface-2)]",
  },
};

/**
 * Výrazný odznak do detailu letu a zásahu.
 *
 * Schválně velký: je to jediné místo, kde portál říká, jestli na
 * pozemku někdo byl. Odznak velikosti štítku by zapadl mezi údaje
 * o trvání a vzdálenosti.
 */
export function ThreatCallout({ state }: { state: ThreatState }) {
  const v = vzhled(state);
  const tone = TONES[v.tone];

  return (
    <div className={`flex items-start gap-3.5 border ${tone.border} ${tone.bg} px-4 py-3.5`}>
      <span className={`mt-0.5 shrink-0 ${tone.text}`}>{v.icon}</span>
      <div className="min-w-0">
        <p className={`text-sm font-medium tracking-tight ${tone.text}`}>{v.label}</p>
        <p className="mt-1 text-sm leading-relaxed text-[var(--text-muted)]">
          {/* Poznámka platí jen k proběhlé kontrole. Bez razítka je to
              zbytek po dřívějším pokusu a vedle „nekontrolováno“ by si
              odporovala. */}
          {(state.threat_checked_at ? state.threat_note?.trim() : null) || v.fallback}
        </p>
      </div>
    </div>
  );
}

/** Zkrácený tvar do tabulky letů. */
export function ThreatBadge({ state }: { state: ThreatState }) {
  const v = vzhled(state);
  const tone = TONES[v.tone];

  return (
    <span
      className={`inline-flex h-6 items-center whitespace-nowrap rounded-[var(--radius-pill)] border px-2.5 text-[11px] font-medium uppercase tracking-[0.08em] ${tone.border} ${tone.bg} ${tone.text}`}
      title={(state.threat_checked_at ? state.threat_note : null) ?? undefined}
    >
      {v.label}
    </span>
  );
}
