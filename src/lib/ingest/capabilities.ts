import { isPlateReliable, normalizePlate } from "../plates.ts";

// Co kamera umí — a co z toho plyne pro ingest.
//
// ═══ NULL znamená „nevíme“, ne „neumí“ ═════════════════════════════
// Sloupce přidává migrace 20260910120000, kterou pouští člověk ručně.
// Mezi nasazením kódu a migrací se kamera čte bez nich a schopnosti
// vyjdou jako null. V tom případě se nesmí nic tvrdit:
//
//   * neočekávaná třída se NEHLÁSÍ — jinak by po nasazení každá
//     detekce vozidla vypadala jako závada,
//   * značka z těla požadavku se NEBERE — dokud nikdo neřekl, že
//     tahle kamera značky čte, je to nedůvěryhodný vstup.
//
// Obojí je návrat k tomu, jak se portál choval předtím.
// ═══════════════════════════════════════════════════════════════════

import type { DetectionObjectClass } from "../../types/database.ts";

export interface CameraCapabilities {
  /** null = sloupce v databázi ještě nejsou. */
  detectsPerson: boolean | null;
  detectsVehicle: boolean | null;
  readsPlate: boolean | null;
}

/** Jak se kamera chová, dokud jí schopnosti nikdo nenastaví. */
export const DEFAULT_CAPABILITIES: CameraCapabilities = {
  detectsPerson: true,
  detectsVehicle: false,
  readsPlate: false,
};

/**
 * Čekáme od téhle kamery takovou detekci?
 *
 * `unknown` je vždycky očekávaná: je to třída „něco se hnulo“, kterou
 * hlásí i kamera, co nic dalšího nerozlišuje.
 */
export function classIsExpected(
  capabilities: CameraCapabilities,
  objectClass: DetectionObjectClass,
): boolean {
  if (objectClass === "person") return capabilities.detectsPerson !== false;
  if (objectClass === "vehicle") return capabilities.detectsVehicle !== false;
  return true;
}

/** Značka hlášená kamerou. */
export interface ReportedPlate {
  plate: string | null;
  confidence: number | null;
}

export type PlatePlan =
  /** Značka od kamery stačí, model se nevolá. */
  | { use: "camera"; plate: string; confidence: number }
  /** Přečíst ze snímku. `fallback` je nespolehlivá značka od kamery. */
  | { use: "model"; fallback: ReportedPlate | null }
  /** Není z čeho číst a kamera nic neposlala. */
  | { use: "none" };

/**
 * Odkud vzít značku.
 *
 * Kamera na bráně značku často zná sama — čtení modelem je pak práce
 * navíc, která stojí vteřiny a peníze a může dopadnout hůř než čidlo
 * v závoře. Model se proto volá jen tehdy, když značka chybí nebo je
 * pod prahem jistoty (týmž prahem, pod kterým se značka nepáruje se
 * seznamem — dvě různé hranice by znamenaly značku dost dobrou na
 * uložení a málo dobrou na rozhodnutí).
 *
 * Značka z těla se bere JEN od kamery s reads_plate. Bez toho by šlo
 * z libovolné ovládnuté kamery poslat vjezd s vymyšlenou allow
 * značkou a nechat se odbavit.
 */
export function planPlateRead(options: {
  capabilities: CameraCapabilities;
  reported: ReportedPlate | null;
  hasImage: boolean;
}): PlatePlan {
  const { capabilities, reported, hasImage } = options;

  const trusted = capabilities.readsPlate === true ? reported : null;

  if (trusted && isPlateReliable(trusted.plate, trusted.confidence)) {
    // isPlateReliable() ověřilo obojí; typy to samy nevědí.
    return {
      use: "camera",
      plate: trusted.plate as string,
      confidence: trusted.confidence as number,
    };
  }

  if (hasImage) return { use: "model", fallback: trusted };
  // Bez snímku je i nejistá značka od kamery pořád víc než nic —
  // uloží se s nízkou jistotou, takže se se seznamem nespáruje.
  if (trusted?.plate) return { use: "model", fallback: trusted };
  return { use: "none" };
}

/**
 * Značka z těla požadavku do porovnávacího tvaru.
 *
 * Normalizuje se toutéž funkcí jako všechno ostatní; kamera, která
 * pošle „1AB 2345“, nesmí skončit jinde než model, co přečte totéž.
 */
export function normalizeReported(
  plate: unknown,
  confidence: unknown,
): ReportedPlate | null {
  if (typeof plate !== "string") return null;
  const normalized = normalizePlate(plate);
  if (!normalized) return null;
  return {
    plate: normalized,
    confidence:
      typeof confidence === "number" && Number.isFinite(confidence)
        ? confidence
        : null,
  };
}
