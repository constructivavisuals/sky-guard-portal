import {
  CAMERA_STATUS_LABELS,
  DETECTION_OBJECT_CLASS_LABELS,
  DISPATCH_OUTCOME_LABELS,
  type CameraStatus,
  type DetectionObjectClass,
  type DispatchOutcome,
} from "../types/database.ts";

// Odznaky stavů. Barvy jdou z tokenů; záře se tu nepoužívá vůbec —
// je vyhrazená primární akci a běžícímu poplachu.

function Pill({
  tone,
  children,
}: {
  tone: "neutral" | "success" | "warning" | "danger" | "accent";
  children: React.ReactNode;
}) {
  const tones = {
    neutral: "border-[var(--border)] text-[var(--text-muted)]",
    success:
      "border-[var(--success)]/40 text-[var(--success)] bg-[var(--success)]/10",
    warning:
      "border-[var(--warning)]/40 text-[var(--warning)] bg-[var(--warning)]/10",
    danger:
      "border-[var(--danger)]/40 text-[var(--danger)] bg-[var(--danger)]/10",
    accent:
      "border-[var(--accent)]/40 text-[var(--accent)] bg-[var(--accent)]/10",
  } as const;

  return (
    <span
      className={`inline-flex items-center whitespace-nowrap rounded-full border px-2.5 py-1 text-xs font-medium ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

/**
 * Výsledek výjezdu u detekce. `null` znamená, že se o výjezd vůbec
 * nepokusilo — typicky kamera bez zóny, kam by dron neměl kam letět.
 */
export function DispatchOutcomeBadge({
  outcome,
}: {
  outcome: DispatchOutcome | null;
}) {
  if (!outcome) return <Pill tone="neutral">Bez výjezdu</Pill>;

  switch (outcome) {
    case "sent":
      return <Pill tone="success">{DISPATCH_OUTCOME_LABELS.sent}</Pill>;
    case "failed":
      return <Pill tone="danger">{DISPATCH_OUTCOME_LABELS.failed}</Pill>;
    default:
      // Potlačení není chyba — jantarová, ne červená.
      return <Pill tone="warning">{DISPATCH_OUTCOME_LABELS[outcome]}</Pill>;
  }
}

/** Zkrácený tvar do sloupce „výsledek“ u detekcí. */
export function DispatchOutcomeShortBadge({
  outcome,
}: {
  outcome: DispatchOutcome | null;
}) {
  if (!outcome) return <Pill tone="neutral">Bez výjezdu</Pill>;
  if (outcome === "sent") return <Pill tone="success">Odesláno</Pill>;
  if (outcome === "failed") return <Pill tone="danger">Selhalo</Pill>;
  return <Pill tone="warning">Potlačeno</Pill>;
}

export function ObjectClassBadge({
  objectClass,
}: {
  objectClass: DetectionObjectClass;
}) {
  const tone = objectClass === "person" ? "danger" : objectClass === "vehicle" ? "accent" : "neutral";
  return <Pill tone={tone}>{DETECTION_OBJECT_CLASS_LABELS[objectClass]}</Pill>;
}

export function CameraStatusBadge({ status }: { status: CameraStatus }) {
  const tones = {
    online: "success",
    offline: "danger",
    maintenance: "warning",
    decommissioned: "neutral",
  } as const;
  return <Pill tone={tones[status]}>{CAMERA_STATUS_LABELS[status]}</Pill>;
}

/** Stupeň zásahu 1–5. Pětka je maximum, tedy osoba nebo eskalace. */
export function LevelBadge({ level }: { level: number }) {
  return (
    <Pill tone={level >= 5 ? "danger" : level >= 3 ? "warning" : "neutral"}>
      {level}
    </Pill>
  );
}
