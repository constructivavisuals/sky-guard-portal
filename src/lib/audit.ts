// Čtení auditního deníku.
//
// Zapisuje do něj trigger audit_row() v databázi, ne aplikace — proto
// se v kódu na audit_log nikde nesahá. Je to tak schválně: trigger
// zachytí i změnu udělanou cestou, kterou nikdo nenapsal s ohledem na
// audit, kdežto volání ze server akce se dá zapomenout.
//
// Tady zbývá jen překlad do češtiny pro stránku deníku.

/** Co se stalo. Trigger ukládá lower(TG_OP). */
export const AUDIT_ACTION_LABELS: Record<string, string> = {
  insert: "Založeno",
  update: "Změněno",
  delete: "Smazáno",
};

/** Které tabulky trigger sleduje a jak se jmenují česky. */
export const AUDIT_ENTITY_LABELS: Record<string, string> = {
  profiles: "Uživatel",
  sites: "Lokalita",
  zones: "Zóna",
  cameras: "Kamera",
  dispatches: "Zásah",
  known_plates: "Známá značka",
  patrols: "Hlídka",
  carriers: "Dopravce",
};

/** Sloupce, které se v přehledu změn nevypisují — nic neřeknou. */
const NEZAJIMAVE = new Set(["id", "created_at", "updated_at", "site_id"]);

export interface AuditMetadata {
  /** U INSERT celý nový řádek. */
  new?: Record<string, unknown>;
  /** U DELETE celý smazaný řádek. */
  old?: Record<string, unknown>;
  /** U UPDATE jen změněná pole. */
  changed?: Record<string, { old: unknown; new: unknown }>;
}

/**
 * Jak entitu pojmenovat v seznamu.
 *
 * Trigger ukládá celý řádek, takže název se dá vytáhnout z něj —
 * u každé tabulky se jmenuje jinak.
 */
export function auditLabel(metadata: AuditMetadata | null): string | null {
  const row = metadata?.new ?? metadata?.old;
  if (!row) return null;

  for (const key of ["name", "plate", "email", "full_name"]) {
    const value = row[key];
    if (typeof value === "string" && value) return value;
  }
  return null;
}

/**
 * Co se u úpravy změnilo, jako čitelný seznam polí.
 *
 * Hodnoty se schválně nevypisují: v řádku bývá i geografie v hex EWKB
 * nebo pole dnů, a „location: 0101000020E6…“ nikomu nic neřekne.
 * Podstatné je, ČEHO se změna týkala.
 */
export function auditChangedFields(metadata: AuditMetadata | null): string[] {
  const changed = metadata?.changed;
  if (!changed) return [];
  return Object.keys(changed)
    .filter((key) => !NEZAJIMAVE.has(key))
    .sort();
}
