"use client";

import { useEffect, useState, type ReactNode } from "react";

import { Sidebar } from "./sidebar.tsx";
import { Topbar } from "./topbar.tsx";

/**
 * Drží stav mobilního šuplíku. Nad lg je sidebar součástí layoutu
 * a stav se nepoužívá; pod lg je vysunutý mimo obrazovku a obsah
 * dostane celou šířku.
 */
export function Shell({ children }: { children: ReactNode }) {
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
        {/* Název lokality a stav střežení jsou zatím pevné — data
            přijdou, až bude výběr lokality napojený. */}
        <Topbar
          siteName="Vyberte lokalitu"
          guardState="disarmed"
          menuOpen={menuOpen}
          onMenuToggle={() => setMenuOpen((open) => !open)}
        />
        <main className="flex-1 overflow-y-auto p-5 sm:p-8">{children}</main>
      </div>
    </div>
  );
}
