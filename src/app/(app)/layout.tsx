import { Sidebar } from "./sidebar.tsx";
import { Topbar } from "./topbar.tsx";

// App shell pro přihlášené: sidebar vlevo, lišta nahoře, obsah vpravo.
// Přístup hlídá middleware.ts, tahle vrstva se autentizací nezabývá.

export default function AppLayout({ children }: LayoutProps<"/">) {
  return (
    <div className="flex h-dvh overflow-hidden">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Název lokality a stav střežení jsou zatím pevné — data
            přijdou, až bude výběr lokality napojený. */}
        <Topbar siteName="Vyberte lokalitu" guardState="disarmed" />
        <main className="flex-1 overflow-y-auto p-8">{children}</main>
      </div>
    </div>
  );
}
