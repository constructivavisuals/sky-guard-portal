"use server";

import { revalidatePath } from "next/cache";

import { getCurrentProfile } from "@/lib/current-profile.ts";
import { runDispatch, type DispatchContext } from "@/lib/dispatch/run.ts";
import { isOperator } from "@/lib/profile.ts";
import { createClient } from "@/lib/supabase/server.ts";
import type { DispatchOutcome } from "@/types/database.ts";

// Ruční zásah z portálu.
//
// ═══ Proč to jde touž cestou jako detekce ══════════════════════════
// Tlačítko volá runDispatch se vším, co k němu patří: ostrý režim,
// cooldown, trasa zóny, stav doku. Obejít rozhodování by znamenalo
// druhou sadu pravidel, která se s tou první časem rozejde — a přesně
// v tom rozdílu by pak vzlétl dron, který vzlétnout neměl.
//
// Z toho plyne, že ruční zásah může skončit potlačením. Mimo hlídané
// okno se neletí ani na povel. Výsledek se hlásí tak, jak dopadl:
// „odesláno“ u potlačeného zásahu by znamenalo, že operátor čeká dron,
// který nepřiletí.
//
// ═══ Bez falešné detekce ═══════════════════════════════════════════
// dispatches.triggered_by_detection zůstává NULL — schéma to tak má
// popsané od první migrace („NULL = ruční výjezd z portálu“). Vyrobit
// kvůli tlačítku řádek v detections by znamenalo zapsat do důkazní
// tabulky událost, kterou nikdo neviděl.
// ═══════════════════════════════════════════════════════════════════

export interface ManualDispatchState {
  ok: boolean;
  message?: string;
}

/** Co se ukáže operátorovi podle toho, jak zásah dopadl. */
const VYSLEDEK: Record<DispatchOutcome, ManualDispatchState> = {
  sent: { ok: true, message: "Zásah odeslán, dron vyráží." },
  suppressed_disarmed: {
    ok: false,
    message: "Neodesláno — areál právě nestřeží. Zásah je zapsaný.",
  },
  suppressed_cooldown: {
    ok: false,
    message: "Neodesláno — od minulého zásahu neuplynul cooldown. Zásah je zapsaný.",
  },
  suppressed_dock: {
    ok: false,
    message: "Neodesláno — dok není ve stavu, ze kterého se dá vzlétnout. Zásah je zapsaný.",
  },
  suppressed_unknown: {
    ok: false,
    message: "Neodesláno — nepodařilo se zjistit stav areálu. Zásah je zapsaný.",
  },
  suppressed_announced: {
    ok: false,
    message: "Neodesláno — vjezd byl předem ohlášený. Zásah je zapsaný.",
  },
  failed: {
    ok: false,
    message: "Odeslání do FlightHubu selhalo. Zásah je zapsaný i s odpovědí.",
  },
};

interface ZoneRow {
  id: string;
  name: string;
  enabled: boolean;
  location: string | null;
  default_level: number | null;
  wayline_uuid: string | null;
  site_id: string;
  sites: {
    timezone: string;
    cooldown_seconds: number;
    dock_sn: string | null;
  } | null;
}

/** Sloupce bez těch, které přidávají ručně nasazované migrace. */
const ZAKLAD =
  "id, name, enabled, location, default_level, site_id, " +
  "sites(timezone, cooldown_seconds, dock_sn)";

export async function poslatDronDoZony(
  _prev: ManualDispatchState,
  data: FormData,
): Promise<ManualDispatchState> {
  const profile = await getCurrentProfile();
  // Skrytí tlačítka není ochrana — role se kontroluje tady, ne v UI.
  // Skutečnou zárukou zůstává RLS: čtení zóny níž běží pod session
  // uživatele, takže na cizí areál se nikdo nedostane ani odsud.
  if (!isOperator(profile)) {
    return { ok: false, message: "Zásah smí poslat jen administrátor nebo operátor." };
  }

  const zoneId = String(data.get("zone_id") ?? "");
  if (!zoneId) return { ok: false, message: "Chybí zóna." };

  const supabase = await createClient();
  const dotaz = (sloupce: string) =>
    supabase.from("zones").select(sloupce).eq("id", zoneId).maybeSingle<ZoneRow>();

  // Dvoustupňový výběr jako v seznamu zón: wayline_uuid přidává migrace
  // 20260903180000 a PostgREST odmítne celý dotaz, když jediný sloupec
  // chybí. Bez záchytné větve by tlačítko na nezmigrované databázi
  // hlásilo „zónu se nepodařilo najít“ místo „zóna nemá trasu“.
  let { data: zone, error } = await dotaz(`${ZAKLAD}, wayline_uuid`);
  if (error) {
    ({ data: zone, error } = await dotaz(ZAKLAD));
    if (zone) zone = { ...zone, wayline_uuid: null };
  }

  if (error || !zone || !zone.sites) {
    return { ok: false, message: "Zónu se nepodařilo najít." };
  }

  // Vypnutá zóna se nepošle vůbec. runDispatch by ji sice potlačil
  // (zone_enabled = false se chová jako mimo režim), ale zapsaný zásah
  // do evidence u něčeho, co je schválně vypnuté, jen přidá šum.
  if (!zone.enabled) {
    return { ok: false, message: "Zóna je vypnutá. Nejdřív ji zapněte." };
  }

  const now = new Date();
  const context: DispatchContext = {
    detectionId: null,
    siteId: zone.site_id,
    zoneId: zone.id,
    zoneName: zone.name,
    zoneEnabled: zone.enabled,
    zoneLocation: zone.location,
    siteCooldownSeconds: zone.sites.cooldown_seconds,
    siteTimezone: zone.sites.timezone,
    siteDockSn: zone.sites.dock_sn,
    zoneWaylineUuid: zone.wayline_uuid,
    // Hranice zóny platí i tady, i když ruční zásah stejně jede na
    // nejvyšším stupni — zvednout se dá jen nahoru, takže nic nezmění.
    zoneDefaultLevel: zone.default_level,
    manual: { actorId: profile?.id ?? null },
    // Třída objektu je vstup rozhodování o stupni, který si ruční zásah
    // určuje sám. Do důvodu se neuloží.
    objectClass: "unknown",
    detectedAt: now,
    receivedAt: now,
  };

  const result = await runDispatch(context);

  // Přehled i seznam zásahů se mění bez ohledu na výsledek — potlačený
  // zásah je taky řádek.
  revalidatePath("/", "layout");

  if (result.status === "recorded") return VYSLEDEK[result.outcome];

  // Zbývající dva stavy znamenají, že po pokusu nezůstalo nic. To se
  // nesmí ztratit v hlášce o potlačení.
  return {
    ok: false,
    message:
      result.status === "skipped"
        ? "Zásah nevznikl — zóna nemá kam letět."
        : "Zásah se nepodařilo zapsat. Zkuste to znovu.",
  };
}
