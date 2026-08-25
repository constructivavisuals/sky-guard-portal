"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  ScanEye,
  Send,
  Plane,
  Route,
  MapPin,
  Radar,
  Cctv,
  Settings,
  LogOut,
} from "lucide-react";

import { Logo } from "@/components/logo.tsx";
import type { CurrentProfile } from "@/lib/profile.ts";
import { profileInitial } from "@/lib/profile.ts";
import { USER_ROLE_LABELS } from "@/types/database.ts";

export const NAV_ITEMS = [
  { href: "/prehled", label: "Přehled", icon: LayoutDashboard },
  { href: "/detekce", label: "Detekce", icon: ScanEye },
  { href: "/zasahy", label: "Zásahy", icon: Send },
  { href: "/lety", label: "Lety", icon: Plane },
  { href: "/hlidky", label: "Hlídky", icon: Route },
  { href: "/lokality", label: "Lokality", icon: MapPin },
  { href: "/zony", label: "Zóny", icon: Radar },
  { href: "/kamery", label: "Kamery", icon: Cctv },
  { href: "/nastaveni", label: "Nastavení", icon: Settings },
] as const;

export function Sidebar({ profile }: { profile: CurrentProfile | null }) {
  const pathname = usePathname();

  return (
    <nav
      aria-label="Hlavní navigace"
      // Pod lg sidebar vůbec není — navigaci tam přebírá spodní lišta.
      className="hidden h-full w-[236px] shrink-0 flex-col border-r border-[var(--line)] bg-[var(--bg)] lg:flex"
    >
      <div className="flex h-16 items-center border-b border-[var(--line)] px-6">
        <Logo />
      </div>

      {/* Položky jsou řádky dělené vlasovou linkou, ne odsazené
          pilulky — stejný rytmus jako seznamy na webu. Aktivní řádek
          drží svislý pruh v akcentu; záře patří primární akci
          a poplachu, ne navigaci. */}
      <ul className="flex-1 overflow-y-auto">
        {NAV_ITEMS.map(({ href, label, icon: Icon }) => {
          const active = pathname === href || pathname.startsWith(`${href}/`);
          return (
            <li key={href} className="border-b border-[var(--line)]">
              <Link
                href={href}
                aria-current={active ? "page" : undefined}
                className={`group relative flex h-12 items-center gap-3 pl-6 pr-4 text-[13px] tracking-tight transition ${
                  active
                    ? "bg-[var(--surface-2)] font-medium text-[var(--text)]"
                    : "text-[var(--text-muted)] hover:bg-[var(--surface)] hover:text-[var(--text)]"
                }`}
              >
                <span
                  aria-hidden="true"
                  className={`absolute inset-y-0 left-0 w-[2px] transition ${
                    active ? "bg-[var(--accent-bright)]" : "bg-transparent"
                  }`}
                />
                <Icon
                  className={`h-4 w-4 shrink-0 transition ${
                    active ? "text-[var(--accent-bright)]" : ""
                  }`}
                  aria-hidden="true"
                />
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
    <div className="mt-auto border-t border-[var(--line)] px-5 py-4">
      <div className="flex items-center gap-3">
        <span
          className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[var(--accent)] text-[13px] font-medium text-white"
          aria-hidden="true"
        >
          {profileInitial(profile)}
        </span>

        <div className="min-w-0 flex-1">
          <p
            className="truncate text-[13px] tracking-tight"
            title={profile.email ?? undefined}
          >
            {profile.email ?? "Bez e-mailu"}
          </p>
          <p className="truncate text-[11px] uppercase tracking-[0.1em] text-[var(--text-muted)]">
            {USER_ROLE_LABELS[profile.role]}
          </p>
        </div>

        <form action="/auth/odhlaseni" method="post">
          <button
            type="submit"
            aria-label="Odhlásit se"
            title="Odhlásit se"
            className="inline-flex h-9 w-9 shrink-0 items-center justify-center text-[var(--text-muted)] transition hover:bg-[var(--surface-2)] hover:text-[var(--text)]"
          >
            <LogOut className="h-4 w-4" aria-hidden="true" />
          </button>
        </form>
      </div>
    </div>
  );
}
