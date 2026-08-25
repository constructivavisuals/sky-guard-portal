import { runDispatch, type DispatchContext } from "../dispatch/run.ts";
import { matchPlate, type KnownPlate, type PlateMatch } from "../plates.ts";
import { supabaseAdmin } from "../supabase-admin.ts";

// Co se stane, když se značka přečte.
//
// ═══ Proč to nerozhoduje o zásahu jako první ═══════════════════════
// Zásah už dávno běží. Vjezd je detekce vozidla a ta v ostrém režimu
// spustí výjezd hned, na stupni 2 — čekat na model, který odpovídá
// vteřiny, by znamenalo pouštět auto do areálu a teprve pak přemýšlet.
//
// Značka tedy rozhodnutí nedělá, jen ho upřesňuje:
//
//   deny    → eskalace na stupeň 5, stejnou cestou jako detekce osoby
//   unknown → nic navíc; zásah na stupni 2 už odešel a to je ta
//             „nižší úroveň“
//   allow   → nic; známé auto zásah nespouští. Ten už ale odešel,
//             protože v době příjezdu značku nikdo neznal — proto se
//             u vjezdu zaznamená, že šlo o známé vozidlo, aby bylo
//             v přehledu vidět, proč dron vzlétl zbytečně.
//   unread  → nic. Nejistá značka se nepáruje vůbec.
// ═══════════════════════════════════════════════════════════════════

export interface PlateOutcome {
  match: PlateMatch;
  /** Vznikl kvůli značce další zásah? */
  escalated: boolean;
}

/**
 * Vyhodnotí přečtenou značku proti seznamu lokality a případně
 * eskaluje.
 *
 * Seznam se čte pod service_role, protože běží na pozadí po odeslání
 * odpovědi — žádná session tu není.
 */
export async function resolvePlate(options: {
  siteId: string;
  plate: string | null;
  confidence: number | null;
  /** Kontext pro případnou eskalaci; tentýž, ze kterého vzešel vjezd. */
  dispatchContext: DispatchContext;
}): Promise<PlateOutcome> {
  const { data: known } = await supabaseAdmin()
    .from("known_plates")
    .select("id, plate, label, list_type")
    .eq("site_id", options.siteId)
    .returns<KnownPlate[]>();

  const match = matchPlate(options.plate, options.confidence, known ?? []);

  if (match.verdict !== "deny") {
    return { match, escalated: false };
  }

  // Nežádoucí značka: druhý zásah na stupni osoby. Ne úprava toho
  // prvního — v dispatches má zůstat obojí, aby bylo vidět, že první
  // odešel na dvojce ještě před přečtením značky.
  const result = await runDispatch({
    ...options.dispatchContext,
    // Stupeň se u vozidla odvozuje z třídy; osoba je jediné, co dá
    // pětku, a přesně o ten stupeň tu jde.
    objectClass: "person",
  });

  return { match, escalated: result.status === "recorded" };
}
