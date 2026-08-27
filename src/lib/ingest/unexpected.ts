import type { DetectionObjectClass, Json } from "../../types/database.ts";
import {
  classIsExpected,
  type CameraCapabilities,
} from "./capabilities.ts";

// Detekce třídy, kterou kamera neumí.
//
// ═══ Zapsat, ne zahodit ════════════════════════════════════════════
// Nabízelo by se takovou detekci odmítnout — kamera přece „lže“. Jenže
// důvody bývají prozaické: někdo vyměnil model, přidal do detektoru
// třídu a v portálu to nikdo nepřepnul. Zahodit kvůli tomu detekci
// znamená přijít o záznam, že někdo byl v areálu, a to je vždycky
// horší než mít v evidenci řádek navíc.
//
// Rozhodnutí o zásahu se taky nemění: kdyby neočekávaná třída zásah
// potlačila, vzniklo by tiché selhání přesně toho druhu, který
// v tomhle portálu opravujeme dokola. Událost se proto jen označí —
// v logu a v samotném řádku, aby po ní zbyla stopa i za měsíc.
// ═══════════════════════════════════════════════════════════════════

/** Klíč v `raw`, pod kterým si portál píše vlastní poznámky. */
export const PORTAL_RAW_KEY = "portal";

export interface UnexpectedNote {
  /** Co kamera poslala, přestože to podle nastavení neumí. */
  unexpected_class: DetectionObjectClass;
  /** Jak byla kamera v tu chvíli nastavená. */
  camera_can: { person: boolean | null; vehicle: boolean | null };
}

/**
 * Přidá poznámku do `raw`, když kamera hlásí, co neumí.
 *
 * Vrací raw beze změny, když je všechno v pořádku nebo když se
 * schopnosti nepodařilo zjistit (chybí migrace) — viz capabilities.ts.
 * `portal` je vyhrazený klíč; případný stejnojmenný obsah od kamery se
 * přepíše, protože jde o jmenný prostor portálu.
 */
export function markUnexpectedClass(options: {
  raw: Json;
  capabilities: CameraCapabilities;
  objectClass: DetectionObjectClass;
}): { raw: Json; note: UnexpectedNote | null } {
  const { raw, capabilities, objectClass } = options;

  if (classIsExpected(capabilities, objectClass)) return { raw, note: null };

  const note: UnexpectedNote = {
    unexpected_class: objectClass,
    camera_can: {
      person: capabilities.detectsPerson,
      vehicle: capabilities.detectsVehicle,
    },
  };

  const base =
    typeof raw === "object" && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, Json>)
      : // Pole ani skalár se rozšířit nedá; poznámka je důležitější než
        // původní tvar, tak se zabalí vedle.
        ({ camera_raw: raw } as Record<string, Json>);

  return {
    raw: { ...base, [PORTAL_RAW_KEY]: note as unknown as Json },
    note,
  };
}

/** Přečte poznámku z uloženého `raw`. Pro detail detekce. */
export function unexpectedNote(raw: unknown): UnexpectedNote | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const portal = (raw as Record<string, unknown>)[PORTAL_RAW_KEY];
  if (typeof portal !== "object" || portal === null) return null;
  const value = (portal as Record<string, unknown>).unexpected_class;
  if (value !== "person" && value !== "vehicle" && value !== "unknown") return null;

  const can = (portal as Record<string, unknown>).camera_can;
  const canObj =
    typeof can === "object" && can !== null ? (can as Record<string, unknown>) : {};

  const bool = (input: unknown): boolean | null =>
    typeof input === "boolean" ? input : null;

  return {
    unexpected_class: value,
    camera_can: { person: bool(canObj.person), vehicle: bool(canObj.vehicle) },
  };
}
