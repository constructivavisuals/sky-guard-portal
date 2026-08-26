"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  CalendarClock,
  CarFront,
  Cctv,
  FileText,
  LayoutDashboard,
  LogOut,
  MapPin,
  MoreHorizontal,
  Plane,
  Radar,
  Route,
  ScanEye,
  Send,
  ScanLine,
  Truck,
  Settings,
  Users,
  X,
} from "lucide-react";
import { useState } from "react";

// Spodní navigace pro mobil, vzor převzatý z constructiva-portal.
// Pět položek je strop, na který se na 375 px vejdou popisky — zbytek
// jde pod „Více“.

const PRIMARY = [
  { href: "/prehled", label: "Přehled", icon: LayoutDashboard },
  { href: "/detekce", label: "Detekce", icon: ScanEye },
  { href: "/zasahy", label: "Zásahy", icon: Send },
  { href: "/lety", label: "Lety", icon: Plane },
] as const;

const SECONDARY = [
  { href: "/hlidky", label: "Hlídky", icon: Route },
  { href: "/lokality", label: "Lokality", icon: MapPin },
  { href: "/zony", label: "Zóny", icon: Radar },
  { href: "/kamery", label: "Kamery", icon: Cctv },
  { href: "/vjezdy", label: "Vjezdy", icon: CarFront },
  { href: "/prijezdy", label: "Příjezdy", icon: CalendarClock },
  { href: "/reporty", label: "Reporty", icon: FileText },
  { href: "/nastaveni", label: "Nastavení", icon: Settings },
] as const;

/** Jen pro administrátora; zámek je na stránce samotné. */
const ADMIN_SECONDARY = [
  { href: "/znacky", label: "Značky", icon: ScanLine },
  { href: "/dopravci", label: "Dopravci", icon: Truck },
  { href: "/klienti", label: "Klienti", icon: Users },
] as const;

function isActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function MobileNav({ isAdmin = false }: { isAdmin?: boolean }) {
  const pathname = usePathname();
  const [session, setSession] = useState(0);
  const [moreOpen, setMoreOpen] = useState(false);

  const secondary = isAdmin ? [...SECONDARY, ...ADMIN_SECONDARY] : SECONDARY;
  const moreActive = secondary.some((item) => isActive(pathname, item.href));

  return (
    <>
      {moreOpen ? (
        <MoreSheet
          key={session}
          pathname={pathname}
          items={secondary}
          onClose={() => setMoreOpen(false)}
        />
      ) : null}

      <nav
        aria-label="Mobilní navigace"
        // pb: nad domovský indikátor iPhonu. pl/pr: krajní ikony jinak
        // lezou pod zaoblení displeje a na šířku pod výřez — spodní
        // inset tenhle problém neřeší, je svislý.
        className="lg:hidden fixed bottom-0 left-0 right-0 z-40 flex justify-around border-t border-[var(--line)] bg-[var(--bg)]/95 backdrop-blur-lg pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] pl-[max(0.25rem,env(safe-area-inset-left))] pr-[max(0.25rem,env(safe-area-inset-right))]"
      >
        {PRIMARY.map(({ href, label, icon: Icon }) => (
          <Link
            key={href}
            href={href}
            prefetch
            aria-current={isActive(pathname, href) ? "page" : undefined}
            className={`flex min-h-[44px] min-w-[44px] flex-col items-center justify-center gap-1 px-1 transition-transform duration-100 active:scale-95 ${
              isActive(pathname, href)
                ? "text-[var(--accent-bright)]"
                : "text-[var(--text-muted)]"
            }`}
          >
            <Icon className="h-5 w-5" aria-hidden="true" />
            <span className="text-[10px] font-medium leading-none tracking-tight">{label}</span>
          </Link>
        ))}

        <button
          type="button"
          onClick={() => {
            setSession((value) => value + 1);
            setMoreOpen(true);
          }}
          aria-expanded={moreOpen}
          aria-haspopup="menu"
          className={`flex min-h-[44px] min-w-[44px] flex-col items-center justify-center gap-1 px-1 transition-transform duration-100 active:scale-95 ${
            moreActive || moreOpen
              ? "text-[var(--accent-bright)]"
              : "text-[var(--text-muted)]"
          }`}
        >
          <MoreHorizontal className="h-5 w-5" aria-hidden="true" />
          <span className="text-[10px] font-medium leading-none tracking-tight">Více</span>
        </button>
      </nav>
    </>
  );
}

/** Vysunutý panel se zbytkem navigace a odhlášením. */
function MoreSheet({
  pathname,
  items,
  onClose,
}: {
  pathname: string;
  items: readonly { href: string; label: string; icon: typeof Settings }[];
  onClose: () => void;
}) {
  return (
    <div className="lg:hidden fixed inset-0 z-50 flex flex-col justify-end">
      <button
        type="button"
        aria-label="Zavřít"
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-black/70"
      />

      <div
        role="menu"
        aria-label="Další navigace"
        className="relative border-t border-[var(--line-strong)] bg-[var(--bg)] pb-[max(1rem,env(safe-area-inset-bottom))]"
      >
        <div className="flex h-14 items-center justify-between px-4">
          <h2 className="text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--text-muted)]">Více</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Zavřít"
            className="inline-flex h-9 w-9 items-center justify-center text-[var(--text-muted)] hover:bg-[var(--surface-2)] hover:text-[var(--text)]"
          >
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
        </div>

        <ul className="border-t border-[var(--line)]">
          {items.map(({ href, label, icon: Icon }) => (
            <li key={href}>
              <Link
                href={href}
                prefetch
                onClick={onClose}
                aria-current={isActive(pathname, href) ? "page" : undefined}
                className={`flex min-h-[52px] items-center gap-3 border-b border-[var(--line)] px-5 text-sm tracking-tight transition ${
                  isActive(pathname, href)
                    ? "bg-[var(--surface-2)] font-medium text-[var(--text)]"
                    : "text-[var(--text-muted)] active:bg-[var(--surface-2)]"
                }`}
              >
                <Icon className="h-5 w-5 shrink-0" aria-hidden="true" />
                {label}
              </Link>
            </li>
          ))}
        </ul>

        {/* Odhlášení sedí tady — v sidebaru, kde je na desktopu, se
            uživatel na mobilu k ničemu nedostane. */}
        <div>
          <form action="/auth/odhlaseni" method="post">
            <button
              type="submit"
              className="flex min-h-[52px] w-full items-center gap-3 px-5 text-sm tracking-tight text-[var(--text-muted)] transition active:bg-[var(--surface-2)]"
            >
              <LogOut className="h-5 w-5 shrink-0" aria-hidden="true" />
              Odhlásit se
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
