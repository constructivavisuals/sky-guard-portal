import type { Metadata } from "next";
import Link from "next/link";
import { History } from "lucide-react";

import { EmptyState, PageHeader, Section } from "@/components/ui.tsx";
import { PLAYBACK_REACH_DAYS } from "@/lib/live/stream.ts";
import { getSiteSelection } from "@/lib/selected-site.ts";
import { createClient } from "@/lib/supabase/server.ts";

import { OsaCasu } from "./osa-casu.tsx";

export const metadata: Metadata = { title: "Časová osa" };

// Co kamera natočila — přehrávané PŘÍMO z její SD karty.
//
// ═══ Tohle nejsou Záznamy ══════════════════════════════════════════
// /zaznamy je seznam souborů, které leží v Hetzneru: klipy kolem
// detekcí. Těch je málo a jsou to důkazy.
//
// Tady se naopak listuje průběžný záznam, který nikam neodešel —
// kamera ho píše 24/7 na vlastní kartu a přepisuje ji dokola. Proto
// „týden zpátky“ a proto se z toho nedá nic stáhnout: obraz teče
// z kamery přes relay rovnou do prohlížeče.
//
// ═══ Jedna kamera ══════════════════════════════════════════════════
// Ze stejného důvodu jako u živého obrazu: každý otevřený proud je
// spojení na kameru, která zároveň píše na tutéž kartu. Mřížka devíti
// by položila kameru dřív než prohlížeč.

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
    if (error) throw error;
    cameras = data ?? [];
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
        title="Časová osa"
        description={
          selected
            ? `Co kamery na lokalitě ${selected.name} natočily. Záznam je na kartě v kameře, drží zhruba ${PLAYBACK_REACH_DAYS} dní.`
            : "Vyberte lokalitu v liště — záznam se prochází po jedné kameře."
        }
      />

      {failed ? (
        <EmptyState
          icon={<History className="h-5 w-5" aria-hidden="true" />}
          title="Kamery se nepodařilo načíst"
          description="Zkuste to za chvíli znovu."
        />
      ) : vybrana === null ? (
        <EmptyState
          icon={<History className="h-5 w-5" aria-hidden="true" />}
          title="Žádná kamera se záznamem"
          description={
            cameras.length > 0
              ? "Kamery tu jsou, ale nemají vyplněné sériové číslo — relay je podle něj hledá."
              : "Záznam umí stavební kamery připojené přes relay."
          }
        />
      ) : (
        <>
          {dostupne.length > 1 ? (
            <Section className="py-4 sm:py-4">
              <div
                className="flex flex-wrap gap-1"
                role="group"
                aria-label="Kamera"
              >
                {dostupne.map((row) => (
                  <Link
                    key={row.id}
                    href={`/osa?kamera=${row.id}`}
                    aria-current={row.id === vybrana.id ? "true" : undefined}
                    className={`rounded-[var(--radius-pill)] px-3 py-1 text-xs transition ${
                      row.id === vybrana.id
                        ? "bg-[var(--surface-3)] text-[var(--text)]"
                        : "text-[var(--text-muted)] hover:bg-[var(--surface-2)] hover:text-[var(--text)]"
                    }`}
                  >
                    {row.name}
                  </Link>
                ))}
              </div>
            </Section>
          ) : null}

          <OsaCasu
            // Jiná kamera je jiná karta i jiný proud.
            key={vybrana.id}
            cameraId={vybrana.id}
            cameraName={vybrana.name}
            dosahDni={PLAYBACK_REACH_DAYS}
          />
        </>
      )}
    </>
  );
}
