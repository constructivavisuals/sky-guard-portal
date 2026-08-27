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
 * JEDINÁ tabulka pravidel, kterou stránka má co splňovat.
 *
 * ═══ Proč tabulka a ne pole u položky ═══════════════════════════════
 * Pravidlo bylo dřív vypsané třikrát — v sidebaru, ve spodní liště
 * a v dlaždicích přehledu. Tři kopie se rozešly přesně tak, jak se
 * kopie rozcházejí: detekce zmizely areálu bez kamer, ale jen na
 * jednom ze tří míst, a test nic nechytil, protože si vozil vlastní
 * kopii tabulky ve fixture. Teď je tabulka jedna a test sahá na ni.
 *
 * ═══ Detekce patří k obojímu ════════════════════════════════════════
 * Kamera detekuje člověka sama (SMD), dron při hlídce. Vázat detekce
 * na kamery znamenalo, že areál s dronem a bez kamer neměl v menu
 * položku, na které jsou jeho vlastní dronové detekce.
 *
 * Skrývání v UI NENÍ bezpečnost — stránky zůstávají dostupné a hlídá
 * je RLS. Tohle jen uklízí obrazovku.
 */
export const NAV_NEEDS = {
  "/prehled": null,
  "/detekce": null,
  "/zasahy": "drone",
  "/lety": "drone",
  "/hlidky": "drone",
  "/arealy": null,
  "/zaznamy": "cameras",
  "/brana": "cameras",
  "/reporty": null,
  "/nastaveni": null,
  "/klienti": null,
} as const satisfies Record<string, NavNeeds>;

/**
 * Co stránka potřebuje. Neznámá cesta se ukazuje vždycky.
 *
 * Výchozí hodnota míří na bezpečnou stranu: zapomenutá položka bude
 * navíc, ne chybět. Chybějící položka vypadá jako rozbitý portál
 * a člověk ji nemá jak najít; přebývající se prokliká a nanejvýš je
 * prázdná.
 */
export function routeNeeds(href: string): NavNeeds {
  return (NAV_NEEDS as Record<string, NavNeeds>)[href] ?? null;
}

/**
 * Vyfiltruje položky navigace podle schopností lokality.
 *
 * Bere jen `href` — pravidlo si dohledá sama. Komponenta si ho tedy
 * nemůže napsat jinak, protože ho nepíše vůbec.
 */
export function visibleRoutes<T extends { href: string }>(
  items: readonly T[],
  capabilities: NavCapabilities,
): T[] {
  return items.filter((item) => allows(routeNeeds(item.href), capabilities));
}

/**
 * Totéž pro věci, které nejsou stránky — dlaždice čísel na přehledu.
 *
 * Ty pravidlo nést musí: „Neznámých značek“ není cesta a v tabulce
 * výš by neměla co dělat.
 */
export function visibleNavItems<T extends { needs: NavNeeds }>(
  items: readonly T[],
  capabilities: NavCapabilities,
): T[] {
  return items.filter((item) => allows(item.needs, capabilities));
}

function allows(needs: NavNeeds, capabilities: NavCapabilities): boolean {
  if (needs === "drone") return capabilities.drone;
  if (needs === "cameras") return capabilities.cameras;
  return true;
}
