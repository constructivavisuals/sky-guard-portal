import type { Metadata } from "next";
import Link from "next/link";
import { Video } from "lucide-react";

import { EmptyState, PageHeader, Section } from "@/components/ui.tsx";
import { getSiteSelection } from "@/lib/selected-site.ts";
import { createClient } from "@/lib/supabase/server.ts";

import { Prehravac } from "../prehravac.tsx";

export const metadata: Metadata = { title: "Živý obraz" };

// Živý obraz ze stavebních kamer.
//
// ═══ Jedna kamera, ne mřížka ═══════════════════════════════════════
// Devět kamer naráz znamená devět otevřených proudů z LAN stavby přes
// jednu VPS — a hlavně devět dekodérů v prohlížeči, což položí i slušný
// notebook. Diváci jsou dva tři a dívají se, jestli na place někdo je;
// na to stačí přepínač.
//
// ═══ Vedlejší proud, a jiný na výběr není ══════════════════════════
// Hlavní proud (4K) se přes tunel rozpadá — změřeno na místě, živě
// i ze záznamu. Přepínač kvality tu proto býval a zmizel: nabízet
// „Detailní“ znamenalo nabízet rozbitý obraz. Podrobnosti u
// streamName() v src/lib/live/stream.ts.
//
// ═══ Kdo chce vidět, co bylo ═══════════════════════════════════════
// Ten jde na /osa. Záznam neleží v portálu, ale na kartě v kameře,
// a přehrává se z ní stejným přehrávačem.

export const dynamic = "force-dynamic";

interface CameraRow {
  id: string;
  name: string;
  serial_number: string | null;
  status: string;
}

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ kamera?: string }>;
}) {
  const { kamera } = await searchParams;
  const { selected } = await getSiteSelection();

  let cameras: CameraRow[] = [];
  let failed = false;

  try {
    const supabase = await createClient();
    let query = supabase
      .from("cameras")
      .select("id, name, serial_number, status")
      .eq("ingest_mode", "ftp")
      .neq("status", "decommissioned")
      .order("name");

    if (selected) query = query.eq("site_id", selected.id);

    const { data, error } = await query.returns<CameraRow[]>();
    if (error) failed = true;
    else cameras = data ?? [];
  } catch {
    failed = true;
  }

  // Kamera bez sériového čísla se do výběru nedostane: relay ji nemá
  // jak pojmenovat, takže by to byl proklik do chybové hlášky.
  const dostupne = cameras.filter((row) => row.serial_number);
  const vybrana =
    dostupne.find((row) => row.id === kamera) ?? dostupne[0] ?? null;

  return (
    <>
      <PageHeader
        title="Živý obraz"
        description={
          selected
            ? `Co kamery na lokalitě ${selected.name} vidí právě teď.`
            : "Vyberte lokalitu v liště — živý obraz se ukazuje po jedné kameře."
        }
      />

      {failed ? (
        <EmptyState
          icon={<Video className="h-5 w-5" aria-hidden="true" />}
          title="Kamery se nepodařilo načíst"
          description="Zkuste to za chvíli znovu."
        />
      ) : vybrana === null ? (
        <EmptyState
          icon={<Video className="h-5 w-5" aria-hidden="true" />}
          title="Žádná kamera k živému obrazu"
          description={
            cameras.length > 0
              ? "Kamery tu jsou, ale nemají vyplněné sériové číslo — relay je podle něj hledá."
              : "Živý obraz umí stavební kamery připojené přes relay."
          }
        />
      ) : (
        <>
          <Section className="py-4 sm:py-4">
            <div className="flex flex-wrap items-center gap-4">
              <Prepinac
                polozky={dostupne.map((row) => ({
                  key: row.id,
                  label: row.name,
                  href: `/zive?kamera=${row.id}`,
                  aktivni: row.id === vybrana.id,
                }))}
                popis="Kamera"
              />
              {/*
                Přepínač kvality tu byl a zmizel: hlavní proud (4K) se
                přes tunel rozpadá, takže „Detailní“ nabízelo rozbitý
                obraz. Měřeno na místě — viz streamName().
              */}
            </div>
          </Section>

          <Prehravac
            // Přepnutí kamery je jiný proud: bez klíče by se do
            // běžícího <video> jen vyměnil zdroj a MediaSource
            // z minulého spojení by zůstala viset.
            key={vybrana.id}
            konfiguraceUrl={`/api/kamery/${vybrana.id}/zivy`}
            cameraName={vybrana.name}
          />
        </>
      )}
    </>
  );
}

const AKTIVNI = "bg-[var(--surface-3)] text-[var(--text)]";
const KLIDNY = "text-[var(--text-muted)] hover:bg-[var(--surface-2)] hover:text-[var(--text)]";

function Prepinac({
  polozky,
  popis,
}: {
  polozky: { key: string; label: string; href: string; aktivni: boolean }[];
  popis: string;
}) {
  if (polozky.length < 2) return null;
  return (
    <div className="flex flex-wrap gap-1" role="group" aria-label={popis}>
      {polozky.map((polozka) => (
        <Link
          key={polozka.key}
          href={polozka.href}
          aria-current={polozka.aktivni ? "true" : undefined}
          className={`rounded-[var(--radius-pill)] px-3 py-1 text-xs transition ${
            polozka.aktivni ? AKTIVNI : KLIDNY
          }`}
        >
          {polozka.label}
        </Link>
      ))}
    </div>
  );
}
