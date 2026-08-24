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

export const MEDIA_KINDS = ["photo", "video"] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];

// České popisky pro UI

export const USER_ROLE_LABELS: Record<UserRole, string> = {
  admin: "Správce",
  operator: "Operátor",
  viewer: "Prohlížení",
};

export const CAMERA_STATUS_LABELS: Record<CameraStatus, string> = {
  online: "Online",
  offline: "Offline",
  maintenance: "Údržba",
  decommissioned: "Vyřazena",
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

export interface Profile {
  id: string;
  email: string | null;
  full_name: string | null;
  role: UserRole;
  created_at: string;
  updated_at: string;
}

export interface Site {
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
  /** `HH:MM:SS`. armed_from > armed_to = okno přes půlnoc. */
  armed_from: string;
  armed_to: string;
  armed_days: IsoWeekday[];
  /** Minimální odstup mezi výjezdy; kratší → outcome suppressed_cooldown. */
  cooldown_seconds: number;
  created_at: string;
  updated_at: string;
}

export interface Zone {
  id: string;
  site_id: string;
  name: string;
  /** Waypoint, na který dron letí, geography(Point, 4326). */
  location: Geography | null;
  /** Kamera pokrývající zónu (protějšek Camera.zone_id). */
  camera_id: string | null;
  default_level: DispatchLevel;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export interface Camera {
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
  status: CameraStatus;
  last_seen_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface Detection {
  id: string;
  camera_id: string;
  zone_id: string | null;
  detected_at: string;
  object_class: DetectionObjectClass;
  /** 0–1, NUMERIC(5,4). */
  confidence: number | null;
  /** Klíč snímku v R2, ne veřejná URL. */
  snapshot_r2_key: string | null;
  /** Syrová odpověď detektoru (bounding boxy, model, verze). */
  raw: Json;
  created_at: string;
}

export interface Dispatch {
  id: string;
  site_id: string;
  zone_id: string;
  /** null = ruční výjezd z portálu, ne reakce na detekci. */
  triggered_by_detection: string | null;
  sent_at: string;
  level_sent: DispatchLevel;
  /** Incident z FlightHubu — neprázdný právě u outcome 'sent'. */
  fh_incident_uuid: string | null;
  http_status: number | null;
  /** Celá odpověď FlightHubu včetně chybového těla. */
  response: Json;
  outcome: DispatchOutcome;
  created_at: string;
}

export interface Flight {
  id: string;
  /** null = let mimo portál (ruční mise, test z FlightHubu). */
  dispatch_id: string | null;
  fh_task_id: string | null;
  started_at: string | null;
  ended_at: string | null;
  status: FlightStatus;
  /** Telemetrie trasy z FlightHubu. */
  trajectory: Json;
  distance_m: number | null;
  duration_s: number | null;
  created_at: string;
  updated_at: string;
}

export interface Media {
  id: string;
  flight_id: string;
  kind: MediaKind;
  /** Klíč objektu v R2, ne veřejná URL. */
  r2_key: string;
  captured_at: string | null;
  size_bytes: number | null;
  meta: Json;
  created_at: string;
}

export interface AuditLogEntry {
  id: string;
  actor_id: string | null;
  action: "insert" | "update" | "delete";
  entity_type: string | null;
  entity_id: string | null;
  metadata: Json;
  created_at: string;
}

// ── Insert / Update payloady ─────────────────────────────────────

type Insertable<T, Required extends keyof T> = Pick<T, Required> &
  Partial<Omit<T, Required | "id" | "created_at" | "updated_at">>;

type Updatable<T> = Partial<Omit<T, "id" | "created_at" | "updated_at">>;

export type ProfileInsert = Insertable<Profile, "id">;
export type SiteInsert = Insertable<Site, "name">;
export type ZoneInsert = Insertable<Zone, "site_id" | "name">;
export type CameraInsert = Insertable<Camera, "site_id" | "name">;
export type DetectionInsert = Insertable<Detection, "camera_id">;
export type DispatchInsert = Insertable<
  Dispatch,
  "site_id" | "zone_id" | "level_sent" | "outcome"
>;
export type FlightInsert = Insertable<Flight, never>;
export type MediaInsert = Insertable<Media, "flight_id" | "kind" | "r2_key">;
export type AuditLogInsert = Insertable<AuditLogEntry, "action">;

// ── Database schema pro createClient<Database>() ──────────────────

interface TableShape<Row, Insert, Update> {
  Row: Row;
  Insert: Insert;
  Update: Update;
}

export interface Database {
  public: {
    Tables: {
      profiles: TableShape<Profile, ProfileInsert, Updatable<Profile>>;
      sites: TableShape<Site, SiteInsert, Updatable<Site>>;
      zones: TableShape<Zone, ZoneInsert, Updatable<Zone>>;
      cameras: TableShape<Camera, CameraInsert, Updatable<Camera>>;
      detections: TableShape<Detection, DetectionInsert, Updatable<Detection>>;
      dispatches: TableShape<Dispatch, DispatchInsert, Updatable<Dispatch>>;
      flights: TableShape<Flight, FlightInsert, Updatable<Flight>>;
      media: TableShape<Media, MediaInsert, Updatable<Media>>;
      audit_log: TableShape<AuditLogEntry, AuditLogInsert, never>;
    };
    Views: Record<never, never>;
    Functions: {
      is_admin: { Args: Record<never, never>; Returns: boolean };
      is_operator: { Args: Record<never, never>; Returns: boolean };
      current_role_of_user: { Args: Record<never, never>; Returns: UserRole };
      site_is_visible: { Args: { p_site_id: string }; Returns: boolean };
      site_is_manager: { Args: { p_site_id: string }; Returns: boolean };
      camera_site_id: { Args: { p_camera_id: string }; Returns: string };
      flight_site_id: { Args: { p_flight_id: string }; Returns: string };
      flight_is_visible: { Args: { p_flight_id: string }; Returns: boolean };
    };
    Enums: {
      user_role: UserRole;
      camera_status: CameraStatus;
      detection_object_class: DetectionObjectClass;
      dispatch_outcome: DispatchOutcome;
      flight_status: FlightStatus;
      media_kind: MediaKind;
    };
  };
}

// ── Kompozitní typy pro UI ───────────────────────────────────────

export interface ZoneWithCamera extends Zone {
  camera: Pick<Camera, "id" | "name" | "status"> | null;
}

export interface SiteWithZones extends Site {
  zones: ZoneWithCamera[];
}

export interface DetectionWithContext extends Detection {
  camera: Pick<Camera, "id" | "name" | "site_id">;
  zone: Pick<Zone, "id" | "name"> | null;
}

export interface DispatchWithFlight extends Dispatch {
  zone: Pick<Zone, "id" | "name">;
  flight: Flight | null;
}

// ── Pomocné funkce ───────────────────────────────────────────────

/** Výjezd, který skutečně odešel do FlightHubu. */
export function isDispatchSent(
  dispatch: Pick<Dispatch, "outcome">,
): boolean {
  return dispatch.outcome === "sent";
}

/** Potlačený výjezd není chyba — jen se na detekci nereagovalo. */
export function isDispatchSuppressed(
  dispatch: Pick<Dispatch, "outcome">,
): boolean {
  return (
    dispatch.outcome === "suppressed_disarmed" ||
    dispatch.outcome === "suppressed_cooldown"
  );
}

/**
 * Je lokalita v daný okamžik v ostrém režimu?
 * Okno armed_from > armed_to jde přes půlnoc — den v týdnu se pak bere
 * podle času vzniku okna, tedy ranní část patří k předchozímu dni.
 *
 * Počítá v lokálním čase předaného Date; volající si musí pohlídat,
 * že jde o čas v časové zóně lokality (Europe/Prague).
 */
export function isSiteArmed(
  site: Pick<Site, "armed_from" | "armed_to" | "armed_days">,
  at: Date = new Date(),
): boolean {
  const minutes = (hhmmss: string): number => {
    const [h, m] = hhmmss.split(":");
    return Number(h) * 60 + Number(m);
  };

  const now = at.getHours() * 60 + at.getMinutes();
  const from = minutes(site.armed_from);
  const to = minutes(site.armed_to);
  // getDay(): 0 = neděle → ISO 7
  const isoToday = (at.getDay() === 0 ? 7 : at.getDay()) as IsoWeekday;
  const isoYesterday = ((isoToday === 1 ? 7 : isoToday - 1) as IsoWeekday);

  if (from === to) return false;

  if (from < to) {
    return site.armed_days.includes(isoToday) && now >= from && now < to;
  }

  // Okno přes půlnoc: večerní část patří dnešku, ranní včerejšku.
  if (now >= from) return site.armed_days.includes(isoToday);
  if (now < to) return site.armed_days.includes(isoYesterday);
  return false;
}

/** Uplynul od posledního výjezdu cooldown lokality? */
export function isCooldownElapsed(
  site: Pick<Site, "cooldown_seconds">,
  lastDispatchAt: string | null,
  at: Date = new Date(),
): boolean {
  if (!lastDispatchAt) return true;
  const elapsed = (at.getTime() - new Date(lastDispatchAt).getTime()) / 1000;
  return elapsed >= site.cooldown_seconds;
}
