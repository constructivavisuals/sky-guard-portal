import { localDateISO, matchArrival, type ArrivalCandidate, type ArrivalVerdict } from "../arrivals/rules.ts";
import { runDispatch, type DispatchContext } from "../dispatch/run.ts";
import { isPlateReliable, matchPlate, type KnownPlate, type PlateMatch } from "../plates.ts";
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
//
// ═══ Ohlášený příjezd ══════════════════════════════════════════════
// Ohlášení je denní allow seznam plněný zvenčí. Když na vjezd sedí,
// eskalace se nekoná — ani u deny značky, protože ohlásit příjezd smí
// jen ten, komu administrátor dal odkaz.
//
// POZOR na jedno omezení: první zásah za VOZIDLO už v tu chvíli dávno
// odešel, protože nečeká na přečtení značky (a čekat nesmí). Ohlášení
// tedy ruší jen to, co by spustila značka; dron, který vzlétl na
// dvojce, se odvolat nedá. Aby to šlo dřív, musela by značku posílat
// sama kamera v těle požadavku.
// ═══════════════════════════════════════════════════════════════════

export interface PlateOutcome {
  match: PlateMatch;
  /** Vznikl kvůli značce další zásah? */
  escalated: boolean;
  /** Ohlášení, kterému vjezd odpovídal. Null = neohlášený. */
  arrival: ArrivalVerdict;
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
  /** Pásmo lokality — „dnešek“ u ohlášení je ten místní. */
  siteTimezone: string;
  /** Střežila lokalita, když vjezd nastal? */
  armed: boolean;
  plate: string | null;
  confidence: number | null;
  /** Kdy vjezd nastal. Podle toho se hledá ohlášení „na dnešek“. */
  at: Date;
  /** Kontext pro případnou eskalaci; tentýž, ze kterého vzešel vjezd. */
  dispatchContext: DispatchContext;
}): Promise<PlateOutcome> {
  const db = supabaseAdmin();
  const today = localDateISO(options.siteTimezone, options.at);

  const [known, announced] = await Promise.all([
    db
      .from("known_plates")
      .select("id, plate, label, list_type")
      .eq("site_id", options.siteId)
      .returns<KnownPlate[]>(),
    // Jen dnešek a jen nezrušené — funkční index v migraci
    // 20260906120000 je přesně na tenhle dotaz.
    db
      .from("announced_arrivals")
      .select("id, plate, arrival_date, night_ok, cancelled_at, carriers(name)")
      .eq("site_id", options.siteId)
      .eq("arrival_date", today)
      .is("cancelled_at", null)
      .returns<(ArrivalCandidate & { carriers: { name: string } | null })[]>(),
  ]);

  const match = matchPlate(options.plate, options.confidence, known.data ?? []);

  // Ohlášení se páruje jen na SPOLEHLIVĚ přečtenou značku, stejně jako
  // seznam známých. Odbavit cizí auto kvůli špatně přečtené značce je
  // díra v ostraze, ne kosmetická nepřesnost.
  const spolehliva = isPlateReliable(options.plate, options.confidence);
  const arrival = matchArrival({
    plate: spolehliva ? options.plate : null,
    today,
    armed: options.armed,
    candidates: announced.data ?? [],
  });

  if (arrival.covered) {
    const dopravce =
      (announced.data ?? []).find((row) => row.id === arrival.arrival.id)?.carriers
        ?.name ?? null;

    console.info("Vjezd byl ohlášený — zásah se neposílá", {
      site_id: options.siteId,
      arrival_id: arrival.arrival.id,
      duvod: arrival.reason,
      verdict: match.verdict,
    });

    // Zásah se zapisuje jen tam, kde by jinak nějaký vznikl. U značky
    // mimo seznam se dosud nic nezakládalo a ohlášení na tom nic
    // nemění — řádek „neodeslali jsme, co jsme stejně neposílali“ by
    // z evidence zásahů udělal seznam neudálostí.
    if (match.verdict === "deny") {
      await runDispatch({
        ...options.dispatchContext,
        objectClass: "person",
        announcedArrival: {
          id: arrival.arrival.id,
          carrier_name: dopravce,
          night_ok: arrival.arrival.night_ok,
          armed: options.armed,
        },
      });
    }

    return { match, escalated: false, arrival };
  }

  if (match.verdict !== "deny") {
    return { match, escalated: false, arrival };
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

  return { match, escalated: result.status === "recorded", arrival };
}
