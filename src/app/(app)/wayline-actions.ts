"use server";

import { getCurrentProfile } from "@/lib/current-profile.ts";
import { listWaylines, type Wayline } from "@/lib/dispatch/flighthub.ts";
import { isAdmin } from "@/lib/profile.ts";

// Seznam tras z FlightHubu se tahá až ve chvíli, kdy někdo otevře
// formulář hlídky.
//
// Dřív se načítal při každém renderu /hlidky, takže se na každé
// zobrazení stránky čekalo skoro vteřinu na cizí API — a to kvůli
// seznamu, který uvidí jen admin, a jen když klikne na tlačítko.

export type WaylineResult =
  | { ok: true; waylines: Wayline[] }
  | { ok: false; message: string };

/** Trasy se v DJI mění zřídka; minuta ušetří opakované volání při proklikávání. */
const TTL_MS = 60_000;

let cache: { at: number; result: WaylineResult } | null = null;

export async function nacistTrasy(): Promise<WaylineResult> {
  // Kontrola role tu není bezpečnostní hranice v tom smyslu jako RLS —
  // FlightHub žádnou nemá. Právě proto se sem nesmí dostat nikdo jiný
  // než admin: byl by to seznam tras cizího projektu.
  if (!isAdmin(await getCurrentProfile())) {
    return { ok: false, message: "Na zobrazení tras nemáte oprávnění." };
  }

  if (cache && Date.now() - cache.at < TTL_MS) return cache.result;

  const result = await listWaylines();
  cache = { at: Date.now(), result };
  return result;
}
