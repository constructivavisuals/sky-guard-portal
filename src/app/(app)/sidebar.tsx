"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  ScanEye,
  Send,
  Plane,
  MapPin,
  Settings,
} from "lucide-react";

import { Logo } from "@/components/logo.tsx";

export const NAV_ITEMS = [
  { href: "/prehled", label: "Přehled", icon: LayoutDashboard },
  { href: "/detekce", label: "Detekce", icon: ScanEye },
  { href: "/vyjezdy", label: "Výjezdy", icon: Send },
  { href: "/lety", label: "Lety", icon: Plane },
  { href: "/lokality", label: "Lokality", icon: MapPin },
  { href: "/nastaveni", label: "Nastavení", icon: Settings },
] as const;

export function Sidebar() {
  const pathname = usePathname();

  return (
    <nav
      aria-label="Hlavní navigace"
      className="flex h-full w-60 shrink-0 flex-col border-r border-[var(--border)] bg-[var(--surface)]"
    >
      <div className="flex h-16 items-center px-5 border-b border-[var(--border)]">
        <Logo />
      </div>

      <ul className="flex-1 p-3 space-y-1">
        {NAV_ITEMS.map(({ href, label, icon: Icon }) => {
          const active = pathname === href || pathname.startsWith(`${href}/`);
          return (
            <li key={href}>
              <Link
                href={href}
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
    </nav>
  );
}
