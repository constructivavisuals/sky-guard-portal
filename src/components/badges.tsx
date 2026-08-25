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
    neutral: "border-[var(--line-strong)] text-[var(--text-muted)]",
    success:
      "border-[var(--success)]/35 text-[var(--success)] bg-[var(--success)]/[0.08]",
    warning:
      "border-[var(--warning)]/40 text-[var(--warning)] bg-[var(--warning)]/[0.1]",
    danger:
      "border-[var(--danger)]/40 text-[var(--danger)] bg-[var(--danger)]/[0.1]",
    accent:
      "border-[var(--accent-bright)]/40 text-[var(--accent-bright)] bg-[var(--accent-bright)]/[0.08]",
  } as const;

  return (
    <span
      className={`inline-flex h-6 items-center whitespace-nowrap rounded-[var(--radius-pill)] border px-2.5 text-[11px] font-medium uppercase tracking-[0.08em] ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

/**
 * Výsledek zásahu u detekce. `null` znamená, že se o zásah vůbec
 * nepokusilo — typicky kamera bez zóny, kam by dron neměl kam letět.
 */
export function DispatchOutcomeBadge({
  outcome,
}: {
  outcome: DispatchOutcome | null;
}) {
  if (!outcome) return <Pill tone="neutral">Bez zásahu</Pill>;

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
  if (!outcome) return <Pill tone="neutral">Bez zásahu</Pill>;
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
