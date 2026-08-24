// Znak Sky Guard — kvadrokoptéra. Jako inline SVG, aby škáloval
// a bral barvu z currentColor (v tmavém UI se hodí i bílá varianta).

export function DroneMark({ className = "" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 64 64"
      fill="none"
      stroke="currentColor"
      strokeWidth={4}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {/* Ramena z těla k rotorům */}
      <path d="M24 24 14 14M40 24l10-10M24 40 14 50M40 40l10 10" />
      {/* Tělo */}
      <path d="M24 24h16v16H24z" />
      {/* Rotory */}
      <circle cx="10" cy="10" r="6" />
      <circle cx="54" cy="10" r="6" />
      <circle cx="10" cy="54" r="6" />
      <circle cx="54" cy="54" r="6" />
    </svg>
  );
}

export function Logo({ className = "" }: { className?: string }) {
  return (
    <span className={`inline-flex items-center gap-3 ${className}`}>
      <DroneMark className="h-8 w-8 text-[var(--accent-deep)]" />
      <span className="text-lg font-semibold tracking-tight">
        Sky<span className="text-[var(--text-muted)]"> Guard</span>
      </span>
    </span>
  );
}
