import { supabaseAdmin } from "../supabase-admin.ts";
import type { Json } from "../../types/database.ts";

import { pingHealthcheck } from "./healthcheck.ts";
import { CRON_RETENTION_DAYS } from "./runs.ts";

// Zápis běhu cronu. Odděleno od čistých pravidel v runs.ts, aby se ta
// dala testovat bez databáze.

/**
 * Zaznamená, že endpoint doběhl.
 *
 * NIKDY nevyhazuje a nikdy nemění výsledek běhu: evidence je dohled nad
 * cronem, ne jeho součást. Kdyby zápis shodil endpoint, rozbil by
 * přesně to, co má hlídat.
 *
 * Zapisuje se i neúspěšný běh — „doběhlo to a selhalo“ a „vůbec to
 * nedoběhlo“ jsou dvě různé diagnózy a bez záznamu by splynuly.
 */
export async function recordCronRun(
  name: string,
  result: Record<string, unknown>,
  /**
   * Doběhla úloha bez chyby? Musí odpovídat HTTP stavu, který endpoint
   * vrátí — z toho se řídí i hlídač zvenčí, a dvě různá tvrzení o témž
   * běhu jsou horší než žádné.
   */
  ok = true,
): Promise<void> {
  // Ping ven jde jako první a nezávisle na zápisu: kdyby byla nedostupná
  // databáze, hlídač se to musí dozvědět právě proto, že evidence
  // uvnitř portálu v tu chvíli nefunguje.
  await pingHealthcheck(name, ok);

  try {
    const db = supabaseAdmin();

    const { error } = await db.from("cron_runs").insert({
      name,
      result: result as Json,
    });

    if (error) {
      // Chybějící tabulka (migrace 20260905120000 ještě neběžela) je
      // varování, ne chyba: endpointy fungují dál, jen se o nich neví.
      console.warn("Běh cronu se nepodařilo zaznamenat", {
        name,
        message: error.message,
      });
      return;
    }

    // Úklid rovnou při zápisu. Vlastní úloha na mazání by byla čtvrtý
    // cron, který by taky mohl přestat běžet.
    const hranice = new Date(Date.now() - CRON_RETENTION_DAYS * 86_400_000);
    await db.from("cron_runs").delete().eq("name", name).lt("ran_at", hranice.toISOString());
  } catch (error) {
    console.warn("Zápis běhu cronu selhal", {
      name,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
