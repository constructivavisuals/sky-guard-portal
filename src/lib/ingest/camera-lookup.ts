import type { SupabaseClient } from "@supabase/supabase-js";

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
  sites: {
    id: string;
    cooldown_seconds: number;
    timezone: string;
    dock_sn: string | null;
  } | null;
  zones: {
    id: string;
    name: string;
    enabled: boolean;
    location: string | null;
    wayline_uuid: string | null;
  } | null;
}

interface Variant {
  /** Do logu, ať je poznat, která migrace chybí. */
  label: string;
  columns: string;
  hasKey: boolean;
  hasWayline: boolean;
}

function columns(hasKey: boolean, hasWayline: boolean): string {
  const klic = hasKey ? ", ingest_secret_hash, ingest_key_version" : "";
  const trasa = hasWayline ? ", wayline_uuid" : "";
  return (
    `id, site_id, zone_id, serial_number${klic}, ` +
    "sites(id, cooldown_seconds, timezone, dock_sn), " +
    `zones(id, name, enabled, location${trasa})`
  );
}

/**
 * Od nejúplnější k nejchudší. Pořadí není libovolné: klíč kamery je
 * bezpečnostní věc a trasa provozní, takže se dřív obětuje trasa.
 */
const VARIANTS: Variant[] = [
  { label: "plné", columns: columns(true, true), hasKey: true, hasWayline: true },
  {
    label: "bez zones.wayline_uuid (migrace 20260903180000)",
    columns: columns(true, false),
    hasKey: true,
    hasWayline: false,
  },
  {
    label: "bez ingest klíče (migrace 20260829120000)",
    columns: columns(false, true),
    hasKey: false,
    hasWayline: true,
  },
  {
    label: "bez ingest klíče i trasy zóny",
    columns: columns(false, false),
    hasKey: false,
    hasWayline: false,
  },
];

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
