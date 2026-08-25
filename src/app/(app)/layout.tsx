import { getCurrentProfile } from "@/lib/current-profile.ts";
import { getSiteSelection } from "@/lib/selected-site.ts";
import { isSiteArmed } from "@/types/database.ts";

import { Shell } from "./shell.tsx";
import type { GuardState } from "./topbar.tsx";

// App shell pro přihlášené. Přístup hlídá middleware.ts, tahle vrstva
// jen zjistí vybranou lokalitu a její stav střežení pro horní lištu.

export default async function AppLayout({ children }: LayoutProps<"/">) {
  const [{ sites, selected, selectedRow }, profile] = await Promise.all([
    getSiteSelection(),
    getCurrentProfile(),
  ]);

  // Ostrý režim se dopočítá z údajů, které lokalita už poslala s sebou,
  // místo dalšího volání site_is_armed() přes síť. Shodu obou
  // implementací hlídá paritní test v supabase/tests/run-local.sh;
  // přehled počítá totéž ze stejných dat, takže se odznak a věta na
  // stránce nemají jak rozejít.
  //
  // Bez konkrétní lokality (filtr „všechny“) není co ukazovat — stav
  // střežení je vlastnost jednoho areálu, ne jejich součtu.
  const guardState: GuardState = !selectedRow
    ? "unknown"
    : isSiteArmed(selectedRow)
      ? "armed"
      : "disarmed";

  return (
    <Shell
      siteName={
        selected?.name ?? (sites.length > 0 ? "Všechny lokality" : "Vyberte lokalitu")
      }
      siteOptions={sites}
      selectedSiteId={selected?.id ?? null}
      guardState={guardState}
      profile={profile}
    >
      {children}
    </Shell>
  );
}
