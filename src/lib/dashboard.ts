import type { DockState } from "./dispatch/flighthub.ts";

// Co je na lokalitě v nepořádku.
//
// Prázdný seznam znamená, že je vše v pořádku — přehled pak nahoře
// neukazuje nic. Varování má být výjimka, ne trvalá výzdoba.

/** Nad tímhle zaplněním hrozí, že dok nebude mít kam ukládat. */
export const STORAGE_WARNING_PERCENT = 90;

/** Pod tímhle nabitím se hlídka neplánuje. */
export const BATTERY_WARNING_PERCENT = 40;

export interface Warning {
  key: string;
  text: string;
}

export interface PatrolHealth {
  name: string;
  interval_minutes: number;
  /** Kdy hlídka naposledy letěla; null, když nikdy. */
  lastFlightAt: Date | null;
  /** Od kdy se hlídka počítá, když ještě neletěla. */
  since: Date;
}

/** Varování ze stavu doku. */
export function dockWarnings(state: DockState): Warning[] {
  const out: Warning[] = [];

  if (!state.droneInDock) {
    out.push({
      key: "drone_out",
      text: "Dron není v doku, takže odsud nemůže odstartovat.",
    });
  }

  if (
    state.storageUsedPercent !== null &&
    state.storageUsedPercent > STORAGE_WARNING_PERCENT
  ) {
    const percent = Math.round(state.storageUsedPercent);
    const upload =
      state.remainUpload !== null && state.remainUpload > 0
        ? ` Ke stažení čeká ${state.remainUpload} souborů.`
        : "";
    out.push({
      key: "storage_full",
      text: `Úložiště doku je zaplněné na ${percent} %.${upload}`,
    });
  }

  if (
    state.batteryPercent !== null &&
    state.batteryPercent < BATTERY_WARNING_PERCENT
  ) {
    out.push({
      key: "battery_low",
      text: `Dron má ${Math.round(state.batteryPercent)} % baterie, hlídky se pod ${BATTERY_WARNING_PERCENT} % neplánují.`,
    });
  }

  return out;
}

/** Po téhle době ticha se kamera považuje za nehlásící. */
export const CAMERA_SILENT_MINUTES = 60;

/**
 * Kamera, která se dlouho neozvala.
 *
 * `last_seen_at` razítkuje ingest při každé přijaté detekci. Bez
 * tohohle varování se kamera s rozbitými hodinami nebo starým klíčem
 * tváří přesně jako kamera, kolem které nikdo nešel — a to je nejtišší
 * způsob, jak přijít o ostrahu.
 *
 * Kamery, které se ještě nikdy neozvaly, se nepočítají: nejsou
 * zapojené, ne rozbité. Na ty upozorňuje jiné varování, když nemají
 * zónu.
 */
export function cameraSilenceWarnings(
  cameras: { name: string; lastSeenAt: Date | null; online: boolean }[],
  now: Date = new Date(),
): Warning[] {
  const prah = CAMERA_SILENT_MINUTES * 60_000;

  const ticho = cameras.filter((camera) => {
    if (!camera.online) return false;
    if (!camera.lastSeenAt) return false;
    const od = now.getTime() - camera.lastSeenAt.getTime();
    // Neplatné datum by dalo NaN a to projde každým porovnáním jako
    // false — radši výslovně.
    if (!Number.isFinite(od)) return false;
    return od > prah;
  });

  if (ticho.length === 0) return [];

  if (ticho.length === 1) {
    return [
      {
        key: `camera_silent_${ticho[0].name}`,
        text: `Kamera „${ticho[0].name}“ se neozvala déle než ${CAMERA_SILENT_MINUTES} min, přestože je vedená jako online.`,
      },
    ];
  }

  return [
    {
      key: "cameras_silent",
      text: `${ticho.length} kamer se neozvalo déle než ${CAMERA_SILENT_MINUTES} min, přestože jsou vedené jako online: ${ticho
        .map((camera) => camera.name)
        .join(", ")}.`,
    },
  ];
}

/**
 * Kamery, které nemají zónu.
 *
 * Nejde o kosmetiku: kamera bez zóny detekuje, ale zásah z ní nikdy
 * nevznikne — runDispatch() ji odloží dřív, než se cokoli rozhodne,
 * a v dispatches po ní nezůstane řádek. Bez tohohle varování se ten
 * stav nedá odlišit od noci, kdy prostě nikdo nešel kolem.
 */
export function cameraWarnings(cameras: {
  total: number;
  withoutZone: number;
}): Warning[] {
  if (cameras.withoutZone <= 0) return [];

  const all = cameras.withoutZone === cameras.total && cameras.total > 0;
  const count =
    cameras.withoutZone === 1
      ? "Jedna kamera nemá"
      : `${cameras.withoutZone} kamer nemá`;

  return [
    {
      key: "cameras_without_zone",
      text: all
        ? `${count} přiřazenou zónu — na téhle lokalitě proto nevznikne žádný zásah, i když kamery detekují.`
        : `${count} přiřazenou zónu, takže z ní zásah nevznikne.`,
    },
  ];
}

/**
 * Hlídka, která nelétá.
 *
 * Práh je dvojnásobek intervalu — jedno vynechání může být plné
 * úložiště nebo vybitá baterie, dvě po sobě znamenají, že se něco
 * zaseklo.
 */
export function patrolWarnings(
  patrols: PatrolHealth[],
  now: Date = new Date(),
): Warning[] {
  const out: Warning[] = [];

  for (const patrol of patrols) {
    const threshold = patrol.interval_minutes * 2 * 60_000;
    const reference = patrol.lastFlightAt ?? patrol.since;
    // Neplatné datum by dalo „NaN min“. Když nevíme, od kdy počítat,
    // je správná odpověď mlčet, ne strašit nesmyslem.
    if (Number.isNaN(reference.getTime())) continue;
    if (!Number.isFinite(threshold) || threshold <= 0) continue;

    const elapsed = now.getTime() - reference.getTime();
    if (elapsed <= threshold) continue;

    const hours = Math.floor(elapsed / 3_600_000);
    const since =
      hours >= 24
        ? `${Math.floor(hours / 24)} dní`
        : hours >= 1
          ? `${hours} h`
          : `${Math.floor(elapsed / 60_000)} min`;

    out.push({
      key: `patrol_stale_${patrol.name}`,
      text: patrol.lastFlightAt
        ? `Hlídka „${patrol.name}“ neletěla ${since}, přitom má interval ${patrol.interval_minutes} min.`
        : `Hlídka „${patrol.name}“ ještě nikdy neletěla, přestože je zapnutá ${since}.`,
    });
  }

  return out;
}

/**
 * Kolik zbývá do daného okamžiku, česky.
 *
 * Záporný odstup vrací null — přehled pak čas do přepnutí neukazuje
 * místo aby tvrdil „za −3 min“.
 */
export function formatUntil(target: Date, now: Date = new Date()): string | null {
  const ms = target.getTime() - now.getTime();
  if (ms <= 0) return null;

  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `za ${minutes} min`;

  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 24) {
    return rest > 0 ? `za ${hours} h ${rest} min` : `za ${hours} h`;
  }

  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours > 0 ? `za ${days} dní ${restHours} h` : `za ${days} dní`;
}
