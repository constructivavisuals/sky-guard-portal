import type { ReactNode } from "react";

import type { CurrentProfile } from "@/lib/profile.ts";
import type { SiteOption } from "@/lib/site.ts";

import { MobileNav } from "./mobile-nav.tsx";
import { Sidebar } from "./sidebar.tsx";
import { Topbar, type GuardState } from "./topbar.tsx";

// App shell pro přihlášené.
//
// Nad lg je sidebar součástí layoutu, pod lg ho nahrazuje spodní
// navigace — vzor z constructiva-portal. Šuplík s hamburgerem tu byl
// dřív, ale na mobilu je spodní lišta dosažitelná palcem a nepotřebuje
// dvojí klepnutí.

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
    <div className="flex min-h-dvh lg:h-dvh lg:overflow-hidden">
      <Sidebar profile={profile} />

      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar
          siteName={siteName}
          siteOptions={siteOptions}
          selectedSiteId={selectedSiteId}
          guardState={guardState}
        />
        <main className="flex-1 lg:overflow-y-auto">
          {/* Spodní odsazení uvolní místo pod fixní navigací; nad lg
              už žádná není. */}
          <div className="mx-auto w-full max-w-[1280px] p-5 pb-28 sm:p-8 sm:pb-28 lg:pb-8">
            {children}
          </div>
        </main>
      </div>

      <MobileNav />
    </div>
  );
}
