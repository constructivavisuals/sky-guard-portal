// Co se ukazuje podle toho, co lokalita má.
//
// Čistá funkce bez importu Reactu, aby ji směl volat i server. Sidebar
// a spodní lišta jsou klientské komponenty ("use client"); kdyby tohle
// bydlelo v nich, dostal by server jen KLIENTSKOU REFERENCI a volání
// by spadlo za běhu na „Attempted to call visibleNavItems() from the
// server". Přesně to se stalo — a build to nechytil, protože /prehled
// je dynamická stránka a při buildu se nespustí.
//
// Stejné dělení jako site.ts (čisté) vs. selected-site.ts (server).

/** Co položka potřebuje, aby dávala smysl. null = ukazuje se vždycky. */
export type NavNeeds = "drone" | "cameras" | null;

export interface NavCapabilities {
  drone: boolean;
  cameras: boolean;
}

/**
 * Vyfiltruje položky, které pro daný výběr lokalit dávají smysl.
 *
 * Používá to navigace i mřížka čísel na přehledu, takže je generická
 * přes `T` — společné je jen pole `needs`.
 */
export function visibleNavItems<T extends { needs: NavNeeds }>(
  items: readonly T[],
  capabilities: NavCapabilities,
): T[] {
  return items.filter((item) => {
    if (item.needs === "drone") return capabilities.drone;
    if (item.needs === "cameras") return capabilities.cameras;
    return true;
  });
}
