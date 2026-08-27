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

/**
 * Neznámá značka v době střežení.
 *
 * Není to totéž co nežádoucí: ta zvedne zásah sama a je vidět
 * v zásazích. Neznámá značka znamená, že do areálu v noci vjelo auto,
 * které nikdo nezná — dron už vzlétl, ale někdo se na to má podívat
 * a rozhodnout, jestli patří na seznam.
 *
 * Počítá se jen to, co se stalo za ostrého režimu; přes den auta
 * jezdí a hlásit každé z nich by z varování udělalo tapetu.
 */
export function unknownPlateWarnings(
  passages: { plate: string | null; armed: boolean }[],
): Warning[] {
  const neznama = passages.filter((p) => p.armed);
  if (neznama.length === 0) return [];

  if (neznama.length === 1) {
    const znacka = neznama[0].plate;
    return [
      {
        key: "unknown_plate",
        text: znacka
          ? `V době střežení projelo bránou vozidlo s neznámou značkou ${znacka}.`
          : "V době střežení projelo bránou vozidlo, jehož značku se nepodařilo přečíst.",
      },
    ];
  }

  return [
    {
      key: "unknown_plates",
      text: `V době střežení projelo bránou ${neznama.length} vozidel s neznámou nebo nepřečtenou značkou.`,
    },
  ];
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
export interface CameraSilence {
  name: string;
  lastSeenAt: Date | null;
  online: boolean;
}

/**
 * Které kamery mlčí. Vystavené zvlášť, aby na tomtéž pravidle stály
 * varování na přehledu i notifikace z cronu — dvě kopie podmínky by
 * se rozešly u první změny prahu.
 */
export function silentCameras<T extends CameraSilence>(
  cameras: T[],
  now: Date = new Date(),
): T[] {
  const prah = CAMERA_SILENT_MINUTES * 60_000;

  return cameras.filter((camera) => {
    if (!camera.online) return false;
    if (!camera.lastSeenAt) return false;
    const od = now.getTime() - camera.lastSeenAt.getTime();
    // Neplatné datum by dalo NaN a to projde každým porovnáním jako
    // false — radši výslovně.
    if (!Number.isFinite(od)) return false;
    return od > prah;
  });
}

export function cameraSilenceWarnings(
  cameras: CameraSilence[],
  now: Date = new Date(),
): Warning[] {
  const ticho = silentCameras(cameras, now);

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
  const jedna = cameras.withoutZone === 1;
  const count = jedna ? "Jedna kamera nemá" : `${cameras.withoutZone} kamer nemá`;

  return [
    {
      key: "cameras_without_zone",
      text: all
        ? `${count} přiřazenou zónu — na téhle lokalitě proto nevznikne žádný zásah, i když kamery detekují.`
        : `${count} přiřazenou zónu, takže z ${jedna ? "ní" : "nich"} zásah nevznikne.`,
    },
  ];
}

/**
 * Zóny, které nemají trasu.
 *
 * Zásah se od migrace 20260903180000 zakládá jako plánovaná úloha ve
 * FlightHubu a ta chce trasu, ne souřadnice. Zóna bez trasy se tedy
 * chová jako kamera bez zóny: detekce se zapíše, dron nikam neletí.
 * Bez tohohle varování se ten stav nedá odlišit od klidné noci.
 *
 * Vypnuté zóny se nepočítají — z těch by zásah nevznikl tak jako tak
 * a varovat u nich na chybějící trasu by bylo matoucí.
 */
export function zoneWarnings(zones: {
  total: number;
  withoutWayline: number;
}): Warning[] {
  if (zones.withoutWayline <= 0) return [];

  const all = zones.withoutWayline === zones.total && zones.total > 0;
  const jedna = zones.withoutWayline === 1;
  const count = jedna ? "Jedna zóna nemá" : `${zones.withoutWayline} zón nemá`;

  return [
    {
      key: "zones_without_wayline",
      text: all
        ? `${count} přiřazenou trasu — na téhle lokalitě proto nevznikne žádný zásah, i když kamery detekují.`
        : `${count} přiřazenou trasu, takže z ${jedna ? "ní" : "nich"} dron nevzlétne.`,
    },
  ];
}

/**
 * Kolik vjezdů musí kamera na bráně poslat, aby mělo smysl si stěžovat.
 *
 * Jeden nepřečtený vjezd je bláto na značce nebo protisvětlo. Tři po
 * sobě bez jediné přečtené znamenají, že čtení nefunguje.
 */
export const PLATELESS_GATE_MIN_PASSAGES = 3;

export interface GateCamera {
  id: string;
  name: string;
  readsPlate: boolean;
}

/**
 * Kamera, která má číst značky, ale žádnou neposlala.
 *
 * Kamera s reads_plate slibuje, že značku zná sama — ingest na ni
 * spoléhá a model volá jen jako záchranu. Když od ní chodí vjezdy bez
 * značky, je to buď rozbité čtení v kameře, nebo špatně nastavená
 * schopnost. Obojí vypadá v evidenci stejně jako brána, kterou nikdo
 * neprojel, a proto se to musí říct nahlas.
 *
 * Počítají se jen vjezdy BEZ značky, ne ty nejisté: nejistá značka
 * znamená, že čtení funguje a jen si není jisté — na to je varování
 * o neznámých značkách.
 */
export function platelessGateWarnings(
  cameras: readonly GateCamera[],
  passages: readonly { cameraId: string | null; hasPlate: boolean }[],
): Warning[] {
  const out: Warning[] = [];

  for (const camera of cameras) {
    if (!camera.readsPlate) continue;

    // Podle id, ne podle jména: dvě kamery se stejným názvem jsou na
    // různých lokalitách možné a tohle se počítá napříč jednou z nich.
    const jejich = passages.filter((p) => p.cameraId === camera.id);
    if (jejich.length < PLATELESS_GATE_MIN_PASSAGES) continue;
    if (jejich.some((p) => p.hasPlate)) continue;

    out.push({
      key: `gate_without_plates_${camera.id}`,
      text: `Kamera „${camera.name}“ má číst značky, ale posledních ${jejich.length} vjezdů poslala bez značky.`,
    });
  }

  return out;
}

/**
 * Práce po odpovědi, která nedoběhla.
 *
 * ═══ Co se to hlídá ════════════════════════════════════════════════
 * Zásah i čtení značky běží v `after()`, tedy až po odeslání odpovědi
 * kameře. Když Vercel instanci ukončí dřív, než to doběhne, práce se
 * ztratí — a nikde po ní nezůstane stopa: fronta ani opakování tam
 * nejsou. Detekce se zapíše, zásah nevznikne, vjezd zůstane bez značky.
 *
 * Samo o sobě to vypadá úplně stejně jako „kamera nemá zónu“ nebo
 * „značka se nepovedla přečíst“. Rozdíl je v tom, že tohle je závada
 * běhu, ne stav areálu — a bez tohohle varování se nedá poznat.
 *
 * Detekce se počítají jen ty v OSTRÉM REŽIMU: mimo něj se zásah
 * nezakládá schválně a řádek v dispatches je tam legitimně žádný.
 * Vyhodnocení ostrého režimu si dělá volající, sem chodí hotové.
 */
export interface StuckWork {
  /** Detekce v ostrém režimu bez jediného řádku v dispatches. */
  detectionsWithoutDispatch: number;
  /** Vjezdy starší než hodinu, u kterých čtení značky nikdy neproběhlo. */
  passagesWithoutRead: number;
}

/** Po jaké době se nepřečtená značka bere jako ztracená práce. */
export const PLATE_READ_STUCK_MINUTES = 60;

/**
 * Jak daleko zpět se nedokončené zpracování hledá.
 *
 * Den stačí: co je starší, stejně nikdo nedohledá.
 */
export const STUCK_WINDOW_HOURS = 24;

/**
 * Odklad, než se detekce bez zásahu začne počítat.
 *
 * Zásah se zakládá v `after()`, tedy vteřiny po odpovědi. Deset minut
 * je s rezervou dost — kratší okno by hlásilo poplach na detekci,
 * která se zrovna zpracovává.
 */
export const STUCK_GRACE_MINUTES = 10;

export function stuckWorkWarnings(work: StuckWork): Warning[] {
  const out: Warning[] = [];

  if (work.detectionsWithoutDispatch > 0) {
    const jedna = work.detectionsWithoutDispatch === 1;
    out.push({
      key: "detections_without_dispatch",
      text: jedna
        ? "Jedna detekce v ostrém režimu nemá zásah, ani potlačený. Zpracování se nejspíš nedokončilo — zkontrolujte log."
        : `${work.detectionsWithoutDispatch} detekcí v ostrém režimu nemá zásah, ani potlačený. Zpracování se nejspíš nedokončilo — zkontrolujte log.`,
    });
  }

  if (work.passagesWithoutRead > 0) {
    const jeden = work.passagesWithoutRead === 1;
    out.push({
      key: "passages_without_plate_read",
      text: jeden
        ? `Jeden vjezd čeká na přečtení značky déle než ${PLATE_READ_STUCK_MINUTES} min. Čtení buď selhalo, nebo nikdy nezačalo.`
        : `${work.passagesWithoutRead} vjezdů čeká na přečtení značky déle než ${PLATE_READ_STUCK_MINUTES} min. Čtení buď selhalo, nebo nikdy nezačalo.`,
    });
  }

  return out;
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
