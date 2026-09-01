import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { PLAYBACK_REACH_DAYS } from "@/lib/live/stream.ts";
import { createClient } from "@/lib/supabase/server.ts";

import { KameraDetail, type UdalostRow } from "./kamera-detail.tsx";

export const metadata: Metadata = { title: "Kamera" };

// Jedna kamera: obraz, záznam a události na jednom místě.
//
// Data pro všechny tři záložky se načtou NAJEDNOU a předají klientovi.
// Přepnutí záložky pak nesahá na server a obraz nad ní se nepřeruší —
// což je celý důvod, proč to je jedna stránka a ne tři.

export const dynamic = "force-dynamic";

interface CameraRow {
  id: string;
  name: string;
  serial_number: string | null;
  sites: { name: string } | null;
}

interface DetectionRow {
  id: string;
  detected_at: string;
  object_class: string;
  confidence: number | null;
}

/** Kolik událostí se ukazuje. Víc se na telefonu stejně neprohledá. */
const LIMIT_UDALOSTI = 60;

/**
 * Jak daleko zpátky hledat klipy k událostem.
 *
 * Odpovídá lhůtě záznamů (`sites.clip_retention_days`). Starší klip
 * v úložišti není, takže se na něj nemá cenu ptát.
 */
const LHUTA_DNI = 14;

export default async function Page({ params }: PageProps<"/kamery/[id]">) {
  const { id } = await params;
  const supabase = await createClient();

  // Jednou pro celý průchod. Serverová komponenta se vykreslí jednou
  // za požadavek, takže je „teď" legitimní údaj — pravidlo proti
  // nečistým voláním míří na opakované renderování v prohlížeči.
  // eslint-disable-next-line react-hooks/purity
  const ted = Date.now();

  // ═══ Všechny tři dotazy najednou ═══════════════════════════════
  // Dřív se čekalo na kameru a teprve pak se šlo pro detekce a klipy.
  // Byla to dvě kola po síti za sebou, ačkoli druhé dvě potřebují jen
  // `id` z adresy — to je k dispozici hned. Na mobilní síti je jedno
  // ušetřené kolo znát víc než cokoli v prohlížeči.
  //
  // Pod RLS: kdo na lokalitu nevidí, dostane prázdno a z něj 404 —
  // stejnou odpověď jako na kameru, která neexistuje. Že se přitom
  // zbytečně zeptáme i na detekce, nevadí: RLS je zamítne stejně.
  const [{ data: camera }, { data: detekce }, { data: zaznamy }] = await Promise.all([
    supabase
      .from("cameras")
      .select("id, name, serial_number, sites(name)")
      .eq("id", id)
      .maybeSingle<CameraRow>(),
    supabase
      .from("detections")
      .select("id, detected_at, object_class, confidence")
      .eq("camera_id", id)
      .order("detected_at", { ascending: false })
      .limit(LIMIT_UDALOSTI)
      .returns<DetectionRow[]>(),
    // Klipy u detekcí. Neváže se to na sebe cizím klíčem, takže se
    // páruje časem — klip začíná dřív než detekce (pre-roll), proto
    // se hledá překryv, ne shoda.
    //
    // Omezené na lhůtu záznamů: starší klip nemůže patřit k detekci,
    // kterou ukazujeme, protože ta je nejvýš stejně stará. Bez toho
    // se táhlo dvojnásobek řádků jen proto, aby se skoro všechny
    // zahodily.
    supabase
      .from("camera_recordings")
      .select("started_at, ended_at")
      .eq("camera_id", id)
      .gte("started_at", new Date(ted - LHUTA_DNI * 86_400_000).toISOString())
      .not("storage_path", "is", null)
      .is("video_expired_at", null)
      .order("started_at", { ascending: false })
      .limit(LIMIT_UDALOSTI)
      .returns<{ started_at: string; ended_at: string }[]>(),
  ]);

  if (!camera) notFound();

  const useky = (zaznamy ?? []).map((z) => ({
    od: Date.parse(z.started_at),
    do: Date.parse(z.ended_at),
  }));

  const udalosti: UdalostRow[] = (detekce ?? []).map((d) => {
    const kdy = Date.parse(d.detected_at);
    return {
      id: d.id,
      detected_at: d.detected_at,
      object_class: d.object_class,
      confidence: d.confidence,
      ma_zaznam: useky.some((u) => kdy >= u.od && kdy <= u.do),
    };
  });

  return (
    <KameraDetail
      cameraId={camera.id}
      cameraName={camera.name}
      siteName={camera.sites?.name ?? null}
      dosahDni={PLAYBACK_REACH_DAYS}
      udalosti={udalosti}
    />
  );
}
