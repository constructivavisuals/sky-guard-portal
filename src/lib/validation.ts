import {
  CAMERA_STATUSES,
  USER_ROLES,
  type CameraStatus,
  type DispatchLevel,
  type IsoWeekday,
  type UserRole,
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
  /** Obojí naráz, nebo ani jedno — půlka bodu nedává smysl. */
  latitude: number | null;
  longitude: number | null;
  azimuth: number | null;
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

  // Souřadnice jsou nepovinné — kamera může být v evidenci dřív, než
  // ji někdo zaměří. Půlka bodu ale ne: se samotnou šířkou by se
  // kamera na podkladu nedala umístit.
  const latRaw = text(data, "latitude");
  const lonRaw = text(data, "longitude");
  let latitude: number | null = null;
  let longitude: number | null = null;

  if (latRaw !== "" || lonRaw !== "") {
    const lat = parseDecimal(latRaw);
    const lon = parseDecimal(lonRaw);

    if (latRaw === "") errors.latitude = "Doplňte i zeměpisnou šířku.";
    else if (!Number.isFinite(lat)) errors.latitude = "Zadejte zeměpisnou šířku.";
    else if (lat < -90 || lat > 90) {
      errors.latitude = "Šířka musí být v rozsahu −90 až 90.";
    } else latitude = lat;

    if (lonRaw === "") errors.longitude = "Doplňte i zeměpisnou délku.";
    else if (!Number.isFinite(lon)) errors.longitude = "Zadejte zeměpisnou délku.";
    else if (lon < -180 || lon > 180) {
      errors.longitude = "Délka musí být v rozsahu −180 až 180.";
    } else longitude = lon;
  }

  const azimuthRaw = text(data, "azimuth");
  let azimuth: number | null = null;
  if (azimuthRaw !== "") {
    // Ne parseDecimal: databáze má smallint, půlstupně by se zaokrouhlily
    // potichu. Radši to odmítnout hned.
    const value = Number(azimuthRaw.replace(",", "."));
    if (!Number.isFinite(value)) errors.azimuth = "Zadejte azimut ve stupních.";
    else if (!Number.isInteger(value)) {
      errors.azimuth = "Azimut zadejte celým číslem.";
    } else if (value < 0 || value > 359) {
      errors.azimuth = "Azimut musí být v rozsahu 0 až 359.";
    } else azimuth = value;
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
      latitude,
      longitude,
      azimuth,
      status: status as CameraStatus,
    },
  };
}

// ── Klient ───────────────────────────────────────────────────────

export interface ClientFormValue {
  email: string;
  full_name: string | null;
  company_name: string | null;
  role: UserRole;
  /** Lokality, na které klient uvidí. */
  site_ids: string[];
}

/**
 * Nejkratší přijímané heslo.
 *
 * Supabase pouští od šesti znaků; deset je vědomě přísnější, protože
 * hesla tady zakládá administrátor pro někoho jiného a to svádí ke
 * krátkým „dočasným“ heslům, která pak zůstanou napořád.
 */
export const MIN_PASSWORD_LENGTH = 10;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Heslo zvlášť: zakládá se s klientem, ale mění se i samostatně. */
export function parsePassword(
  raw: string,
  field = "password",
): Validated<string> {
  if (raw === "") {
    return { ok: false, errors: { [field]: "Zadejte heslo." } };
  }
  if (raw.length < MIN_PASSWORD_LENGTH) {
    return {
      ok: false,
      errors: {
        [field]: `Heslo musí mít aspoň ${MIN_PASSWORD_LENGTH} znaků.`,
      },
    };
  }
  if (raw.length > 72) {
    // bcrypt delší heslo tiše useknе — radši ho odmítnout hned.
    return { ok: false, errors: { [field]: "Heslo je delší než 72 znaků." } };
  }
  return { ok: true, value: raw };
}

export function parseClientForm(data: FormData): Validated<ClientFormValue> {
  const errors: FieldErrors = {};

  const email = text(data, "email").toLowerCase();
  if (!email) errors.email = "Zadejte e-mail.";
  else if (!EMAIL.test(email)) errors.email = "Tohle není platný e-mail.";
  else if (email.length > 320) errors.email = "E-mail je nesmyslně dlouhý.";

  const fullName = optionalText(data, "full_name");
  if (fullName && fullName.length > 200) {
    errors.full_name = "Jméno je delší než 200 znaků.";
  }

  const company = optionalText(data, "company_name");
  if (company && company.length > 200) {
    errors.company_name = "Název firmy je delší než 200 znaků.";
  }

  const role = text(data, "role");
  if (!(USER_ROLES as readonly string[]).includes(role)) {
    errors.role = "Vyberte roli.";
  }

  // Zaškrtávátka lokalit: nezaškrtnuté se ve FormData vůbec neobjeví.
  const siteIds = data
    .getAll("site_ids")
    .filter((value): value is string => typeof value === "string");
  if (siteIds.some((id) => !UUID.test(id))) {
    errors.site_ids = "Neplatná lokalita.";
  }

  // Klient bez jediné lokality portál otevře a neuvidí nic. Není to
  // chyba — třeba se teprve zakládá — ale admin to má vědět, tak se
  // to hlásí u pole jako upozornění na straně UI, ne jako chyba tady.

  if (Object.keys(errors).length > 0) return { ok: false, errors };

  return {
    ok: true,
    value: {
      email,
      full_name: fullName,
      company_name: company,
      role: role as UserRole,
      site_ids: [...new Set(siteIds)],
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
  if (message.includes("idx_patrols_site_name")) {
    return { name: "Hlídka s tímto názvem na lokalitě už existuje." };
  }
  if (message.includes("idx_cameras_site_name")) {
    return { name: "Kamera s tímto názvem na lokalitě už existuje." };
  }
  if (message.includes("cameras_serial_number_key")) {
    return { serial_number: "Kamera s tímto sériovým číslem už existuje." };
  }
  return { _form: "Hodnota už je obsazená jiným záznamem." };
}

// ── Hlídka ───────────────────────────────────────────────────────

export interface PatrolFormValue {
  site_id: string;
  name: string;
  wayline_uuid: string;
  enabled: boolean;
  window_from: string;
  window_to: string;
  days: IsoWeekday[];
  interval_minutes: number;
}

export function parsePatrolForm(data: FormData): Validated<PatrolFormValue> {
  const errors: FieldErrors = {};

  const siteId = text(data, "site_id");
  if (!UUID.test(siteId)) errors.site_id = "Vyberte lokalitu.";

  const name = text(data, "name");
  if (!name) errors.name = "Zadejte název hlídky.";
  else if (name.length > 200) errors.name = "Název je delší než 200 znaků.";

  const wayline = text(data, "wayline_uuid");
  if (!wayline) errors.wayline_uuid = "Vyberte trasu.";

  const from = text(data, "window_from");
  const to = text(data, "window_to");
  if (!TIME.test(from)) errors.window_from = "Zadejte čas ve tvaru HH:MM.";
  if (!TIME.test(to)) errors.window_to = "Zadejte čas ve tvaru HH:MM.";
  if (!errors.window_from && !errors.window_to && from === to) {
    errors.window_to = "Začátek a konec se nesmí shodovat, okno by nikdy neplatilo.";
  }

  const days = data
    .getAll("days")
    .map((value) => Number.parseInt(String(value), 10))
    .filter((day) => Number.isInteger(day) && day >= 1 && day <= 7);
  const uniqueDays = [...new Set(days)].sort((a, b) => a - b) as IsoWeekday[];
  if (uniqueDays.length === 0) errors.days = "Vyberte alespoň jeden den.";

  const intervalRaw = text(data, "interval_minutes");
  const interval = Number.parseInt(intervalRaw, 10);
  if (intervalRaw === "" || !Number.isInteger(interval)) {
    errors.interval_minutes = "Zadejte interval v minutách.";
  } else if (interval < 1) {
    errors.interval_minutes = "Interval musí být aspoň minuta.";
  } else if (interval > 1440) {
    errors.interval_minutes = "Interval delší než den nedává smysl.";
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };

  return {
    ok: true,
    value: {
      site_id: siteId,
      name,
      wayline_uuid: wayline,
      enabled: data.get("enabled") !== null,
      window_from: from.length === 5 ? `${from}:00` : from,
      window_to: to.length === 5 ? `${to}:00` : to,
      days: uniqueDays,
      interval_minutes: interval,
    },
  };
}
