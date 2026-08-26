"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  FileText,
  LayoutDashboard,
  ScanEye,
  Send,
  Plane,
  Route,
  MapPin,
  DoorOpen,
  Settings,
  Users,
  LogOut,
} from "lucide-react";

import { Logo } from "@/components/logo.tsx";
import { logoUrl } from "@/lib/logo.ts";
import type { CurrentProfile } from "@/lib/profile.ts";
import { profileInitial } from "@/lib/profile.ts";
import { USER_ROLE_LABELS } from "@/types/database.ts";

export const NAV_ITEMS = [
  { href: "/prehled", label: "Přehled", icon: LayoutDashboard },
  { href: "/detekce", label: "Detekce", icon: ScanEye },
  { href: "/zasahy", label: "Zásahy", icon: Send },
  { href: "/lety", label: "Lety", icon: Plane },
  { href: "/hlidky", label: "Hlídky", icon: Route },
  { href: "/arealy", label: "Areály", icon: MapPin },
  { href: "/brana", label: "Brána", icon: DoorOpen },
  { href: "/reporty", label: "Reporty", icon: FileText },
  { href: "/nastaveni", label: "Nastavení", icon: Settings },
] as const;

/**
 * Položky jen pro administrátora.
 *
 * Skrytí v UI není bezpečnost — na /klienti stojí zámek v samotné
 * stránce (notFound pro neadmina) a na akcích, které sahají na Admin
 * API. Tohle jen uklízí navigaci klientovi, který by tam stejně
 * neprošel.
 */
const ADMIN_ITEMS = [
  { href: "/klienti", label: "Klienti", icon: Users },
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

      {/* Logo klienta pod tím naším. Portál je jeho, ne náš katalog —
          a zároveň je hned vidět, za koho je člověk přihlášený. */}
      {profile?.logoPath ? (
        <div className="flex items-center gap-3 border-b border-[var(--line)] px-6 py-4">
          {/* Obyčejný <img>: adresa vzniká za běhu z proměnné prostředí,
              takže by next/image potřeboval remotePatterns pro doménu,
              která se mezi prostředími liší. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={logoUrl(profile.logoPath) ?? ""}
            alt={profile.companyName ? `Logo ${profile.companyName}` : ""}
            className="h-8 w-8 shrink-0 object-contain"
          />
          {profile.companyName ? (
            <span className="truncate text-[13px] tracking-tight text-[var(--text-dim)]">
              {profile.companyName}
            </span>
          ) : null}
        </div>
      ) : null}

      {/* Položky jsou řádky dělené vlasovou linkou, ne odsazené
          pilulky — stejný rytmus jako seznamy na webu. Aktivní řádek
          drží svislý pruh v akcentu; záře patří primární akci
          a poplachu, ne navigaci. */}
      <ul className="flex-1 overflow-y-auto">
        {[...NAV_ITEMS, ...(profile?.role === "admin" ? ADMIN_ITEMS : [])].map(({ href, label, icon: Icon }) => {
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
          {/* Jméno, když ho profil má, jinak celý e-mail. Dřív se
              ořezával na šířku panelu, takže z „info@sky-guard.cz“
              zbyl kus bez významu — a to je jediné, podle čeho člověk
              pozná, pod kým je přihlášený. Radši dva řádky než půlka
              slova; break-words láme i adresu bez mezer. */}
          <p
            className="break-words text-[13px] leading-snug tracking-tight"
            title={profile.email ?? undefined}
          >
            {profile.fullName ?? profile.email ?? "Bez e-mailu"}
          </p>
          <p className="mt-0.5 truncate text-[11px] uppercase tracking-[0.1em] text-[var(--text-muted)]">
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
