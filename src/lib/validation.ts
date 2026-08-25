import {
  CAMERA_STATUSES,
  type CameraStatus,
  type DispatchLevel,
  type IsoWeekday,
} from "../types/database.ts";

// Validace formulářů. Čisté funkce nad FormData, aby šly testovat bez
// serveru i bez databáze. Chybové hlášky jsou české a klíčované názvem
// pole, takže je formulář umí vypsat rovnou k němu.
//
// Tohle není bezpečnostní vrstva. Zápis stejně projde jen adminovi,
// protože zápisové politiky v databázi stojí na is_admin(); validace
// jen zachytí překlepy dřív, než z nich vznikne nesrozumitelná chyba
// z Postgresu.

export type FieldErrors = Record<string, string>;

export type Validated<T> =
  | { ok: true; value: T }
  | { ok: false; errors: FieldErrors };

function text(data: FormData, field: string): string {
  const value = data.get(field);
  return typeof value === "string" ? value.trim() : "";
}

/** Prázdný řetězec se ukládá jako NULL, ne jako "". */
function optionalText(data: FormData, field: string): string | null {
  const value = text(data, field);
  return value === "" ? null : value;
}

/** Ověří IANA zónu tím, že ji zkusí použít — bez seznamu k udržování. */
export function isValidTimeZone(value: string): boolean {
  if (!value) return false;
  try {
    new Intl.DateTimeFormat("cs-CZ", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** `HH:MM` nebo `HH:MM:SS`. */
const TIME = /^([01]\d|2[0-3]):([0-5]\d)(:[0-5]\d)?$/;

// ── Lokalita ─────────────────────────────────────────────────────

export interface SiteFormValue {
  name: string;
  address: string | null;
  timezone: string;
  armed_from: string;
  armed_to: string;
  armed_days: IsoWeekday[];
  cooldown_seconds: number;
  dock_sn: string | null;
  drone_sn: string | null;
  fh_project_uuid: string | null;
  fh_workflow_uuid: string | null;
}

export function parseSiteForm(data: FormData): Validated<SiteFormValue> {
  const errors: FieldErrors = {};

  const name = text(data, "name");
  if (!name) errors.name = "Zadejte název lokality.";
  else if (name.length > 200) errors.name = "Název je delší než 200 znaků.";

  const timezone = text(data, "timezone");
  if (!timezone) errors.timezone = "Vyberte časové pásmo.";
  else if (!isValidTimeZone(timezone)) errors.timezone = "Neznámé časové pásmo.";

  const armedFrom = text(data, "armed_from");
  const armedTo = text(data, "armed_to");
  if (!TIME.test(armedFrom)) errors.armed_from = "Zadejte čas ve tvaru HH:MM.";
  if (!TIME.test(armedTo)) errors.armed_to = "Zadejte čas ve tvaru HH:MM.";
  // Stejný začátek i konec by znamenal okno, které nikdy neplatí —
  // skoro jistě překlep, ne záměr.
  if (!errors.armed_from && !errors.armed_to && armedFrom === armedTo) {
    errors.armed_to = "Začátek a konec se nesmí shodovat, okno by nikdy neplatilo.";
  }

  const days = data
    .getAll("armed_days")
    .map((value) => Number.parseInt(String(value), 10))
    .filter((day) => Number.isInteger(day) && day >= 1 && day <= 7);
  const armedDays = [...new Set(days)].sort((a, b) => a - b) as IsoWeekday[];
  if (armedDays.length === 0) errors.armed_days = "Vyberte alespoň jeden den.";

  const cooldownRaw = text(data, "cooldown_seconds");
  const cooldown = Number.parseInt(cooldownRaw, 10);
  if (cooldownRaw === "" || !Number.isInteger(cooldown)) {
    errors.cooldown_seconds = "Zadejte počet sekund.";
  } else if (cooldown < 0) {
    errors.cooldown_seconds = "Cooldown nemůže být záporný.";
  } else if (cooldown > 86_400) {
    errors.cooldown_seconds = "Cooldown delší než 24 hodin nedává smysl.";
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };

  return {
    ok: true,
    value: {
      name,
      address: optionalText(data, "address"),
      timezone,
      // Databáze má sloupec TIME; sekundy doplníme, ať je tvar jednotný.
      armed_from: armedFrom.length === 5 ? `${armedFrom}:00` : armedFrom,
      armed_to: armedTo.length === 5 ? `${armedTo}:00` : armedTo,
      armed_days: armedDays,
      cooldown_seconds: cooldown,
      dock_sn: optionalText(data, "dock_sn"),
      drone_sn: optionalText(data, "drone_sn"),
      fh_project_uuid: optionalText(data, "fh_project_uuid"),
      fh_workflow_uuid: optionalText(data, "fh_workflow_uuid"),
    },
  };
}

// ── Zóna ─────────────────────────────────────────────────────────

export interface ZoneFormValue {
  site_id: string;
  name: string;
  latitude: number;
  longitude: number;
  default_level: DispatchLevel;
  enabled: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Přijme i desetinnou čárku — na české klávesnici je po ruce dřív. */
function parseDecimal(raw: string): number {
  return Number.parseFloat(raw.replace(",", "."));
}

export function parseZoneForm(data: FormData): Validated<ZoneFormValue> {
  const errors: FieldErrors = {};

  const siteId = text(data, "site_id");
  if (!UUID.test(siteId)) errors.site_id = "Vyberte lokalitu.";

  const name = text(data, "name");
  if (!name) errors.name = "Zadejte název zóny.";
  else if (name.length > 200) errors.name = "Název je delší než 200 znaků.";

  const latRaw = text(data, "latitude");
  const lonRaw = text(data, "longitude");
  const latitude = parseDecimal(latRaw);
  const longitude = parseDecimal(lonRaw);

  if (latRaw === "" || !Number.isFinite(latitude)) {
    errors.latitude = "Zadejte zeměpisnou šířku.";
  } else if (latitude < -90 || latitude > 90) {
    errors.latitude = "Šířka musí být v rozsahu −90 až 90.";
  }

  if (lonRaw === "" || !Number.isFinite(longitude)) {
    errors.longitude = "Zadejte zeměpisnou délku.";
  } else if (longitude < -180 || longitude > 180) {
    errors.longitude = "Délka musí být v rozsahu −180 až 180.";
  }

  const level = Number.parseInt(text(data, "default_level"), 10);
  if (!Number.isInteger(level) || level < 1 || level > 5) {
    errors.default_level = "Úroveň musí být 1 až 5.";
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };

  return {
    ok: true,
    value: {
      site_id: siteId,
      name,
      latitude,
      longitude,
      default_level: level as DispatchLevel,
      // Nezaškrtnutý checkbox se v FormData vůbec neobjeví.
      enabled: data.get("enabled") !== null,
    },
  };
}

// ── Kamera ───────────────────────────────────────────────────────

export interface CameraFormValue {
  site_id: string;
  zone_id: string | null;
  name: string;
  model: string | null;
  serial_number: string | null;
  focal_mm: number | null;
  status: CameraStatus;
}

export function parseCameraForm(data: FormData): Validated<CameraFormValue> {
  const errors: FieldErrors = {};

  const siteId = text(data, "site_id");
  if (!UUID.test(siteId)) errors.site_id = "Vyberte lokalitu.";

  const zoneRaw = text(data, "zone_id");
  if (zoneRaw !== "" && !UUID.test(zoneRaw)) errors.zone_id = "Neplatná zóna.";

  const name = text(data, "name");
  if (!name) errors.name = "Zadejte název kamery.";
  else if (name.length > 200) errors.name = "Název je delší než 200 znaků.";

  const focalRaw = text(data, "focal_mm");
  let focal: number | null = null;
  if (focalRaw !== "") {
    focal = parseDecimal(focalRaw);
    if (!Number.isFinite(focal)) errors.focal_mm = "Zadejte ohnisko v mm.";
    else if (focal <= 0) errors.focal_mm = "Ohnisko musí být kladné.";
    else if (focal > 9999) errors.focal_mm = "Ohnisko je nesmyslně velké.";
  }

  const status = text(data, "status");
  if (!(CAMERA_STATUSES as readonly string[]).includes(status)) {
    errors.status = "Vyberte stav kamery.";
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };

  return {
    ok: true,
    value: {
      site_id: siteId,
      zone_id: zoneRaw === "" ? null : zoneRaw,
      name,
      model: optionalText(data, "model"),
      serial_number: optionalText(data, "serial_number"),
      focal_mm: focal,
      status: status as CameraStatus,
    },
  };
}

// ── Chyby z databáze → chyby u polí ──────────────────────────────

/**
 * Překlad porušených omezení na hlášku u konkrétního pole.
 *
 * Unikátnost hlídá databáze, ne validace — mezi kontrolou a zápisem by
 * stejně mohl proklouznout někdo jiný. Uživateli ale nemá vypadnout
 * hláška z Postgresu.
 */
export function databaseErrorToFieldErrors(
  message: string,
  code?: string,
): FieldErrors {
  if (code !== "23505") {
    return { _form: "Uložení se nezdařilo. Zkuste to prosím znovu." };
  }

  if (message.includes("idx_sites_dock_sn")) {
    return { dock_sn: "Tento dock už je přiřazený jiné lokalitě." };
  }
  if (message.includes("idx_sites_name")) {
    return { name: "Lokalita s tímto názvem už existuje." };
  }
  if (message.includes("idx_zones_site_name")) {
    return { name: "Zóna s tímto názvem na lokalitě už existuje." };
  }
  if (message.includes("idx_cameras_site_name")) {
    return { name: "Kamera s tímto názvem na lokalitě už existuje." };
  }
  if (message.includes("cameras_serial_number_key")) {
    return { serial_number: "Kamera s tímto sériovým číslem už existuje." };
  }
  return { _form: "Hodnota už je obsazená jiným záznamem." };
}
