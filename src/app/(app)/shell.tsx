import type { ReactNode } from "react";

import type { CurrentProfile } from "@/lib/profile.ts";
import type { SiteCapabilities } from "@/lib/site.ts";
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
  capabilities,
}: {
  children: ReactNode;
  siteName: string;
  siteOptions: SiteOption[];
  selectedSiteId: string | null;
  guardState: GuardState;
  profile: CurrentProfile | null;
  capabilities: SiteCapabilities;
}) {
  // ═══ `min-h-dvh`, ne `h-dvh` ═══════════════════════════════════
  // Pevná výška se tu jednou zkoušela a udělala horší věc, než
  // opravila: v aplikaci spuštěné z plochy se `dvh` vyhodnotí ještě
  // během náběhu, kdy okno nemá konečnou velikost — a se skrytým
  // přetečením se to pak nemělo jak srovnat. Projevilo se to přesně
  // takhle: „po prvním otevření je lišta posunutá".
  //
  // Krátká stránka se neposouvá proto, že je krátká, ne proto, že by
  // se jí to zakázalo.
  return (
    <div className="flex min-h-dvh bg-[var(--bg)] lg:h-dvh lg:overflow-hidden">
      <Sidebar profile={profile} capabilities={capabilities} />

      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar
          siteName={siteName}
          siteOptions={siteOptions}
          selectedSiteId={selectedSiteId}
          guardState={guardState}
          profile={profile}
        />
        {/* overflow-x: clip kvůli mřížkám s hairline-grid: ty schovávají
            krajní linku záporným okrajem, takže jsou o pixel širší než
            sloupec. Nad lg ten pixel spolkne odsazení stránky, na
            mobilu jde mřížka od kraje ke kraji a stránka se o něj dá
            posunout do strany — na dotykovém displeji to není
            neviditelná drobnost, ale obsah, který se pod prstem hýbe.

            `clip`, ne `hidden`: nezakládá posuvný kontejner, takže
            nekoliduje se svislým posouváním ani se `sticky` uvnitř. */}
        <main className="flex flex-1 flex-col overflow-x-clip lg:overflow-y-auto">
          {/* Spodní odsazení uvolní místo pod fixní navigací; nad lg
              už žádná není. */}
          <div className="pb-20 lg:pb-0">{children}</div>

          {/* Prázdné místo pod obsahem není prázdné — pokračují v něm
              svislé linky mřížky. Na mobilu ne: tam je plocha úzká
              a linky by z ní udělaly mříž. */}
          <div className="hidden flex-1 rule-field lg:block" aria-hidden="true" />
        </main>
      </div>

      <MobileNav isAdmin={profile?.role === "admin"} capabilities={capabilities} />
    </div>
  );
}
