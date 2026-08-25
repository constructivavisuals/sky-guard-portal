import { getDockState, type DockStateResult } from "./flighthub.ts";

// Krátká cache stavu doku.
//
// Přehled se na stav ptá při každém načtení stránky a několik uživatelů
// u jedné lokality by z FlightHubu tahalo totéž několikrát za vteřinu.
// Minuta je kompromis: stav doku se tak rychle nemění, ale operátor
// nemá koukat na výrazně starší údaj, než jaký vidí v DJI aplikaci.
//
// Cache je v paměti procesu. V serverless prostředí to znamená jednu
// na instanci, ne sdílenou — což pro tenhle účel stačí, protože jde
// o omezení nárazu, ne o konzistenci.

const TTL_MS = 60_000;

interface Entry {
  at: number;
  result: DockStateResult;
}

const cache = new Map<string, Entry>();

// Rozdělaná volání. Přehled se na tentýž dok ptá ze tří míst naráz
// (údaje ve stavovém pruhu, varování a bod na mapě) — bez tohohle by
// z prázdné cache odešly tři požadavky do FlightHubu místo jednoho.
const inflight = new Map<string, Promise<DockStateResult>>();

export interface CachedDockState {
  result: DockStateResult;
  /** Stáří údaje v milisekundách. 0 u čerstvě staženého. */
  ageMs: number;
}

/**
 * Stav doku z cache, nebo stažený a uložený.
 *
 * `fetcher` a `now` jdou podstrčit, aby šlo chování cache otestovat bez
 * sítě.
 */
export async function getDockStateCached(
  dockSn: string,
  options: {
    ttlMs?: number;
    now?: () => number;
    fetcher?: (sn: string) => Promise<DockStateResult>;
  } = {},
): Promise<CachedDockState> {
  const ttl = options.ttlMs ?? TTL_MS;
  const now = options.now ?? Date.now;
  const fetcher = options.fetcher ?? getDockState;

  const cached = cache.get(dockSn);
  if (cached && now() - cached.at < ttl) {
    return { result: cached.result, ageMs: now() - cached.at };
  }

  let pending = inflight.get(dockSn);
  if (!pending) {
    pending = fetcher(dockSn).finally(() => inflight.delete(dockSn));
    inflight.set(dockSn, pending);
  }
  const result = await pending;

  // Chyby se cachují taky, jen nakrátko — jinak by nedostupný FlightHub
  // znamenal volání při každém načtení stránky.
  cache.set(dockSn, { at: now(), result });
  return { result, ageMs: 0 };
}

/** Jen pro testy. */
export function clearDockStateCache(): void {
  cache.clear();
}
