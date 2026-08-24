import { cookies } from "next/headers";

import { createClient } from "@/lib/supabase/server.ts";

import { Shell } from "./shell.tsx";
import type { GuardState } from "./topbar.tsx";

// App shell pro přihlášené. Přístup hlídá middleware.ts, tahle vrstva
// se autentizací nezabývá — jen zjistí vybranou lokalitu a její stav
// střežení, aby je horní lišta mohla ukázat.

/** Cookie s vybranou lokalitou; přepínač v liště ji bude nastavovat. */
export const SITE_COOKIE = "sg-lokalita";

interface SelectedSite {
  name: string;
  guardState: GuardState;
}

async function resolveSelectedSite(): Promise<SelectedSite> {
  const fallback: SelectedSite = {
    name: "Vyberte lokalitu",
    guardState: "unknown",
  };

  try {
    const supabase = await createClient();

    const { data: sites, error } = await supabase
      .from("sites")
      .select("id, name")
      .order("name");

    if (error || !sites || sites.length === 0) return fallback;

    const preferred = (await cookies()).get(SITE_COOKIE)?.value;
    const site = sites.find((item) => item.id === preferred) ?? sites[0];

    // Ostrý režim počítá databáze, ne aplikace — armed_from/armed_to se
    // vyhodnocuje v časové zóně lokality (viz site_is_armed v migraci
    // 20260824120000). Kdyby to počítal server, rozešly by se výsledky
    // s tím, podle čeho se potlačují výjezdy.
    const { data: armed, error: armedError } = await supabase.rpc(
      "site_is_armed",
      { p_site_id: site.id },
    );

    if (armedError) {
      // Nezjištěný stav se nesmí tvářit jako ověřené „nestřeženo“.
      return { name: site.name, guardState: "unknown" };
    }

    return { name: site.name, guardState: armed ? "armed" : "disarmed" };
  } catch {
    // Chybějící konfigurace nebo nenasazené schéma nesmí shodit celý shell.
    return fallback;
  }
}

export default async function AppLayout({ children }: LayoutProps<"/">) {
  const { name, guardState } = await resolveSelectedSite();

  return (
    <Shell siteName={name} guardState={guardState}>
      {children}
    </Shell>
  );
}
