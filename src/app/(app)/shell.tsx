"use client";

import { useEffect, useState, type ReactNode } from "react";

import { Sidebar } from "./sidebar.tsx";
import type { SiteOption } from "@/lib/site.ts";

import { Topbar, type GuardState } from "./topbar.tsx";

/**
 * Drží stav mobilního šuplíku. Nad lg je sidebar součástí layoutu
 * a stav se nepoužívá; pod lg je vysunutý mimo obrazovku a obsah
 * dostane celou šířku.
 */
export function Shell({
  children,
  siteName,
  siteOptions,
  selectedSiteId,
  guardState,
}: {
  children: ReactNode;
  siteName: string;
  siteOptions: SiteOption[];
  selectedSiteId: string | null;
  guardState: GuardState;
}) {
  const [menuOpen, setMenuOpen] = useState(false);

  // Zavření po přechodu na jinou stránku řeší Sidebar klepnutím na
  // odkaz, ne efekt nad usePathname — stav se tím nemění kaskádou.
  useEffect(() => {
    if (!menuOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [menuOpen]);

  return (
    <div className="flex h-dvh overflow-hidden">
      <Sidebar open={menuOpen} onClose={() => setMenuOpen(false)} />

      {/* Podklad pod šuplíkem — klepnutí vedle menu ho zavře. */}
      {menuOpen ? (
        <button
          type="button"
          aria-label="Zavřít menu"
          onClick={() => setMenuOpen(false)}
          className="fixed inset-0 z-40 bg-black/60 lg:hidden"
        />
      ) : null}

      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar
          siteName={siteName}
          siteOptions={siteOptions}
          selectedSiteId={selectedSiteId}
          guardState={guardState}
          menuOpen={menuOpen}
          onMenuToggle={() => setMenuOpen((open) => !open)}
        />
        <main className="flex-1 overflow-y-auto">
          {/* Obsah se na širokých monitorech nerozlévá donekonečna. */}
          <div className="mx-auto w-full max-w-[1280px] p-5 sm:p-8">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
