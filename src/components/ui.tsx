import type { ComponentProps, ReactNode } from "react";

// Sdílená primitiva. Barvy berou výhradně z tokenů v globals.css.
//
// Řeč tvarů je převzatá z sky-guard.cz: plocha je rozdělená vlasovými
// linkami, které jdou od kraje ke kraji a nikde se nepřerušují. Bloky
// proto nemají vlastní rámeček ani zaoblení — jen odsazení a linku
// pod sebou. Zaoblení nosí výhradně to, co z mřížky vystupuje:
// tlačítka, odznaky, avatary.

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
}: ComponentProps<"button"> & {
  variant?: "primary" | "secondary" | "ghost" | "warning";
}) {
  const base =
    "inline-flex items-center justify-center gap-2 rounded-[var(--radius-pill)] px-5 h-10 text-sm font-medium tracking-tight transition disabled:opacity-40 disabled:pointer-events-none";

  const variants = {
    primary:
      "bg-[var(--accent)] text-white shadow-[var(--glow-accent)] hover:bg-[var(--accent-bright)]",
    warning:
      "bg-[var(--warning)] text-[#1a0d00] shadow-[var(--glow-warning)] hover:brightness-110",
    secondary:
      "border border-[var(--line-strong)] text-[var(--text)] hover:border-[var(--text-muted)] hover:bg-[var(--surface-2)]",
    ghost:
      "text-[var(--text-muted)] hover:text-[var(--text)] hover:bg-[var(--surface-2)]",
  } as const;

  return <button className={`${base} ${variants[variant]} ${className}`} {...props} />;
}

/**
 * Blok stránky.
 *
 * Plná šířka, vnitřní odsazení, linka dole. Bloky se skládají na sebe
 * bez mezer — linka mezi nimi je jediné, co je dělí, a navazuje na
 * linky uvnitř mřížek i na svislé linky ve sloupcích.
 */
export function Section({
  className = "",
  flush = false,
  last = false,
  ...props
}: ComponentProps<"section"> & {
  /** Bez vnitřního odsazení — pro tabulky a mapy, které kreslí až ke kraji. */
  flush?: boolean;
  /** Poslední blok bez linky dole. */
  last?: boolean;
}) {
  const pad = flush ? "" : "px-5 py-5 sm:px-8 sm:py-6";
  const rule = last ? "" : "border-b border-[var(--line)]";
  return <section className={`${pad} ${rule} ${className}`} {...props} />;
}

/**
 * Nadpis uvnitř bloku. Malý, prostrkaný, verzálkami — na webu tuhle
 * roli hrají popisky nad mřížkami a v portálu odlišují blok od dat,
 * aniž by přebily obsah.
 */
export function BlockTitle({
  children,
  action,
  className = "",
}: {
  children: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={`mb-4 flex items-center justify-between gap-4 ${className}`}>
      <h2 className="text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--text-muted)]">
        {children}
      </h2>
      {action}
    </div>
  );
}

/**
 * Panel s vlastním rámečkem.
 *
 * Pro obsah, který stojí mimo hlavní sloupec bloků — třeba dialog nebo
 * karta v mřížce. Uvnitř Section se nepoužívá: dvě linky vedle sebe
 * by mřížku rozbily.
 */
export function Card({ className = "", ...props }: ComponentProps<"div">) {
  return (
    <div
      className={`border border-[var(--line)] bg-[var(--surface)] ${className}`}
      {...props}
    />
  );
}

/** Ikonový odznak — kruh 40px, plná barva. */
export function IconBadge({
  children,
  tone = "accent",
  className = "",
}: {
  children: ReactNode;
  tone?: "accent" | "danger" | "warning" | "success" | "muted";
  className?: string;
}) {
  const tones = {
    // Bez záře: ta je vyhrazená primární akci a poplachu. Odznak
    // v seznamu není signál, jen ikona.
    accent: "bg-[var(--accent)] text-white",
    danger: "bg-[var(--danger)] text-white",
    warning: "bg-[var(--warning)] text-[#1a0d00]",
    success: "bg-[var(--success)] text-[#00291c]",
    muted: "border border-[var(--line-strong)] text-[var(--text-muted)]",
  } as const;

  return (
    <span
      className={`inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full ${tones[tone]} ${className}`}
    >
      {children}
    </span>
  );
}

/**
 * Hlavička stránky.
 *
 * Vlastní blok na plnou šířku s linkou dole, aby na ni navázalo to, co
 * je pod ní. Nadpis je lehký a velký jako na webu — váhu nese velikost,
 * ne tučnost.
 */
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
    <header className="flex flex-wrap items-end justify-between gap-4 border-b border-[var(--line)] px-5 py-6 sm:px-8 sm:py-8">
      <div className="min-w-0">
        <h1 className="text-[28px] font-normal leading-none tracking-[-0.02em] sm:text-[34px]">
          {title}
        </h1>
        {description ? (
          <p className="mt-2 text-sm text-[var(--text-muted)]">{description}</p>
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
    // Linka dole: bez ní by prázdný stav visel a mřížka pod ním by
    // začínala bez napojení.
    <div className="flex flex-col items-center border-b border-[var(--line)] px-6 py-20 text-center">
      <IconBadge tone="muted">{icon}</IconBadge>
      <h2 className="mt-5 text-base font-medium">{title}</h2>
      <p className="mt-2 max-w-sm text-sm leading-relaxed text-[var(--text-muted)]">
        {description}
      </p>
    </div>
  );
}

/**
 * Popisek a hodnota pod sebou.
 *
 * Základní stavební kámen datových bloků: popisek verzálkami nahoře,
 * hodnota pod ním. Stejný rytmus jako mřížka výhod na webu.
 */
export function Metric({
  label,
  children,
  icon,
  tone,
  className = "",
}: {
  label: string;
  children: ReactNode;
  icon?: ReactNode;
  tone?: "accent" | "warning" | "danger" | "success";
  className?: string;
}) {
  const tones = {
    accent: "text-[var(--accent-bright)]",
    warning: "text-[var(--warning)]",
    danger: "text-[var(--danger)]",
    success: "text-[var(--success)]",
  } as const;

  return (
    <div className={`min-w-0 px-5 py-5 sm:px-6 ${className}`}>
      <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.12em] text-[var(--text-muted)]">
        {icon ? (
          <span className="text-[var(--text-muted)]" aria-hidden="true">
            {icon}
          </span>
        ) : null}
        {label}
      </div>
      <div
        className={`mt-2 truncate text-lg font-normal tracking-tight ${
          tone ? tones[tone] : "text-[var(--text)]"
        }`}
      >
        {children}
      </div>
    </div>
  );
}
