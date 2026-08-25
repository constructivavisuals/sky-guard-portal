import type { ReactNode } from "react";

import type { CurrentProfile } from "@/lib/profile.ts";
import type { SiteOption } from "@/lib/site.ts";

import { MobileNav } from "./mobile-nav.tsx";
import { Sidebar } from "./sidebar.tsx";
import { Topbar, type GuardState } from "./topbar.tsx";

// App shell pro přihlášené.
//
// Obsah jde od kraje ke kraji a nemá vlastní odsazení — to si nese
// každý blok sám. Jen tak můžou vlasové linky mezi bloky procházet
// celou šířkou, což je celý princip vzhledu ze sky-guard.cz. Kontejner
// s maximální šířkou a odsazením by každou linku useknul.
//
// Nad lg je sidebar součástí layoutu, pod lg ho nahrazuje spodní
// navigace — vzor z constructiva-portal.

export function Shell({
  children,
  siteName,
  siteOptions,
  selectedSiteId,
  guardState,
  profile,
}: {
  children: ReactNode;
  siteName: string;
  siteOptions: SiteOption[];
  selectedSiteId: string | null;
  guardState: GuardState;
  profile: CurrentProfile | null;
}) {
  return (
    <div className="flex min-h-dvh bg-[var(--bg)] lg:h-dvh lg:overflow-hidden">
      <Sidebar profile={profile} />

      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar
          siteName={siteName}
          siteOptions={siteOptions}
          selectedSiteId={selectedSiteId}
          guardState={guardState}
        />
        <main className="flex flex-1 flex-col lg:overflow-y-auto">
          {/* Spodní odsazení uvolní místo pod fixní navigací; nad lg
              už žádná není. */}
          <div className="pb-24 lg:pb-0">{children}</div>

          {/* Prázdné místo pod obsahem není prázdné — pokračují v něm
              svislé linky mřížky. Na mobilu ne: tam je plocha úzká
              a linky by z ní udělaly mříž. */}
          <div className="hidden flex-1 rule-field lg:block" aria-hidden="true" />
        </main>
      </div>

      <MobileNav />
    </div>
  );
}
