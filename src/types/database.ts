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
  /**
   * Dok nebyl ve stavu, ze kterého se dá vzlétnout. Migrace
   * 20260903180000. Není to chyba: dron mimo dok, vybitá baterie
   * a plné úložiště jsou provozní stavy, na které se dá reagovat.
   */
  "suppressed_dock",
  /**
   * Vstup pro rozhodnutí se nepodařilo zjistit. Migrace 20260905120000.
   *
   * Není to totéž co potlačení: u ostatních suppressed_* portál něco
   * rozhodl, tady jen nevěděl. Splynout nesmí, protože detail zásahu
   * by pak o areálu tvrdil něco, co se nikdy nezjišťovalo.
   */
  "suppressed_unknown",
  /**
   * Vjezd byl předem ohlášený a ohlášení na něj sedělo. Migrace
   * 20260906120000.
   */
  "suppressed_announced",
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
  suppressed_dock: "Potlačeno — dok",
  suppressed_unknown: "Nevyhodnoceno",
  suppressed_announced: "Ohlášený příjezd",
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
  /**
   * Po kolika dnech se z úložiště mažou snímky a záznamy z letů.
   * Migrace 20260909120000. Řádky zůstávají — mizí jen soubory.
   */
  retention_days: number;
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
  /**
   * Waypoint zóny, geography(Point, 4326). Kreslí se z něj bod na
   * podkladu a ukazuje se v detailu zásahu. Do plánované úlohy se
   * NEPOSÍLÁ — tam vede dron trasa, viz wayline_uuid.
   */
  location: Geography | null;
  /**
   * Trasa ve FlightHubu, po které dron k zóně letí. Migrace
   * 20260903180000. NULL = zásah z téhle zóny neodejde.
   */
  wayline_uuid: string | null;
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
  /**
   * Byla lokalita v ostrém režimu podle site_is_armed()?
   *
   * NULL = nepodařilo se zjistit (migrace 20260905120000). Dřív se tu
   * v tom případě ukládalo `false` a detail zásahu pak tvrdil, že
   * areál nestřežil — což je tvrzení o areálu, ne o databázi.
   */
  armed: boolean | null;
  /** Vypnutá zóna se chová jako mimo režim. */
  zone_enabled: boolean;
  cooldown_seconds: number;
  /** null, když na lokalitě ještě žádný zásah neodešel. */
  seconds_since_last_sent: number | null;
  /** Kolik z cooldownu zbývalo. 0, když už uplynul. */
  cooldown_remaining_seconds: number | null;
  /**
   * Vstupy, které se nepodařilo zjistit. Migrace 20260905120000;
   * u starších zásahů chybí, proto volitelné.
   *
   * Rozhodnutí se podle nich chová různě: `armed` a `cooldown` zásah
   * zastaví (planý let stojí míň než zdvojený), `escalation` ne —
   * radši nižší stupeň než žádný zásah.
   */
  unknown_inputs?: ("armed" | "cooldown" | "escalation")[];
  /**
   * Ruční zásah z portálu — kdo ho poslal. Chybí u všeho, co vzniklo
   * z detekce, takže volitelné.
   *
   * actor_id může být null, když se profil nepodařilo načíst; že šlo
   * o ruční zásah, to nemění.
   */
  manual?: { actor_id: string | null };
  /**
   * Stav doku v okamžiku rozhodnutí. Migrace 20260903180000, takže
   * u starších zásahů chybí úplně — proto volitelné, ne jen nullable.
   */
  dock?: {
    ok: boolean;
    /** Strojový důvod, proč se nedalo vzlétnout. null, když šlo. */
    reason: "drone_not_in_dock" | "low_battery" | "storage_full" | "unreachable" | null;
    drone_in_dock: boolean | null;
    battery_percent: number | null;
    storage_used_percent: number | null;
  } | null;
  /**
   * Měla zóna trasu? Bez ní se plánovaná úloha nedá založit.
   * Chybí u zásahů z doby před migrací 20260903180000.
   */
  zone_has_wayline?: boolean;
  /**
   * Ohlášení, kvůli kterému se neletělo. Migrace 20260906120000.
   * Vyplněné právě u outcome 'suppressed_announced'.
   */
  announced_arrival?: {
    id: string;
    carrier_name: string | null;
    night_ok: boolean;
    /** Byla lokalita v ostrém režimu, když vjezd nastal? */
    armed: boolean;
  } | null;
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
  /** Cesta snímku detekce v úložišti, ne URL. */
  storage_path: string | null;
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
  /**
   * Incident ze staré cesty přes workflow trigger. Nové zásahy ho
   * nevyplňují — viz migrace 20260903180000.
   */
  fh_incident_uuid: string | null;
  /**
   * UUID plánované úlohy ve FlightHubu. Migrace 20260903180000.
   * Neprázdné právě u outcome 'sent'.
   */
  fh_task_uuid: string | null;
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
   * Stav úlohy doslova z FlightHubu. Migrace 20260902120000.
   * `status` výš je jeho zjednodušení — osm hodnot DJI se mapuje na
   * pět našich, takže bez tohohle sloupce by po synchronizaci nešlo
   * odlišit přerušený let od vypršelého.
   */
  fh_status: string | null;
  /** Kdy se let naposledy dotahoval z DJI. NULL = ještě nikdy. */
  synced_at: string | null;
  /**
   * Našel model na fotkách z letu člověka nebo vozidlo? Migrace
   * 20260903120000.
   *
   * NULL neznamená „nic tam není“ — to je false. NULL je nejistý
   * výsledek nebo nebylo z čeho číst, a rozliší se od „ještě jsme se
   * neptali“ podle threat_checked_at.
   */
  threat_confirmed: boolean | null;
  /** Věta pro člověka: co model na snímcích viděl. */
  threat_note: string | null;
  /** Kdy kontrola snímků proběhla. NULL = ještě neproběhla. */
  threat_checked_at: string | null;
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
  /** Cesta souboru v privátním bucketu `lety`, ne URL. */
  storage_path: string;
  /**
   * UUID souboru ve FlightHubu. Migrace 20260902120000. Na tomhle
   * stojí idempotence synchronizace — co už tu je, se nestahuje
   * podruhé. NULL u médií, která nepřišla z DJI.
   */
  fh_media_id: string | null;
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
export type MediaInsert = Insertable<Media, "flight_id" | "kind" | "storage_path">;
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
  /** Cesta snímku od brány v bucketu `vjezdy`, ne URL. */
  storage_path: string | null;
  /**
   * Ohlášení, kterému vjezd odpovídal. Migrace 20260906120000.
   * NULL = neohlášený, nebo se značka nepřečetla spolehlivě.
   */
  announced_arrival_id?: string | null;
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
      push_subscriptions: TableShape<
        PushSubscription,
        Insertable<PushSubscription, "profile_id" | "endpoint" | "p256dh" | "auth">,
        Updatable<PushSubscription>
      >;
      notification_prefs: TableShape<
        NotificationPrefs,
        Insertable<NotificationPrefs, "profile_id" | "site_id">,
        Updatable<NotificationPrefs>
      >;
      carriers: TableShape<
        Carrier,
        Insertable<Carrier, "site_id" | "name" | "token">,
        Updatable<Carrier>
      >;
      announced_arrivals: TableShape<
        AnnouncedArrival,
        Insertable<AnnouncedArrival, "carrier_id" | "site_id" | "plate" | "arrival_date">,
        Updatable<AnnouncedArrival>
      >;
      cron_runs: TableShape<
        CronRun,
        Insertable<CronRun, "name">,
        Updatable<CronRun>
      >;
      notification_log: TableShape<
        NotificationLog,
        Insertable<NotificationLog, "site_id" | "kind" | "target">,
        Updatable<NotificationLog>
      >;
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

/**
 * Potlačený zásah není chyba — jen se na detekci nereagovalo.
 *
 * Odvozeno z názvu, ne z výčtu: každý další důvod potlačení tím platí
 * automaticky. Ruční výčet by se po přidání 'suppressed_dock' rozešel
 * s pravdou přesně na těch dvou místech, kde se na něj nikdo nepodívá.
 */
export function isDispatchSuppressed(
  dispatch: Pick<Dispatch, "outcome">,
): boolean {
  return dispatch.outcome.startsWith("suppressed_");
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

// ── Notifikace ───────────────────────────────────────────────────

/** Zařízení, kterému se posílají push notifikace. Migrace 20260904120000. */
export type PushSubscription = {
  id: string;
  profile_id: string;
  /** Adresa u push služby. Unikátní — tentýž prohlížeč vrací tutéž. */
  endpoint: string;
  p256dh: string;
  auth: string;
  user_agent: string | null;
  created_at: string;
  /** Kdy na něj naposledy něco úspěšně odešlo. NULL = zatím nikdy. */
  last_used_at: string | null;
};

/** Druhy událostí, na které se dá odebírat. */
export const NOTIFICATION_KINDS = [
  "dispatch_sent",
  "dispatch_suppressed",
  "threat_confirmed",
  "camera_silent",
  "dock_problem",
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export const NOTIFICATION_KIND_LABELS: Record<NotificationKind, string> = {
  dispatch_sent: "Zásah odeslán",
  dispatch_suppressed: "Zásah potlačen",
  threat_confirmed: "Nález potvrzen",
  camera_silent: "Kamera mlčí",
  dock_problem: "Dok v nepořádku",
};

export const NOTIFICATION_KIND_HINTS: Record<NotificationKind, string> = {
  dispatch_sent: "Dron vzlétl k detekci.",
  dispatch_suppressed: "Detekce byla, ale zásah neodešel — mimo režim, cooldown nebo nepřipravený dok.",
  threat_confirmed: "Na snímcích z letu je člověk nebo vozidlo. Chodí i v tichých hodinách.",
  camera_silent: "Kamera se dlouho neozvala, přestože je vedená jako online.",
  dock_problem: "Dron mimo dok, vybitá baterie nebo plné úložiště.",
};

/** Sloupec předvoleb pro daný druh události. */
export const NOTIFICATION_KIND_COLUMNS: Record<NotificationKind, keyof NotificationPrefs> = {
  dispatch_sent: "on_dispatch_sent",
  dispatch_suppressed: "on_dispatch_suppressed",
  threat_confirmed: "on_threat_confirmed",
  camera_silent: "on_camera_silent",
  dock_problem: "on_dock_problem",
};

/**
 * Které události tiché hodiny NEUMLČÍ.
 *
 * Potvrzený nález znamená, že na pozemku někdo je. To se člověk musí
 * dozvědět i ve tři ráno — právě tehdy to platí nejvíc.
 */
export const NOTIFICATION_KINDS_IGNORING_QUIET: readonly NotificationKind[] = [
  "threat_confirmed",
];

// ── Avizované příjezdy. Migrace 20260906120000. ──────────────────

/** Dopravce s odkazem na ohlašovací stránku. */
export type Carrier = {
  id: string;
  site_id: string;
  name: string;
  contact: string | null;
  /** Tajemství v odkazu /prijezd/<token>. Vidí ho jen admin. */
  token: string;
  /** Datum, po kterém odkaz neplatí. NULL = bez omezení. */
  valid_until: string | null;
  active: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

/** Jedno ohlášení příjezdu. */
export type AnnouncedArrival = {
  id: string;
  carrier_id: string;
  site_id: string;
  /** Tak, jak ji řidič napsal. Porovnává se přes plate_normalize(). */
  plate: string;
  /** `YYYY-MM-DD` v pásmu lokality. */
  arrival_date: string;
  note: string | null;
  /** Řidič ví, že přijede i v době střežení. */
  night_ok: boolean;
  /** Zrušeno řidičem. Řádek zůstává kvůli dohledatelnosti. */
  cancelled_at: string | null;
  created_at: string;
};

/** Jeden běh cronu. Migrace 20260905120000. */
export type CronRun = {
  id: string;
  /** 'patrols', 'flights', 'warnings'. */
  name: string;
  ran_at: string;
  /** Souhrn, který endpoint vrátil. */
  result: Json;
};

/** Kdy naposledy odešlo opakující se varování. Migrace 20260904120000. */
export type NotificationLog = {
  id: string;
  site_id: string;
  kind: string;
  /** Čeho se týká: id kamery, nebo 'dock'. */
  target: string;
  last_sent_at: string;
};

/** Předvolby notifikací pro dvojici uživatel–lokalita. */
export type NotificationPrefs = {
  id: string;
  profile_id: string;
  site_id: string;
  on_dispatch_sent: boolean;
  on_dispatch_suppressed: boolean;
  on_threat_confirmed: boolean;
  on_camera_silent: boolean;
  on_dock_problem: boolean;
  /** `HH:MM:SS` v pásmu lokality. quiet_from > quiet_to = přes půlnoc. */
  quiet_from: string | null;
  quiet_to: string | null;
  created_at: string;
  updated_at: string;
};

/**
 * Výchozí předvolby pro uživatele, který si je ještě nenastavil.
 *
 * Musí sedět s DEFAULT hodnotami v migraci 20260904120000. Kdo si
 * notifikace povolil, chce je dostávat — proto zapnuto u všeho kromě
 * potlačených zásahů, kterých je v běžném provozu nejvíc.
 */
export const DEFAULT_NOTIFICATION_PREFS: Pick<
  NotificationPrefs,
  | "on_dispatch_sent"
  | "on_dispatch_suppressed"
  | "on_threat_confirmed"
  | "on_camera_silent"
  | "on_dock_problem"
  | "quiet_from"
  | "quiet_to"
> = {
  on_dispatch_sent: true,
  on_dispatch_suppressed: false,
  on_threat_confirmed: true,
  on_camera_silent: true,
  on_dock_problem: true,
  quiet_from: null,
  quiet_to: null,
};

/**
 * Je `at` uvnitř tichých hodin?
 *
 * Stejná úmluva jako u okna střežení: from > to znamená okno přes
 * půlnoc. Prázdné nebo nenastavené okno neumlčí nic.
 */
export function isQuietHour(
  prefs: Pick<NotificationPrefs, "quiet_from" | "quiet_to">,
  timezone: string,
  at: Date = new Date(),
): boolean {
  if (!prefs.quiet_from || !prefs.quiet_to) return false;

  const toMinutes = (hhmmss: string): number => {
    const [hours, minutes] = hhmmss.split(":");
    return Number(hours) * 60 + Number(minutes);
  };

  const from = toMinutes(prefs.quiet_from);
  const to = toMinutes(prefs.quiet_to);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return false;
  if (from === to) return false;

  const { minutes: now } = wallClockIn(at, timezone);

  // Na rozdíl od střežení se tu neřeší dny v týdnu: ticho platí každý
  // den. Kdo chce ticho jen o víkendu, vypne si druh události.
  return from < to ? now >= from && now < to : now >= from || now < to;
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
