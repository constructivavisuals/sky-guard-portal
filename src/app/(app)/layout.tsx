import { getCurrentProfile } from "@/lib/current-profile.ts";
import { getSiteSelection } from "@/lib/selected-site.ts";
import { createClient } from "@/lib/supabase/server.ts";

import { Shell } from "./shell.tsx";
import type { GuardState } from "./topbar.tsx";

// App shell pro přihlášené. Přístup hlídá middleware.ts, tahle vrstva
// jen zjistí vybranou lokalitu a její stav střežení pro horní lištu.

async function guardStateFor(siteId: string | null): Promise<GuardState> {
  // Bez konkrétní lokality (filtr „všechny“) není co ukazovat — stav
  // střežení je vlastnost jednoho areálu, ne jejich součtu.
  if (!siteId) return "unknown";

  try {
    const supabase = await createClient();
    // Ostrý režim počítá databáze, ne aplikace — armed_from/armed_to se
    // vyhodnocuje v časové zóně lokality (site_is_armed v migraci
    // 20260824120000). Kdyby to počítal server, rozešly by se výsledky
    // s tím, podle čeho se potlačují zásahy.
    const { data, error } = await supabase.rpc("site_is_armed", {
      p_site_id: siteId,
    });
    // Nezjištěný stav se nesmí tvářit jako ověřené „nestřeženo“.
    if (error) return "unknown";
    return data ? "armed" : "disarmed";
  } catch {
    return "unknown";
  }
}

export default async function AppLayout({ children }: LayoutProps<"/">) {
  const [{ sites, selected }, profile] = await Promise.all([
    getSiteSelection(),
    getCurrentProfile(),
  ]);
  const guardState = await guardStateFor(selected?.id ?? null);

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
