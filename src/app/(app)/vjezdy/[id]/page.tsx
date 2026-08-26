import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, CarFront, Cctv, Clock, Gauge, Send } from "lucide-react";
import type { ReactNode } from "react";

import { DispatchOutcomeBadge, PlateBadge } from "@/components/badges.tsx";
import { BlockTitle, EmptyState, PageHeader, Section } from "@/components/ui.tsx";
import { formatDateTime, orDash } from "@/lib/format.ts";
import { PLATE_CONFIDENCE_MIN } from "@/lib/plates.ts";
import { PASSAGE_BUCKET, SIGNED_URL_TTL_SECONDS } from "@/lib/plates/storage.ts";
import { isPlatePending, isPlateUncertain, passageVerdict } from "@/lib/plates/verdict.ts";
import { createClient } from "@/lib/supabase/server.ts";
import type { DispatchOutcome, PlateListType } from "@/types/database.ts";

export const metadata: Metadata = { title: "Detail vjezdu" };

interface PassageDetail {
  id: string;
  passed_at: string;
  plate: string | null;
  confidence: number | null;
  storage_path: string | null;
  list_match: PlateListType | null;
  known_label: string | null;
  plate_read_at: string | null;
  detection_id: string;
  sites: { name: string; timezone: string } | null;
  cameras: { name: string } | null;
}

interface DispatchRow {
  id: string;
  sent_at: string;
  level_sent: number;
  outcome: DispatchOutcome;
}

export default async function Page({ searchParams: _s, params }: PageProps<"/vjezdy/[id]">) {
  void _s;
  const { id } = await params;

  let passage: PassageDetail | null = null;
  let dispatches: DispatchRow[] = [];
  let imageUrl: string | null = null;
  let failed = false;

  try {
    const supabase = await createClient();
    const { data, error } = await supabase
      .from("vehicle_passages")
      .select(
        "id, passed_at, plate, confidence, storage_path, list_match, known_label, " +
          "plate_read_at, detection_id, sites(name, timezone), cameras(name)",
      )
      .eq("id", id)
      .maybeSingle<PassageDetail>();

    // RLS nerozlišuje „neexistuje“ a „nevidíš na něj“ — obojí je 404.
    if (error) failed = true;
    else if (!data) notFound();
    else {
      passage = data;

      const [zasahy, adresa] = await Promise.all([
        supabase
          .from("dispatches")
          .select("id, sent_at, level_sent, outcome")
          .eq("triggered_by_detection", data.detection_id)
          .order("sent_at", { ascending: true })
          .returns<DispatchRow[]>(),
        // Snímek leží v privátním bucketu; adresa se podepisuje a platí
        // krátce. Podepisuje se klientem přihlášeného uživatele, takže
        // o přístupu rozhoduje politika nad storage.objects, ne kód.
        data.storage_path
          ? supabase.storage
              .from(PASSAGE_BUCKET)
              .createSignedUrl(data.storage_path, SIGNED_URL_TTL_SECONDS)
          : Promise.resolve({ data: null, error: null }),
      ]);

      dispatches = zasahy.data ?? [];
      imageUrl = adresa.data?.signedUrl ?? null;
    }
  } catch {
    failed = true;
  }

  if (failed || !passage) {
    return (
      <>
        <BackLink />
        <PageHeader title="Detail vjezdu" />
        <EmptyState
          icon={<CarFront className="h-5 w-5" aria-hidden="true" />}
          title="Vjezd se nepodařilo načíst"
          description="Zkuste to za chvíli znovu. Pokud potíž trvá, zkontrolujte připojení k databázi."
        />
      </>
    );
  }

  const timeZone = passage.sites?.timezone ?? "Europe/Prague";
  const verdict = passageVerdict(passage);
  const uncertain = isPlateUncertain(passage);
  const pending = isPlatePending(passage);

  return (
    <>
      <BackLink />
      <PageHeader
        title={passage.plate ?? "Vjezd bez přečtené značky"}
        description={formatDateTime(passage.passed_at, timeZone)}
      />

      <div className="lg:grid lg:grid-cols-2">
        <div className="min-w-0 lg:border-r lg:border-[var(--line)]">
          <Section>
            <BlockTitle>Vyhodnocení</BlockTitle>
            <PlateBadge verdict={verdict} label={passage.known_label} />

            {uncertain ? (
              // Nejistá značka není jen odstín v UI: se seznamem se
              // vůbec neporovnávala, takže tu nestojí „neznámá“.
              <p className="mt-4 border border-[var(--warning)]/40 bg-[var(--warning)]/[0.08] px-3.5 py-2.5 text-sm leading-relaxed text-[var(--warning)]">
                Model si značkou nebyl jistý ({formatPercent(passage.confidence)}
                {" "}pod prahem {formatPercent(PLATE_CONFIDENCE_MIN)}), takže se
                se seznamem známých značek neporovnávala. Ověřte ji ze snímku.
              </p>
            ) : null}

            {pending ? (
              <p className="mt-4 text-sm text-[var(--text-muted)]">
                Značka se právě čte. Zásah na tuhle událost už mezitím
                proběhl — nečeká se na ni.
              </p>
            ) : null}
          </Section>

          <Section>
            <BlockTitle>Údaje</BlockTitle>
            <dl className="text-sm">
              <Row icon={<Clock className="h-3.5 w-3.5" aria-hidden="true" />} label="Čas">
                {formatDateTime(passage.passed_at, timeZone)}
              </Row>
              <Row icon={<CarFront className="h-3.5 w-3.5" aria-hidden="true" />} label="Značka">
                {passage.plate ? (
                  <span className="font-mono">{passage.plate}</span>
                ) : (
                  "—"
                )}
              </Row>
              <Row icon={<Gauge className="h-3.5 w-3.5" aria-hidden="true" />} label="Jistota">
                <span className={uncertain ? "text-[var(--warning)]" : undefined}>
                  {formatPercent(passage.confidence)}
                </span>
              </Row>
              <Row icon={<Cctv className="h-3.5 w-3.5" aria-hidden="true" />} label="Kamera">
                {orDash(passage.cameras?.name)}
              </Row>
              <Row icon={<Clock className="h-3.5 w-3.5" aria-hidden="true" />} label="Přečteno">
                {passage.plate_read_at
                  ? formatDateTime(passage.plate_read_at, timeZone)
                  : "Zatím ne"}
              </Row>
            </dl>
          </Section>

          <Section last={dispatches.length === 0}>
            <BlockTitle>Zásahy</BlockTitle>
            {dispatches.length === 0 ? (
              <p className="text-sm leading-relaxed text-[var(--text-muted)]">
                K téhle události nevznikl žádný zásah — areál nebyl v ostrém
                režimu, nebo kamera nemá zónu.
              </p>
            ) : (
              <ul className="text-sm">
                {dispatches.map((zasah) => (
                  <li
                    key={zasah.id}
                    className="flex items-center justify-between gap-4 border-b border-[var(--line)] py-3 last:border-b-0"
                  >
                    <Link
                      href={`/zasahy/${zasah.id}`}
                      className="flex min-w-0 items-center gap-3 hover:text-[var(--accent-bright)]"
                    >
                      <Send className="h-4 w-4 shrink-0 text-[var(--text-muted)]" aria-hidden="true" />
                      <span className="tabular-nums">
                        {formatDateTime(zasah.sent_at, timeZone)}
                      </span>
                      <span className="text-[var(--text-muted)]">
                        stupeň {zasah.level_sent}
                      </span>
                    </Link>
                    <DispatchOutcomeBadge outcome={zasah.outcome} />
                  </li>
                ))}
              </ul>
            )}
            {dispatches.length > 1 ? (
              <p className="mt-3 text-xs leading-relaxed text-[var(--text-muted)]">
                Dva zásahy znamenají eskalaci: první odešel za vozidlo hned
                při vjezdu, druhý až po přečtení nežádoucí značky.
              </p>
            ) : null}
          </Section>
        </div>

        <div className="flex min-w-0 flex-col">
          <Section flush className="p-5 sm:p-6 lg:sticky lg:top-0">
            <BlockTitle>Snímek</BlockTitle>
            {imageUrl ? (
              // Obyčejný <img>: adresa je podepsaná a krátkodobá, takže
              // by ji next/image cachoval pod klíčem, který za pět minut
              // přestane platit.
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={imageUrl}
                alt={`Snímek vjezdu ${passage.plate ?? ""}`}
                className="w-full border border-[var(--line-strong)]"
              />
            ) : (
              <p className="border border-dashed border-[var(--line-strong)] bg-[var(--surface-2)] px-4 py-10 text-center text-sm text-[var(--text-muted)]">
                {passage.storage_path
                  ? "Snímek se nepodařilo načíst."
                  : "Kamera k téhle události snímek neposlala."}
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

function formatPercent(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return `${Math.round(value * 100)} %`;
}

function BackLink() {
  return (
    <div className="border-b border-[var(--line)] px-5 py-2.5 sm:px-8">
      <Link
        href="/vjezdy"
        className="inline-flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.12em] text-[var(--text-muted)] transition hover:text-[var(--text)]"
      >
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
        Vjezdy
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
