import type { Metadata } from "next";
import Link from "next/link";
import { ChevronRight, Video } from "lucide-react";

import { EmptyState, PageHeader } from "@/components/ui.tsx";
import { getSiteSelection } from "@/lib/selected-site.ts";
import {
  CAMERA_STATUS_LABELS,
  type CameraStatus,
} from "@/types/database.ts";
import { createClient } from "@/lib/supabase/server.ts";

export const metadata: Metadata = { title: "Kamery" };

// Přehled kamer — rozcestník do detailu.
//
// ═══ Proč se sem sloučily tři položky menu ═════════════════════════
// Živý obraz, časová osa a záznamy byly tři stránky, mezi kterými
// člověk skákal a musel si u toho pamatovat, o které kameře je řeč.
// Přitom je to jedna otázka: co se na té stavbě děje nebo dělo.
// Vzor je DMSS — kamera se otevře a v ní se přepínají pohledy.
//
// ═══ Kolečko ukazuje STAV KAMERY, ne kdy se naposled ozvala ════════
// Dřív se počítalo z `last_seen_at` a byla to past: ten sloupec se
// zapisuje jedině tehdy, když něco DORAZÍ — detekce, klip nebo vjezd.
// Zdravá kamera, u které půl hodiny nikdo neprošel, tedy zšedla
// a tvrdila „neozvala se“. V noci na klidné stavbě zšedly všechny.
//
// Teď se bere `cameras.status`, tedy administrativní stav: v jakém
// je kamera provozu. Totéž ukazuje seznam kamer v Areálech, takže si
// dvě místa v portálu neprotiřečí.
//
// Živost by musel hlásit relay — ten na kamerách drží spojení a ví
// to. Do portálu to zatím neposílá, a než to bude posílat, je poctivé
// tvrdit míň.
//
// ═══ Jeden sloupec, ne mřížka náhledů ══════════════════════════════
// Mřížka živých náhledů vypadá dobře a stojí devět spojení na kamery,
// které zároveň píšou na vlastní kartu. Náhled se proto načte až
// v detailu, u jedné kamery.

export const dynamic = "force-dynamic";

interface CameraRow {
  id: string;
  name: string;
  serial_number: string | null;
  status: CameraStatus;
  sites: { name: string } | null;
}

export default async function Page() {
  const { selected } = await getSiteSelection();


  let cameras: CameraRow[] = [];
  let failed = false;

  try {
    const supabase = await createClient();
    let query = supabase
      .from("cameras")
      .select("id, name, serial_number, status, sites(name)")
      .eq("ingest_mode", "ftp")
      .neq("status", "decommissioned")
      .order("name");

    if (selected) query = query.eq("site_id", selected.id);

    const { data, error } = await query.returns<CameraRow[]>();
    if (error) throw error;
    cameras = data ?? [];
  } catch {
    failed = true;
  }

  // Kamera bez sériového čísla se do výběru nedostane: relay ji nemá
  // jak pojmenovat, takže by to byl proklik do chybové hlášky.
  const dostupne = cameras.filter((row) => row.serial_number);

  return (
    <>
      <PageHeader
        title="Kamery"
        description={
          selected
            ? `Obraz, záznam a události kamer na lokalitě ${selected.name}.`
            : "Vyberte lokalitu v liště — kamery se otevírají po jedné."
        }
      />

      {failed ? (
        <EmptyState
          icon={<Video className="h-5 w-5" aria-hidden="true" />}
          title="Kamery se nepodařilo načíst"
          description="Zkuste to za chvíli znovu."
        />
      ) : dostupne.length === 0 ? (
        <EmptyState
          icon={<Video className="h-5 w-5" aria-hidden="true" />}
          title="Žádná kamera"
          description={
            cameras.length > 0
              ? "Kamery tu jsou, ale nemají vyplněné sériové číslo — relay je podle něj hledá."
              : "Obraz umí stavební kamery připojené přes relay."
          }
        />
      ) : (
        <ul className="border-t border-[var(--line)]">
          {dostupne.map((row) => (
            <li key={row.id}>
              <Link
                href={`/kamery/${row.id}`}
                className="flex items-center gap-4 border-b border-[var(--line)] px-4 py-4 transition hover:bg-[var(--surface-2)] sm:px-6"
              >
                <span
                  className={`h-2 w-2 shrink-0 rounded-full ${
                    row.status === "online"
                      ? "bg-[var(--success)] shadow-[var(--glow-success)]"
                      : row.status === "offline"
                        ? "bg-[var(--danger)]"
                        : "bg-[var(--warning)]"
                  }`}
                  aria-hidden="true"
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-[var(--text)]">
                    {row.name}
                  </span>
                  <span className="block truncate text-xs text-[var(--text-muted)]">
                    {row.sites?.name ?? "—"} · {CAMERA_STATUS_LABELS[row.status]}
                  </span>
                </span>
                <ChevronRight
                  className="h-4 w-4 shrink-0 text-[var(--text-muted)]"
                  aria-hidden="true"
                />
              </Link>
            </li>
          ))}
        </ul>
      )}

      {/*
        Klipy u detekcí jsou přístupné z každé kamery zvlášť, ale
        seznam přes všechny kamery se hodí při hledání „kdy se to
        stalo naposledy". Nechávat ho jen jako adresu bez odkazu by
        znamenalo, že o něm nikdo neví.
      */}
      {dostupne.length > 0 ? (
        <div className="px-4 py-4 sm:px-6">
          <Link
            href="/zaznamy"
            className="text-xs text-[var(--text-muted)] underline underline-offset-4 transition hover:text-[var(--text)]"
          >
            Uložené klipy přes všechny kamery
          </Link>
        </div>
      ) : null}
    </>
  );
}
