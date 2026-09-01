import { supabaseAdmin } from "./supabase-admin.ts";

// Střeží lokalita právě teď?
//
// ═══ Proč přes RPC a ne výpočtem tady ══════════════════════════════
// Okno má zónu, dny v týdnu a přesahuje půlnoc. Počítat to na dvou
// místech znamená, že se ta místa jednou rozejdou — a projeví se to
// tak, že se něco nestane a nikdo neví proč. `site_is_armed` je
// v databázi a rozhoduje jediná.
//
// ═══ Když se stav nepodaří zjistit ═════════════════════════════════
// Bere se jako STŘEŽENO. U obou volajících je to ta bezpečnější
// strana:
//
//   ohlášení příjezdu   neznámý stav nemá odbavovat auta
//   klip u detekce      radši klip navíc než chybějící důkaz
//
// Obojí stojí něco malého. Opačná volba stojí to, kvůli čemu tu
// systém je.
export async function isSiteArmedNow(
  db: ReturnType<typeof supabaseAdmin>,
  siteId: string,
  at: Date,
  duvod: string,
): Promise<boolean> {
  const { data, error } = await db.rpc("site_is_armed", {
    p_site_id: siteId,
    p_at: at.toISOString(),
  });

  if (error) {
    console.warn(`Režim střežení se nezjistil (${duvod})`, {
      site_id: siteId,
      message: error.message,
    });
    return true;
  }

  return data === true;
}
