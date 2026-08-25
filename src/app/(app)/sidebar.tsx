"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  ScanEye,
  Send,
  Plane,
  MapPin,
  Radar,
  Cctv,
  Settings,
  X,
  LogOut,
} from "lucide-react";

import { Logo } from "@/components/logo.tsx";
import type { CurrentProfile } from "@/lib/profile.ts";
import { profileInitial } from "@/lib/profile.ts";
import { USER_ROLE_LABELS } from "@/types/database.ts";

export const NAV_ITEMS = [
  { href: "/prehled", label: "Přehled", icon: LayoutDashboard },
  { href: "/detekce", label: "Detekce", icon: ScanEye },
  { href: "/vyjezdy", label: "Výjezdy", icon: Send },
  { href: "/lety", label: "Lety", icon: Plane },
  { href: "/lokality", label: "Lokality", icon: MapPin },
  { href: "/zony", label: "Zóny", icon: Radar },
  { href: "/kamery", label: "Kamery", icon: Cctv },
  { href: "/nastaveni", label: "Nastavení", icon: Settings },
] as const;

export function Sidebar({
  open,
  onClose,
  profile,
}: {
  open: boolean;
  onClose: () => void;
  profile: CurrentProfile | null;
}) {
  const pathname = usePathname();

  return (
    <nav
      aria-label="Hlavní navigace"
      className={`fixed inset-y-0 left-0 z-50 flex h-full w-60 shrink-0 flex-col border-r border-[var(--border)] bg-[var(--surface)] transition-transform duration-200 lg:static lg:translate-x-0 lg:visible ${
        open
          ? "translate-x-0"
          : // `invisible` vyřadí odkazy i z pořadí tabulátoru — jinak by
            // se na mobilu dalo klávesnicí projít do zasunutého menu.
            "-translate-x-full invisible"
      }`}
    >
      <div className="flex h-16 items-center justify-between gap-2 px-5 border-b border-[var(--border)]">
        <Logo />
        <button
          type="button"
          onClick={onClose}
          aria-label="Zavřít menu"
          className="-mr-2 inline-flex h-9 w-9 items-center justify-center rounded-lg text-[var(--text-muted)] hover:bg-[var(--surface-2)] hover:text-[var(--text)] lg:hidden"
        >
          <X className="h-5 w-5" aria-hidden="true" />
        </button>
      </div>

      <ul className="flex-1 overflow-y-auto p-3 space-y-1">
        {NAV_ITEMS.map(({ href, label, icon: Icon }) => {
          const active = pathname === href || pathname.startsWith(`${href}/`);
          return (
            <li key={href}>
              <Link
                href={href}
                onClick={onClose}
                aria-current={active ? "page" : undefined}
                className={`flex items-center gap-3 rounded-lg px-3 h-10 text-sm transition ${
                  active
                    ? // Aktivní položka je plocha, ne záře — ta patří
                      // primární akci a poplachu.
                      "bg-[var(--surface-2)] text-[var(--text)] font-medium"
                    : "text-[var(--text-muted)] hover:text-[var(--text)] hover:bg-[var(--surface-2)]"
                }`}
              >
                <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
                {label}
              </Link>
            </li>
          );
        })}
      </ul>

      {profile ? <UserBlock profile={profile} /> : null}
    </nav>
  );
}

/**
 * Přihlášený uživatel dole v sidebaru. Odhlášení sedí tady, ne
 * v horní liště — je to úkon nad účtem, ne nad lokalitou.
 */
function UserBlock({ profile }: { profile: CurrentProfile }) {
  return (
    <div className="mt-auto border-t border-[var(--border)] p-3">
      <div className="flex items-center gap-3">
        <span
          className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[var(--accent)] text-sm font-semibold text-white"
          aria-hidden="true"
        >
          {profileInitial(profile)}
        </span>

        <div className="min-w-0 flex-1">
          <p className="truncate text-sm" title={profile.email ?? undefined}>
            {profile.email ?? "Bez e-mailu"}
          </p>
          <p className="truncate text-xs text-[var(--text-muted)]">
            {USER_ROLE_LABELS[profile.role]}
          </p>
        </div>

        <form action="/auth/odhlaseni" method="post">
          <button
            type="submit"
            aria-label="Odhlásit se"
            title="Odhlásit se"
            className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-[var(--text-muted)] transition hover:bg-[var(--surface-2)] hover:text-[var(--text)]"
          >
            <LogOut className="h-4 w-4" aria-hidden="true" />
          </button>
        </form>
      </div>
    </div>
  );
}
