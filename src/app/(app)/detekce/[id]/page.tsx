import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Cctv, Clock, Gauge, MapPin, ScanEye, Send } from "lucide-react";
import type { ReactNode } from "react";

import { DispatchOutcomeBadge, ObjectClassBadge } from "@/components/badges.tsx";
import { BlockTitle, EmptyState, PageHeader, Section } from "@/components/ui.tsx";
import { getCurrentProfile } from "@/lib/current-profile.ts";
import {
  DETECTION_BUCKET,
  SIGNED_URL_TTL_SECONDS,
} from "@/lib/detections/storage.ts";
import { formatConfidence, formatDateTime, orDash } from "@/lib/format.ts";
import { parsePointEwkbHex } from "@/lib/geo.ts";
import { unexpectedNote } from "@/lib/ingest/unexpected.ts";
import { isOperator } from "@/lib/profile.ts";
import { createClient } from "@/lib/supabase/server.ts";
import {
  DETECTION_OBJECT_CLASS_LABELS,
  DETECTION_SOURCE_LABELS,
  type DetectionObjectClass,
  type DetectionSource,
  type DispatchOutcome,
  type Json,
} from "@/types/database.ts";

export const metadata: Metadata = { title: "Detail detekce" };

// Detail detekce.
//
// Vznikl kvůli snímku: detekce bez zásahu (mimo režim, kamera bez zóny)
// nemá kam odkázat, takže obrázek neměl kde být. Rozložení je převzaté
// z detailu vjezdu — údaje vlevo, snímek vpravo.

interface DetectionDetail {
  id: string;
  source: DetectionSource;
  detected_at: string;
  object_class: DetectionObjectClass;
  confidence: number | null;
  location: string | null;
  storage_path: string | null;
  source_ip: string | null;
  ingest_key_id: string | null;
  /** Syrová data od kamery; portál si do nich píše vlastní poznámky. */
  raw: Json | null;
  sites: { name: string; timezone: string } | null;
  cameras: { name: string } | null;
  zones: { name: string } | null;
  dispatches: { id: string; sent_at: string; outcome: DispatchOutcome }[];
}

const SELECT =
  "id, source, detected_at, object_class, confidence, location, storage_path, raw, " +
  "source_ip, ingest_key_id, sites(name, timezone), cameras(name), zones(name), " +
  "dispatches!dispatches_triggered_by_detection_fkey(id, sent_at, outcome)";

/** Bez sloupců z pozdějších migrací, ať se detail dá otevřít i před nimi. */
const SELECT_ZAKLAD =
  "id, source, detected_at, object_class, confidence, location, raw, " +
  "sites(name, timezone), cameras(name), zones(name), " +
  "dispatches!dispatches_triggered_by_detection_fkey(id, sent_at, outcome)";

export default async function Page({ params }: PageProps<"/detekce/[id]">) {
  const { id } = await params;

  const profile = await getCurrentProfile();
  const operator = isOperator(profile);

  let detection: DetectionDetail | null = null;
  let imageUrl: string | null = null;
  let failed = false;

  try {
    const supabase = await createClient();

    let { data, error } = await supabase
      .from("detections")
      .select(SELECT)
      .eq("id", id)
      .maybeSingle<DetectionDetail>();

    if (error) {
      ({ data, error } = await supabase
        .from("detections")
        .select(SELECT_ZAKLAD)
        .eq("id", id)
        .maybeSingle<DetectionDetail>());
      if (data) {
        data = { ...data, storage_path: null, source_ip: null, ingest_key_id: null };
      }
    }

    if (error) failed = true;
    else if (!data) notFound();
    else {
      detection = data;

      // Snímek leží v privátním bucketu; adresa se podepisuje a platí
      // krátce. Podepisuje se klientem přihlášeného uživatele, takže
      // o přístupu rozhoduje politika nad storage.objects, ne kód.
      if (data.storage_path) {
        const { data: signed } = await supabase.storage
          .from(DETECTION_BUCKET)
          .createSignedUrl(data.storage_path, SIGNED_URL_TTL_SECONDS);
        imageUrl = signed?.signedUrl ?? null;
      }
    }
  } catch {
    failed = true;
  }

  if (failed || !detection) {
    return (
      <>
        <BackLink />
        <PageHeader title="Detail detekce" />
        <EmptyState
          icon={<ScanEye className="h-5 w-5" aria-hidden="true" />}
          title="Detekci se nepodařilo načíst"
          description="Zkuste to za chvíli znovu. Pokud potíž trvá, zkontrolujte připojení k databázi."
        />
      </>
    );
  }

  const timeZone = detection.sites?.timezone;
  const point = parsePointEwkbHex(detection.location);
  // Kamera poslala třídu, kterou podle nastavení neumí. Zapsalo se to
  // při příjmu; tady se to jen ukáže, protože log za měsíc není.
  const neocekavana = unexpectedNote(detection.raw);

  return (
    <>
      <BackLink />
      <PageHeader
        title="Detail detekce"
        description={`${orDash(detection.sites?.name)} · ${formatDateTime(detection.detected_at, timeZone)}`}
        action={<ObjectClassBadge objectClass={detection.object_class} />}
      />

      <div className="lg:grid lg:grid-cols-2">
        <div className="min-w-0 lg:border-r lg:border-[var(--line)]">
          <Section>
            <BlockTitle>Údaje</BlockTitle>
            <dl className="text-sm">
              <Row icon={<Clock className="h-3.5 w-3.5" aria-hidden="true" />} label="Čas">
                {formatDateTime(detection.detected_at, timeZone)}
              </Row>
              <Row icon={<Cctv className="h-3.5 w-3.5" aria-hidden="true" />} label="Kamera">
                {orDash(detection.cameras?.name)}
              </Row>
              <Row icon={<MapPin className="h-3.5 w-3.5" aria-hidden="true" />} label="Zóna">
                {detection.zones?.name ?? (
                  // Kamera bez zóny detekuje, ale zásah z ní nevznikne.
                  <span className="text-[var(--warning)]">Kamera nemá zónu</span>
                )}
              </Row>
              <Row icon={<Gauge className="h-3.5 w-3.5" aria-hidden="true" />} label="Jistota">
                {formatConfidence(detection.confidence)}
              </Row>
              <Row icon={<ScanEye className="h-3.5 w-3.5" aria-hidden="true" />} label="Zdroj">
                {DETECTION_SOURCE_LABELS[detection.source]}
              </Row>
              {point ? (
                <Row icon={<MapPin className="h-3.5 w-3.5" aria-hidden="true" />} label="Souřadnice">
                  <span className="tabular-nums">
                    {point.latitude.toFixed(5)}, {point.longitude.toFixed(5)}
                  </span>
                </Row>
              ) : null}
            </dl>
          </Section>

          {neocekavana ? (
            <Section>
              <BlockTitle>Neočekávaná detekce</BlockTitle>
              <p className="border border-[var(--warning)]/40 bg-[var(--warning)]/[0.08] px-3.5 py-2.5 text-sm leading-relaxed text-[var(--warning)]">
                Kamera hlásí {DETECTION_OBJECT_CLASS_LABELS[
                  neocekavana.unexpected_class
                ].toLowerCase()}
                , přestože tuhle třídu podle nastavení neumí. Detekce je platná
                a zásah se rozhodoval jako obvykle — ale někdo nejspíš vyměnil
                model v kameře a nedoplnil to v portálu, nebo kamera hlásí něco
                jiného, než si myslíme.
              </p>
            </Section>
          ) : null}

          <Section>
            <BlockTitle>Zásahy</BlockTitle>
            {detection.dispatches.length === 0 ? (
              <p className="text-sm leading-relaxed text-[var(--text-muted)]">
                K téhle detekci nevznikl žádný zásah — areál nebyl v ostrém
                režimu, nebo kamera nemá zónu.
              </p>
            ) : (
              <ul className="text-sm">
                {detection.dispatches.map((dispatch) => (
                  <li
                    key={dispatch.id}
                    className="flex items-center justify-between gap-4 border-b border-[var(--line)] py-3 last:border-b-0"
                  >
                    <Link
                      href={`/zasahy/${dispatch.id}`}
                      className="flex min-w-0 items-center gap-3 hover:text-[var(--accent-bright)]"
                    >
                      <Send className="h-4 w-4 shrink-0 text-[var(--text-muted)]" aria-hidden="true" />
                      <span className="tabular-nums">
                        {formatDateTime(dispatch.sent_at, timeZone)}
                      </span>
                    </Link>
                    <DispatchOutcomeBadge outcome={dispatch.outcome} />
                  </li>
                ))}
              </ul>
            )}
          </Section>

          {/* Odkud požadavek přišel a čím byl podepsaný. Diagnostika pro
              operátora — klientovi to nic neřekne a je to údaj o síti,
              ne o areálu. */}
          {operator ? (
            <Section last>
              <BlockTitle>Původ požadavku</BlockTitle>
              <dl className="text-sm">
                <Row icon={<ScanEye className="h-3.5 w-3.5" aria-hidden="true" />} label="IP">
                  <span className="font-mono text-xs">{orDash(detection.source_ip)}</span>
                </Row>
                <Row icon={<ScanEye className="h-3.5 w-3.5" aria-hidden="true" />} label="Klíč">
                  <span className="font-mono text-xs">
                    {detection.ingest_key_id === "shared"
                      ? "společné tajemství"
                      : orDash(detection.ingest_key_id)}
                  </span>
                </Row>
              </dl>
            </Section>
          ) : null}
        </div>

        <div className="flex min-w-0 flex-col">
          <Section flush className="p-5 sm:p-6 lg:sticky lg:top-0">
            <BlockTitle>Snímek</BlockTitle>
            {imageUrl ? (
              // Obyčejný <img>: adresa je podepsaná a krátkodobá, takže
              // by ji next/image cachoval pod klíčem, který za pár minut
              // přestane platit.
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={imageUrl}
                alt={`Snímek detekce ${formatDateTime(detection.detected_at, timeZone)}`}
                className="w-full border border-[var(--line-strong)]"
              />
            ) : (
              <p className="border border-dashed border-[var(--line-strong)] bg-[var(--surface-2)] px-4 py-10 text-center text-sm leading-relaxed text-[var(--text-muted)]">
                {detection.storage_path
                  ? "Snímek se nepodařilo načíst."
                  : detection.source === "drone"
                    ? "Dronové detekce snímek nenesou — záznam z letu je u letu."
                    : "Kamera k téhle detekci snímek neposlala."}
              </p>
            )}
          </Section>
          <div
            aria-hidden="true"
            className="hidden flex-1 rule-field lg:block"
            style={{ "--col": "50%" } as React.CSSProperties}
          />
        </div>
      </div>
    </>
  );
}

function BackLink() {
  return (
    <div className="border-b border-[var(--line)] px-5 py-2.5 sm:px-8">
      <Link
        href="/detekce"
        className="inline-flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.12em] text-[var(--text-muted)] transition hover:text-[var(--text)]"
      >
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
        Detekce
      </Link>
    </div>
  );
}

function Row({
  icon,
  label,
  children,
}: {
  icon: ReactNode;
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-[var(--line)] py-3 last:border-b-0">
      <dt className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.1em] text-[var(--text-muted)]">
        <span aria-hidden="true">{icon}</span>
        {label}
      </dt>
      <dd className="min-w-0 text-right">{children}</dd>
    </div>
  );
}
