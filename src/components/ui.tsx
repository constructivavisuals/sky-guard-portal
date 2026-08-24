import type { ComponentProps, ReactNode } from "react";

// Sdílená primitiva. Barvy berou výhradně z tokenů v globals.css.

/**
 * Primární tlačítko — plná pilulka v --accent se září.
 *
 * Záře je vyhrazený signál: nosí ji jen primární akce a aktivní poplach.
 * Sekundární varianta je proto plochá, jinak by se význam rozmělnil.
 */
export function Button({
  variant = "primary",
  className = "",
  ...props
}: ComponentProps<"button"> & { variant?: "primary" | "secondary" | "ghost" }) {
  const base =
    "inline-flex items-center justify-center gap-2 rounded-full px-5 h-11 text-sm font-semibold transition disabled:opacity-50 disabled:pointer-events-none";

  const variants = {
    primary:
      "bg-[var(--accent)] text-white shadow-[var(--glow-accent)] hover:brightness-110",
    secondary:
      "bg-[var(--surface-2)] text-[var(--text)] border border-[var(--border)] hover:bg-[var(--surface)]",
    ghost:
      "text-[var(--text-muted)] hover:text-[var(--text)] hover:bg-[var(--surface-2)]",
  } as const;

  return <button className={`${base} ${variants[variant]} ${className}`} {...props} />;
}

/** Karta — --surface, vlasový rámeček, radius 12px. */
export function Card({
  className = "",
  ...props
}: ComponentProps<"div">) {
  return (
    <div
      className={`bg-[var(--surface)] border border-[var(--border)] rounded-[var(--radius-card)] ${className}`}
      {...props}
    />
  );
}

/** Ikonový odznak — kruh 40px, plná --accent. */
export function IconBadge({
  children,
  tone = "accent",
  className = "",
}: {
  children: ReactNode;
  tone?: "accent" | "danger" | "warning" | "success";
  className?: string;
}) {
  const tones = {
    accent: "bg-[var(--accent)]",
    danger: "bg-[var(--danger)]",
    warning: "bg-[var(--warning)]",
    success: "bg-[var(--success)]",
  } as const;

  return (
    <span
      className={`inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-white ${tones[tone]} ${className}`}
    >
      {children}
    </span>
  );
}

/** Nadpis stránky se stručným popisem. */
export function PageHeader({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <header className="flex items-start justify-between gap-6 mb-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description ? (
          <p className="mt-1 text-sm text-[var(--text-muted)]">{description}</p>
        ) : null}
      </div>
      {action}
    </header>
  );
}

/** Placeholder pro stránku, která zatím nemá data. */
export function EmptyState({
  icon,
  title,
  description,
}: {
  icon: ReactNode;
  title: string;
  description: string;
}) {
  return (
    <Card className="flex flex-col items-center text-center py-16 px-6">
      <IconBadge>{icon}</IconBadge>
      <h2 className="mt-4 text-base font-medium">{title}</h2>
      <p className="mt-1 max-w-sm text-sm text-[var(--text-muted)]">
        {description}
      </p>
    </Card>
  );
}
