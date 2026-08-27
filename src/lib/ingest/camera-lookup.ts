import type { SupabaseClient } from "@supabase/supabase-js";

import type { CameraCapabilities } from "./capabilities.ts";

// Dohledání kamery podle sériového čísla pro ingest.
//
// ═══ Proč žebřík variant ═══════════════════════════════════════════
// PostgREST odmítne CELÝ dotaz, když v něm chybí jediný sloupec. Kód
// se přitom nasazuje dřív než migrace — ty pouští člověk ručně. Bez
// záchytné větve by mezi nasazením a migrací kamera nedohledala nic,
// ingest by vracel 500 a detekce by se v tom okně nezapsaly VŮBEC.
// To se tady stalo už dvakrát (naposledy u sloupců klienta), takže
// varianty jsou vypsané a zkoušejí se od nejúplnější.
//
// Chybějící sloupec se dosazuje hodnotou, která znamená „nevíme“ —
// nikdy takovou, která by něco tvrdila. Kamera bez otisku klíče se
// ověřuje společným tajemstvím, zóna bez trasy zásah neodešle.
// ═══════════════════════════════════════════════════════════════════

export interface IngestCameraRow {
  id: string;
  site_id: string;
  zone_id: string | null;
  serial_number: string | null;
  /** NULL = kamera se ještě podepisuje společným INGEST_SECRET. */
  ingest_secret_hash: string | null;
  ingest_key_version: number;
  /**
   * Schopnosti kamery (migrace 20260910120000). NULL = sloupce ještě
   * nejsou; capabilities.ts to bere jako „nevíme“ a chová se, jako by
   * se nic nezměnilo.
   */
  detects_person: boolean | null;
  detects_vehicle: boolean | null;
  reads_plate: boolean | null;
  sites: {
    id: string;
    cooldown_seconds: number;
    timezone: string;
    dock_sn: string | null;
    /**
     * Výška návratu domů. NULL = sloupec ještě není (migrace
     * 20260916120000) a použije se DEFAULT_RTH_ALTITUDE.
     */
    rth_altitude: number | null;
  } | null;
  zones: {
    id: string;
    name: string;
    enabled: boolean;
    location: string | null;
    /** Spodní hranice stupně. Ve schématu od první migrace. */
    default_level: number | null;
    wayline_uuid: string | null;
  } | null;
}

interface Variant {
  /** Do logu, ať je poznat, která migrace chybí. */
  label: string;
  columns: string;
  hasKey: boolean;
  hasWayline: boolean;
  hasCapabilities: boolean;
  hasRth: boolean;
}

function columns(
  hasKey: boolean,
  hasWayline: boolean,
  hasCapabilities: boolean,
  hasRth: boolean,
): string {
  const klic = hasKey ? ", ingest_secret_hash, ingest_key_version" : "";
  const trasa = hasWayline ? ", wayline_uuid" : "";
  const umi = hasCapabilities
    ? ", detects_person, detects_vehicle, reads_plate"
    : "";
  const vyska = hasRth ? ", rth_altitude" : "";
  return (
    `id, site_id, zone_id, serial_number${klic}${umi}, ` +
    `sites(id, cooldown_seconds, timezone, dock_sn${vyska}), ` +
    `zones(id, name, enabled, location, default_level${trasa})`
  );
}

/** Co v téhle variantě chybí, česky a s číslem migrace. */
function label(
  hasKey: boolean,
  hasWayline: boolean,
  hasCapabilities: boolean,
  hasRth: boolean,
): string {
  const chybi: string[] = [];
  if (!hasKey) chybi.push("ingest klíč (migrace 20260829120000)");
  if (!hasWayline) chybi.push("zones.wayline_uuid (migrace 20260903180000)");
  if (!hasCapabilities) chybi.push("schopnosti kamery (migrace 20260910120000)");
  if (!hasRth) chybi.push("sites.rth_altitude (migrace 20260916120000)");
  return chybi.length === 0 ? "plné" : `bez ${chybi.join(", ")}`;
}

/**
 * Od nejúplnější k nejchudší. Pořadí není libovolné a je dané pořadím
 * cyklů: obětuje se nejdřív to nejméně důležité.
 *
 *   schopnosti  provozní údaj — bez nich se ingest chová jako dřív
 *   trasa       provozní údaj — bez ní zásah neodejde, ale detekce se
 *               zapíše a přehled na chybějící trasu upozorňuje
 *   klíč        bezpečnostní věc, obětuje se poslední
 */
const VARIANTS: Variant[] = (() => {
  const out: Variant[] = [];
  for (const hasKey of [true, false]) {
    for (const hasWayline of [true, false]) {
      for (const hasCapabilities of [true, false]) {
        for (const hasRth of [true, false]) {
          out.push({
            label: label(hasKey, hasWayline, hasCapabilities, hasRth),
            columns: columns(hasKey, hasWayline, hasCapabilities, hasRth),
            hasKey,
            hasWayline,
            hasCapabilities,
            hasRth,
          });
        }
      }
    }
  }
  return out;
})();

export interface CameraLookupResult {
  camera: IngestCameraRow | null;
  /** Neprázdné = dotaz selhal a kameru se nepodařilo dohledat vůbec. */
  error: string | null;
}

export async function findIngestCamera(
  db: SupabaseClient,
  serialNumber: string,
): Promise<CameraLookupResult> {
  let posledni = "";

  for (const variant of VARIANTS) {
    const { data, error } = await db
      .from("cameras")
      .select(variant.columns)
      .eq("serial_number", serialNumber)
      .maybeSingle<IngestCameraRow>();

    if (error) {
      posledni = error.message;
      continue;
    }

    if (variant.label !== "plné") {
      console.warn("Ingest čte kameru v omezené podobě", {
        varianta: variant.label,
      });
    }

    if (!data) return { camera: null, error: null };

    return {
      camera: {
        ...data,
        // Bez otisku se ověřuje společným tajemstvím — tak to dělal
        // celý ingest, než klíče na kameru přibyly.
        ingest_secret_hash: variant.hasKey ? data.ingest_secret_hash : null,
        ingest_key_version: variant.hasKey ? data.ingest_key_version : 1,
        // Neznámá schopnost je null, ne false: „nevíme“ se nesmí
        // zaměnit za „neumí“, jinak by po nasazení kódu před migrací
        // každá detekce vozidla vypadala jako závada.
        sites: data.sites
          ? {
              ...data.sites,
              // Neznámá výška se dosadí až v run.ts, ať je na jednom
              // místě s tím, co se do úlohy opravdu pošle.
              rth_altitude: variant.hasRth ? data.sites.rth_altitude : null,
            }
          : null,
        detects_person: variant.hasCapabilities ? data.detects_person : null,
        detects_vehicle: variant.hasCapabilities ? data.detects_vehicle : null,
        reads_plate: variant.hasCapabilities ? data.reads_plate : null,
        zones: data.zones
          ? {
              ...data.zones,
              // Neznámá trasa se chová jako žádná: zásah neodejde
              // a v logu i na přehledu je vidět proč.
              wayline_uuid: variant.hasWayline ? data.zones.wayline_uuid : null,
            }
          : null,
      },
      error: null,
    };
  }

  return { camera: null, error: posledni || "kameru se nepodařilo dohledat" };
}

/** Schopnosti kamery pro capabilities.ts. NULL = sloupce ještě nejsou. */
export function cameraCapabilities(
  camera: Pick<IngestCameraRow, "detects_person" | "detects_vehicle" | "reads_plate">,
): CameraCapabilities {
  return {
    detectsPerson: camera.detects_person,
    detectsVehicle: camera.detects_vehicle,
    readsPlate: camera.reads_plate,
  };
}
