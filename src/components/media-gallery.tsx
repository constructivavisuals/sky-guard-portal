import { formatDateTime } from "@/lib/format.ts";
import { FLIGHT_BUCKET, MEDIA_SIGNED_URL_TTL } from "@/lib/flights/storage.ts";
import type { createClient } from "@/lib/supabase/server.ts";
import type { MediaKind } from "@/types/database.ts";

// Galerie médií z letu. Používá ji detail letu i detail zásahu.

export interface MediaRow {
  id: string;
  kind: MediaKind;
  storage_path: string;
  captured_at: string | null;
  size_bytes: number | null;
}

export interface SignedMedia {
  row: MediaRow;
  url: string | null;
}

/** Sloupce, které si volající musí od `media` vyžádat. */
export const MEDIA_COLUMNS = "id, kind, storage_path, captured_at, size_bytes";

/**
 * Podepsané adresy médií.
 *
 * Podepisuje se klientem přihlášeného uživatele, takže o přístupu
 * rozhoduje politika nad storage.objects, ne tenhle kód. Jedním
 * voláním pro celou galerii — jinak by to bylo tolik kol po síti,
 * kolik je snímků.
 */
export async function signMedia(
  supabase: Awaited<ReturnType<typeof createClient>>,
  rows: MediaRow[],
): Promise<SignedMedia[]> {
  if (rows.length === 0) return [];

  const { data } = await supabase.storage
    .from(FLIGHT_BUCKET)
    .createSignedUrls(
      rows.map((row) => row.storage_path),
      MEDIA_SIGNED_URL_TTL,
    );

  const podle = new Map<string, string>();
  for (const item of data ?? []) {
    if (item.signedUrl && item.path) podle.set(item.path, item.signedUrl);
  }

  return rows.map((row) => ({ row, url: podle.get(row.storage_path) ?? null }));
}

export function MediaGallery({
  items,
  timeZone,
  columns = 2,
  emptyText,
}: {
  items: SignedMedia[];
  timeZone: string | undefined;
  /** Kolik dlaždic vedle sebe na širokém displeji. */
  columns?: 2 | 3;
  emptyText?: string;
}) {
  if (items.length === 0) {
    return (
      <p className="mt-3 text-sm text-[var(--text-muted)]">
        {emptyText ??
          "Z letu zatím nejsou žádné snímky. Dotáhnou se při synchronizaci s FlightHubem, jakmile je dron nahraje."}
      </p>
    );
  }

  return (
    <ul
      className={`mt-4 grid grid-cols-1 gap-4 ${
        columns === 3 ? "sm:grid-cols-3" : "sm:grid-cols-2"
      }`}
    >
      {items.map(({ row, url }) => (
        <li key={row.id} className="min-w-0 border border-[var(--line)] bg-[var(--surface-2)]">
          <div className="relative aspect-video bg-black">
            {url === null ? (
              <p className="flex h-full items-center justify-center px-4 text-center text-sm text-[var(--text-muted)]">
                Soubor se nepodařilo načíst.
              </p>
            ) : row.kind === "video" ? (
              // preload="metadata": video z dronu má stovky megabajtů
              // a galerie by jinak stáhla celou při otevření stránky.
              <video
                src={url}
                controls
                preload="metadata"
                className="h-full w-full object-contain"
              />
            ) : (
              // Obyčejný <img>: adresa je podepsaná a krátkodobá, takže
              // by ji next/image cachoval pod klíčem, který za pár minut
              // přestane platit.
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={url}
                alt={
                  row.captured_at
                    ? `Snímek z letu ${formatDateTime(row.captured_at, timeZone)}`
                    : "Snímek z letu bez času pořízení"
                }
                loading="lazy"
                className="h-full w-full object-contain"
              />
            )}
          </div>
          <p className="flex items-center justify-between gap-3 border-t border-[var(--line)] px-3 py-2 text-xs text-[var(--text-muted)]">
            <span className="tabular-nums">
              {row.captured_at ? formatDateTime(row.captured_at, timeZone) : "Bez času"}
            </span>
            <span>{row.kind === "video" ? "Video" : "Foto"}</span>
          </p>
        </li>
      ))}
    </ul>
  );
}

