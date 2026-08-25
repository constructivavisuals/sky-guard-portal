// ═══════════════════════════════════════════════════════════════════
// Typy datového modelu perimetrické ochrany — 1:1 s migrací
// supabase/migrations/20260824120000_perimeter_schema.sql.
//
// Psáno ručně (schéma zatím není nasazené, takže `supabase gen types`
// nemá z čeho generovat). Po prvním deploy jde soubor přegenerovat:
//   npx supabase gen types typescript --project-id ateldjcffovdiexzmkii
//
// Pure data (bez server závislostí), aby šlo importovat v API routes
// i na klientovi.
// ═══════════════════════════════════════════════════════════════════

// ── Enumy (shodné s PG typy) ─────────────────────────────────────

export const USER_ROLES = ["admin", "operator", "viewer"] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const CAMERA_STATUSES = [
  "online",
  "offline",
  "maintenance",
  "decommissioned",
] as const;
export type CameraStatus = (typeof CAMERA_STATUSES)[number];

export const DETECTION_SOURCES = ["camera", "drone"] as const;
export type DetectionSource = (typeof DETECTION_SOURCES)[number];

export const DETECTION_OBJECT_CLASSES = ["person", "vehicle", "unknown"] as const;
export type DetectionObjectClass = (typeof DETECTION_OBJECT_CLASSES)[number];

export const DISPATCH_OUTCOMES = [
  "sent",
  "suppressed_disarmed",
  "suppressed_cooldown",
  "failed",
] as const;
export type DispatchOutcome = (typeof DISPATCH_OUTCOMES)[number];

export const FLIGHT_STATUSES = [
  "pending",
  "in_progress",
  "completed",
  "aborted",
  "failed",
] as const;
export type FlightStatus = (typeof FLIGHT_STATUSES)[number];

/**
 * Srážky hlásí dok kódem, ne mírou. Potvrzené je "no_rain", ostatní
 * hodnoty jsou z dokumentace DJI a v provozu ověřené nejsou — proto
 * formatRainfall() nezná-li kód, vypíše ho tak, jak přišel.
 */
export const RAINFALL_LEVELS = [
  "no_rain",
  "light_rain",
  "moderate_rain",
  "heavy_rain",
] as const;
export type RainfallLevel = (typeof RAINFALL_LEVELS)[number];

export const RAINFALL_LABELS: Record<RainfallLevel, string> = {
  no_rain: "Beze srážek",
  light_rain: "Slabý déšť",
  moderate_rain: "Déšť",
  heavy_rain: "Silný déšť",
};

/** Podmínky odečtené z doku při plánování letu. */
export type FlightConditions = {
  wind_speed: number | null;
  rainfall: string | null;
  environment_temperature: number | null;
  measured_at: string;
};

export const FLIGHT_KINDS = ["patrol", "dispatch"] as const;
export type FlightKind = (typeof FLIGHT_KINDS)[number];

export const MEDIA_KINDS = ["photo", "video"] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];

// České popisky pro UI

export const USER_ROLE_LABELS: Record<UserRole, string> = {
  admin: "Administrátor",
  operator: "Operátor",
  viewer: "Klient",
};

export const CAMERA_STATUS_LABELS: Record<CameraStatus, string> = {
  online: "Online",
  offline: "Offline",
  maintenance: "Údržba",
  decommissioned: "Vyřazena",
};

export const DETECTION_SOURCE_LABELS: Record<DetectionSource, string> = {
  camera: "Kamera",
  drone: "Dron",
};

export const DETECTION_OBJECT_CLASS_LABELS: Record<DetectionObjectClass, string> = {
  person: "Osoba",
  vehicle: "Vozidlo",
  unknown: "Neurčeno",
};

export const DISPATCH_OUTCOME_LABELS: Record<DispatchOutcome, string> = {
  sent: "Odesláno",
  suppressed_disarmed: "Potlačeno — mimo režim",
  suppressed_cooldown: "Potlačeno — cooldown",
  failed: "Chyba",
};

export const FLIGHT_STATUS_LABELS: Record<FlightStatus, string> = {
  pending: "Čeká",
  in_progress: "Probíhá",
  completed: "Dokončen",
  aborted: "Přerušen",
  failed: "Chyba",
};

export const FLIGHT_KIND_LABELS: Record<FlightKind, string> = {
  patrol: "Hlídka",
  dispatch: "Zásah",
};

export const MEDIA_KIND_LABELS: Record<MediaKind, string> = {
  photo: "Foto",
  video: "Video",
};

// ── Pomocné typy ─────────────────────────────────────────────────

/** JSONB sloupec — konkrétní tvar zná až volající. */
export type Json = Record<string, unknown>;

/**
 * PostGIS geography. PostgREST vrací sloupec jako hex EWKB string;
 * na GeoJSON je potřeba explicitní ST_AsGeoJSON v pohledu nebo RPC.
 */
export type Geography = string;

/** ISO dny v týdnu, 1 = pondělí … 7 = neděle. */
export type IsoWeekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;

/** Stupeň zásahu předávaný do FlightHubu. */
export type DispatchLevel = 1 | 2 | 3 | 4 | 5;

// ── Řádky tabulek ────────────────────────────────────────────────
// Timestampy jsou ISO 8601 stringy, NUMERIC sloupce vrací supabase-js
// jako number (hodnoty jsou v bezpečném rozsahu double).

export type Profile = {
  id: string;
  email: string | null;
  full_name: string | null;
  role: UserRole;
  /** Firma, za kterou klient portál používá. Migrace 20260830120000. */
  company_name: string | null;
  /**
   * Cesta k logu v bucketu `loga`, ne URL. Adresu skládá
   * `logoUrl()` v lib/logo.ts — kdyby se uložila celá, po změně
   * domény projektu by loga zmizela.
   */
  logo_path: string | null;
  created_at: string;
  updated_at: string;
};

export type Site = {
  id: string;
  name: string;
  address: string | null;
  /** Sériové číslo DJI Docku na lokalitě. */
  dock_sn: string | null;
  /** Sériové číslo dronu v docku. */
  drone_sn: string | null;
  /** Identifikátory z DJI FlightHub 2 — opaque stringy, ne validované UUID. */
  fh_project_uuid: string | null;
  fh_workflow_uuid: string | null;
  /** Perimetr lokality, geography(Polygon, 4326). */
  geofence: Geography | null;
  /**
   * IANA zóna lokality (`Europe/Prague`). armed_* se vyhodnocuje v ní,
   * ne v UTC ani v časové zóně serveru — viz isSiteArmed().
   */
  timezone: string;
  /** `HH:MM:SS` nástěnného času v `timezone`. armed_from > armed_to = okno přes půlnoc. */
  armed_from: string;
  armed_to: string;
  armed_days: IsoWeekday[];
  /** Minimální odstup mezi zásahy; kratší → outcome suppressed_cooldown. */
  cooldown_seconds: number;
  /**
   * Statický podklad areálu a jeho rohy. Migrace 20260828120000.
   * Buď je vyplněná celá čtveřice rohů, nebo žádný — hlídá CHECK.
   */
  map_image_url: string | null;
  map_nw_lat: number | null;
  map_nw_lon: number | null;
  map_se_lat: number | null;
  map_se_lon: number | null;
  created_at: string;
  updated_at: string;
};

export type Zone = {
  id: string;
  site_id: string;
  name: string;
  /** Waypoint, na který dron letí, geography(Point, 4326). */
  location: Geography | null;
  default_level: DispatchLevel;
  enabled: boolean;
  created_at: string;
  updated_at: string;
};

export type Camera = {
  id: string;
  site_id: string;
  /** Zóna, kterou kamera hlídá; null = kamera zatím nezapojená. */
  zone_id: string | null;
  name: string;
  model: string | null;
  serial_number: string | null;
  lan_ip: string | null;
  focal_mm: number | null;
  mount_description: string | null;
  /**
   * SHA-256 otisk ingest klíče kamery. Migrace 20260829120000.
   * NULL = kamera se ještě podepisuje společným INGEST_SECRET.
   * Klíč sám v databázi není, odvozuje se — viz lib/ingest/camera-key.ts.
   */
  ingest_secret_hash: string | null;
  ingest_key_version: number;
  /**
   * Kde kamera stojí a kam kouká. Migrace 20260828180000.
   * EWKB hex, rozebírá `parsePointEwkbHex`. Azimut 0 = sever, 90 = východ;
   * null znamená, že se po montáži nezměřil.
   */
  location: string | null;
  azimuth: number | null;
  /** Dosah záběru v metrech. Jen pro vykreslení, detekci neomezuje. */
  range_m: number;
  status: CameraStatus;
  last_seen_at: string | null;
  created_at: string;
  updated_at: string;
};

/**
 * Podle čeho ingest rozhodl o zásahu. Migrace 20260825120000.
 *
 * Zapisuje se při vzniku zásahu; u záznamů z doby před tou migrací je
 * null a UI si důvod rekonstruuje ze stejných pravidel — což u sebe
 * musí přiznat, protože pravidla se od té doby mohla změnit.
 */
export type DecisionReason = {
  object_class: DetectionObjectClass | null;
  base_level: number;
  level_sent: number;
  escalated: boolean;
  /** Proč se eskalovalo. null, když k eskalaci nedošlo. */
  escalation: {
    reason: "person_in_other_zone";
    window_seconds: number;
  } | null;
  /** Byla lokalita v ostrém režimu podle site_is_armed(). */
  armed: boolean;
  /** Vypnutá zóna se chová jako mimo režim. */
  zone_enabled: boolean;
  cooldown_seconds: number;
  /** null, když na lokalitě ještě žádný zásah neodešel. */
  seconds_since_last_sent: number | null;
  /** Kolik z cooldownu zbývalo. 0, když už uplynul. */
  cooldown_remaining_seconds: number | null;
  decided_at: string;
};

export type Detection = {
  id: string;
  /** Odkud detekce je — od toho se odvíjí, co je vyplněné. */
  source: DetectionSource;
  /**
   * Lokalita detekce. Migrace 20260825180000 — do té doby se odvozovala
   * přes kameru nebo přes let a jeho zásah, což znamenalo dvě větve
   * v RLS a dofiltrovávání v UI.
   */
  site_id: string;
  /** null u dronové detekce. */
  camera_id: string | null;
  zone_id: string | null;
  /** Vyplněné u dronové detekce, jinak null. */
  flight_id: string | null;
  /**
   * Kde detekce vznikla, geography(Point, 4326). Vyplněné u dronových
   * z telemetrie; u kamerových zůstává null, polohu nese zóna.
   */
  location: Geography | null;
  detected_at: string;
  /**
   * Odkud požadavek dorazil a čím byl podepsaný. Migrace 20260831120000.
   * U dronových detekcí a záznamů z doby před migrací null.
   */
  source_ip: string | null;
  ingest_key_id: string | null;
  object_class: DetectionObjectClass;
  /** 0–1, NUMERIC(5,4). */
  confidence: number | null;
  /** Klíč snímku v R2, ne veřejná URL. */
  snapshot_r2_key: string | null;
  /** Syrová odpověď detektoru (bounding boxy, model, verze). */
  raw: Json;
  created_at: string;
};

export type Dispatch = {
  id: string;
  site_id: string;
  zone_id: string;
  /** null = ruční zásah z portálu, ne reakce na detekci. */
  triggered_by_detection: string | null;
  sent_at: string;
  level_sent: DispatchLevel;
  /** Incident z FlightHubu — neprázdný právě u outcome 'sent'. */
  fh_incident_uuid: string | null;
  http_status: number | null;
  /** Celá odpověď FlightHubu včetně chybového těla. */
  response: Json;
  outcome: DispatchOutcome;
  /** Null u zásahů z doby před migrací 20260825120000. */
  decision_reason: DecisionReason | null;
  created_at: string;
};

/** Pravidelná hlídka. Migrace 20260826120000. */
export type Patrol = {
  id: string;
  site_id: string;
  name: string;
  /** Trasa ve FlightHubu; opaque string, ne validované UUID. */
  wayline_uuid: string;
  enabled: boolean;
  /** `HH:MM:SS`. window_from > window_to = okno přes půlnoc. */
  window_from: string;
  window_to: string;
  days: IsoWeekday[];
  interval_minutes: number;
  created_at: string;
  updated_at: string;
};

export type Flight = {
  id: string;
  /** Hlídka podle plánu, nebo zásah z detekce. */
  kind: FlightKind;
  /** Vyplněné u letů hlídky. */
  patrol_id: string | null;
  /**
   * Lokalita letu. Migrace 20260827180000. NULL u ručních misí mimo
   * portál, které nevisí ani na zásahu, ani na hlídce.
   */
  site_id: string | null;
  /** UUID úlohy z FlightHubu, jedinečné. */
  fh_task_uuid: string | null;
  /** null = let mimo portál (ruční mise, test z FlightHubu). */
  dispatch_id: string | null;
  started_at: string | null;
  ended_at: string | null;
  status: FlightStatus;
  /** Telemetrie trasy z FlightHubu. */
  trajectory: Json;
  distance_m: number | null;
  duration_s: number | null;
  /**
   * Odečet z doku v okamžiku plánování: wind_speed, rainfall,
   * environment_temperature. Migrace 20260827120000. Null u letů, které
   * nevznikly z hlídky, a když dok hodnoty nehlásil.
   */
  conditions: FlightConditions | null;
  created_at: string;
  updated_at: string;
};

export type Media = {
  id: string;
  flight_id: string;
  kind: MediaKind;
  /** Klíč objektu v R2, ne veřejná URL. */
  r2_key: string;
  captured_at: string | null;
  size_bytes: number | null;
  meta: Json;
  created_at: string;
};

/** Přístup uživatele na lokalitu. Migrace 20260824180000. */
export type SiteGrant = {
  id: string;
  profile_id: string;
  site_id: string;
  created_at: string;
};

export type AuditLogEntry = {
  id: string;
  actor_id: string | null;
  action: "insert" | "update" | "delete";
  entity_type: string | null;
  entity_id: string | null;
  metadata: Json;
  created_at: string;
};

// ── Insert / Update payloady ─────────────────────────────────────

type Insertable<T, Required extends keyof T> = Pick<T, Required> &
  Partial<Omit<T, Required | "id" | "created_at" | "updated_at">>;

type Updatable<T> = Partial<Omit<T, "id" | "created_at" | "updated_at">>;

export type ProfileInsert = Insertable<Profile, "id">;
export type SiteInsert = Insertable<Site, "name">;
export type ZoneInsert = Insertable<Zone, "site_id" | "name">;
export type CameraInsert = Insertable<Camera, "site_id" | "name">;
export type DetectionInsert = Insertable<Detection, "source" | "site_id">;
export type DispatchInsert = Insertable<
  Dispatch,
  "site_id" | "zone_id" | "level_sent" | "outcome"
>;
export type PatrolInsert = Insertable<Patrol, "site_id" | "name" | "wayline_uuid">;
export type FlightInsert = Insertable<Flight, "kind">;
export type MediaInsert = Insertable<Media, "flight_id" | "kind" | "r2_key">;
export type SiteGrantInsert = Insertable<SiteGrant, "profile_id" | "site_id">;
export type AuditLogInsert = Insertable<AuditLogEntry, "action">;

// ── Evidence vjezdů (migrace 20260901120000) ─────────────────────

export const PLATE_LIST_TYPES = ["allow", "deny"] as const;
export type PlateListType = (typeof PLATE_LIST_TYPES)[number];

export const PLATE_LIST_TYPE_LABELS: Record<PlateListType, string> = {
  allow: "Smí do areálu",
  deny: "Nežádoucí",
};

export type KnownPlateRow = {
  id: string;
  site_id: string;
  /** Uloženo tak, jak to člověk napsal; porovnává se přes plate_normalize(). */
  plate: string;
  label: string | null;
  list_type: PlateListType;
  note: string | null;
  created_at: string;
  updated_at: string;
};

export type VehiclePassage = {
  id: string;
  site_id: string;
  camera_id: string | null;
  /** Detekce, ze které vjezd vznikl. Přes ni vede vazba na zásah. */
  detection_id: string;
  /** null = značka nepřečtená nebo nečitelná. */
  plate: string | null;
  confidence: number | null;
  /** Cesta v bucketu `vjezdy`, ne URL. */
  image_path: string | null;
  /** Jak vjezd dopadl proti seznamu V DOBĚ VJEZDU. */
  list_match: PlateListType | null;
  known_plate_id: string | null;
  known_label: string | null;
  plate_read_at: string | null;
  passed_at: string;
  created_at: string;
};

export type KnownPlateInsert = Insertable<KnownPlateRow, "site_id" | "plate">;
/**
 * Vjezd se zakládá s PŘEDEM ZNÁMÝM id, proto tu `id` je.
 *
 * Ingest ho potřebuje dřív, než řádek vznikne: pod tímtéž id se
 * ukládá snímek do úložiště, takže cesta k němu musí být hotová
 * před zápisem.
 */
export type VehiclePassageInsert = Insertable<
  VehiclePassage,
  "site_id" | "detection_id"
> & { id?: string };

// ── Database schema pro createClient<Database>() ──────────────────

// Tvar, který očekává supabase-js (GenericTable). Relationships zůstává
// prázdné — vnořené selecty (`cameras(..., sites(...))`) si volající
// typuje sám přes `.returns<T>()` / `.maybeSingle<T>()`, protože ručně
// psané relace by se rozešly se schématem dřív než cokoli jiného.
type TableShape<Row, Insert, Update> = {
  Row: Row;
  Insert: Insert;
  Update: Update;
  Relationships: [];
};

export type Database = {
  public: {
    Tables: {
      profiles: TableShape<Profile, ProfileInsert, Updatable<Profile>>;
      sites: TableShape<Site, SiteInsert, Updatable<Site>>;
      zones: TableShape<Zone, ZoneInsert, Updatable<Zone>>;
      cameras: TableShape<Camera, CameraInsert, Updatable<Camera>>;
      detections: TableShape<Detection, DetectionInsert, Updatable<Detection>>;
      dispatches: TableShape<Dispatch, DispatchInsert, Updatable<Dispatch>>;
      flights: TableShape<Flight, FlightInsert, Updatable<Flight>>;
      patrols: TableShape<Patrol, PatrolInsert, Updatable<Patrol>>;
      media: TableShape<Media, MediaInsert, Updatable<Media>>;
      site_grants: TableShape<SiteGrant, SiteGrantInsert, Updatable<SiteGrant>>;
      known_plates: TableShape<
        KnownPlateRow,
        KnownPlateInsert,
        Updatable<KnownPlateRow>
      >;
      vehicle_passages: TableShape<
        VehiclePassage,
        VehiclePassageInsert,
        Updatable<VehiclePassage>
      >;
      // audit_log je append-only (hlídá DB trigger), proto prázdný Update.
      audit_log: TableShape<AuditLogEntry, AuditLogInsert, Record<string, never>>;
    };
    Views: Record<string, never>;
    Functions: {
      is_admin: { Args: Record<never, never>; Returns: boolean };
      is_operator: { Args: Record<never, never>; Returns: boolean };
      current_role_of_user: { Args: Record<never, never>; Returns: UserRole };
      site_is_visible: { Args: { p_site_id: string }; Returns: boolean };
      site_is_manager: { Args: { p_site_id: string }; Returns: boolean };
      camera_site_id: { Args: { p_camera_id: string }; Returns: string };
      flight_site_id: { Args: { p_flight_id: string }; Returns: string };
      flight_is_visible: { Args: { p_flight_id: string }; Returns: boolean };
      site_is_armed: {
        Args: { p_site_id: string; p_at?: string };
        Returns: boolean;
      };
      plate_normalize: { Args: { p_plate: string }; Returns: string };
      ingest_take_tokens: {
        Args: {
          p_keys: string[];
          p_capacity: number;
          p_refill_per_second: number;
          p_now?: string;
        };
        Returns: boolean;
      };
    };
    Enums: {
      user_role: UserRole;
      camera_status: CameraStatus;
      detection_object_class: DetectionObjectClass;
      detection_source: DetectionSource;
      dispatch_outcome: DispatchOutcome;
      flight_status: FlightStatus;
      flight_kind: FlightKind;
      media_kind: MediaKind;
      plate_list_type: PlateListType;
    };
  };
};

// ── Kompozitní typy pro UI ───────────────────────────────────────

export type ZoneWithCameras = Zone & {
  /** Kamery pokrývající zónu — načteno přes cameras.zone_id. */
  cameras: Pick<Camera, "id" | "name" | "status">[];
}

export type SiteWithZones = Site & {
  zones: ZoneWithCameras[];
}

export type DetectionWithContext = Detection & {
  camera: Pick<Camera, "id" | "name" | "site_id">;
  zone: Pick<Zone, "id" | "name"> | null;
}

export type DispatchWithFlight = Dispatch & {
  zone: Pick<Zone, "id" | "name">;
  flight: Flight | null;
}

// ── Pomocné funkce ───────────────────────────────────────────────

/** Zásah, který skutečně odešel do FlightHubu. */
export function isDispatchSent(
  dispatch: Pick<Dispatch, "outcome">,
): boolean {
  return dispatch.outcome === "sent";
}

/** Potlačený zásah není chyba — jen se na detekci nereagovalo. */
export function isDispatchSuppressed(
  dispatch: Pick<Dispatch, "outcome">,
): boolean {
  return (
    dispatch.outcome === "suppressed_disarmed" ||
    dispatch.outcome === "suppressed_cooldown"
  );
}

const ISO_WEEKDAY_BY_SHORT_NAME: Record<string, IsoWeekday> = {
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
  Sun: 7,
};

/**
 * Nástěnné hodiny daného okamžiku v IANA zóně — tedy včetně letního
 * času, protože posun řeší Intl podle konkrétního data, ne fixním
 * offsetem. Vyhazuje RangeError na neplatnou zónu (v DB ji hlídá
 * trigger sites_timezone_valid).
 */
function wallClockIn(
  at: Date,
  timeZone: string,
): { minutes: number; isoWeekday: IsoWeekday } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(at);

  const value = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? "";

  const isoWeekday = ISO_WEEKDAY_BY_SHORT_NAME[value("weekday")];
  if (!isoWeekday) {
    throw new RangeError(`Nečekaný den v týdnu pro zónu ${timeZone}`);
  }

  return {
    minutes: Number(value("hour")) * 60 + Number(value("minute")),
    isoWeekday,
  };
}

/**
 * Je lokalita v daný okamžik v ostrém režimu?
 *
 * Okno se vyhodnocuje v nástěnném čase lokality (site.timezone), ne
 * v UTC ani v zóně serveru — na Vercelu běží runtime v UTC, takže bez
 * převodu by se ostrý režim v CEST posunul o dvě hodiny.
 *
 * armed_from > armed_to je okno přes půlnoc; večerní část patří dnešku,
 * ranní včerejšku (pátek 18:00–06:00 zahrnuje i sobotní ráno).
 * armed_from = armed_to znamená prázdné okno, ne nepřetržitý provoz.
 *
 * Protějšek SQL funkce site_is_armed() ve stejné migraci.
 */
export function isSiteArmed(
  site: Pick<Site, "timezone" | "armed_from" | "armed_to" | "armed_days">,
  at: Date = new Date(),
): boolean {
  const toMinutes = (hhmmss: string): number => {
    const [hours, minutes] = hhmmss.split(":");
    return Number(hours) * 60 + Number(minutes);
  };

  const from = toMinutes(site.armed_from);
  const to = toMinutes(site.armed_to);
  if (from === to) return false;

  const { minutes: now, isoWeekday } = wallClockIn(at, site.timezone);
  const isoYesterday = (isoWeekday === 1 ? 7 : isoWeekday - 1) as IsoWeekday;

  if (from < to) {
    return site.armed_days.includes(isoWeekday) && now >= from && now < to;
  }

  if (now >= from) return site.armed_days.includes(isoWeekday);
  if (now < to) return site.armed_days.includes(isoYesterday);
  return false;
}

/** Uplynul od posledního zásahu cooldown lokality? */
export function isCooldownElapsed(
  site: Pick<Site, "cooldown_seconds">,
  lastDispatchAt: string | null,
  at: Date = new Date(),
): boolean {
  if (!lastDispatchAt) return true;
  const elapsed = (at.getTime() - new Date(lastDispatchAt).getTime()) / 1000;
  return elapsed >= site.cooldown_seconds;
}
