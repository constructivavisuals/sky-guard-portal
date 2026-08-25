import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Cctv, Clock, MapPin, ShieldCheck, Warehouse } from "lucide-react";
import type { ReactNode } from "react";

import { AreaMap } from "@/components/area-map.tsx";
import {
  BlockTitle,
  EmptyState,
  PageHeader,
  Section,
} from "@/components/ui.tsx";
import { AREA_MAP_SITE_COLUMNS, loadAreaMap, type AreaMapData } from "@/lib/area-map-data.ts";
import { formatArmedDays, formatArmedWindow, orDash, plural } from "@/lib/format.ts";
import { getCurrentProfile } from "@/lib/current-profile.ts";
import { isAdmin } from "@/lib/profile.ts";
import { createClient } from "@/lib/supabase/server.ts";
import type { IsoWeekday } from "@/types/database.ts";

import { SiteForm } from "../site-form.tsx";

export const metadata: Metadata = { title: "Detail lokality" };

interface SiteDetail {
  id: string;
  name: string;
  address: string | null;
  timezone: string;
  armed_from: string;
  armed_to: string;
  armed_days: IsoWeekday[];
  cooldown_seconds: number;
  dock_sn: string | null;
  drone_sn: string | null;
  fh_project_uuid: string | null;
  fh_workflow_uuid: string | null;
  map_image_url: string | null;
  map_nw_lat: number | null;
  map_nw_lon: number | null;
  map_se_lat: number | null;
  map_se_lon: number | null;
  zones: { count: number }[];
  cameras: { count: number }[];
}

export default async function Page({ params }: PageProps<"/lokality/[id]">) {
  const { id } = await params;

  const profile = await getCurrentProfile();
  const admin = isAdmin(profile);

  let site: SiteDetail | null = null;
  let armed: boolean | null = null;
  let map: AreaMapData | null = null;
  let failed = false;

  try {
    const supabase = await createClient();
    const { data, error } = await supabase
      .from("sites")
      .select(
        "id, name, address, timezone, armed_from, armed_to, armed_days, cooldown_seconds, " +
          "dock_sn, drone_sn, fh_project_uuid, fh_workflow_uuid, zones(count), cameras(count), " +
          AREA_MAP_SITE_COLUMNS,
      )
      .eq("id", id)
      .maybeSingle<SiteDetail>();

    // RLS nerozlišuje „neexistuje“ a „nevidíš na ni“ — obojí je 404.
    if (error) failed = true;
    else if (!data) notFound();
    else {
      site = data;
      const { data: isArmed, error: rpcError } = await supabase.rpc("site_is_armed", {
        p_site_id: site.id,
      });
      armed = rpcError ? null : isArmed === true;
      map = await loadAreaMap(supabase, site);
    }
  } catch {
    failed = true;
  }

  if (failed || !site) {
    return (
      <>
        <BackLink href="/lokality" label="Lokality" />
        <PageHeader title="Detail lokality" />
        <EmptyState
          icon={<MapPin className="h-5 w-5" aria-hidden="true" />}
          title="Lokalitu se nepodařilo načíst"
          description="Zkuste to za chvíli znovu. Pokud potíž trvá, zkontrolujte připojení k databázi."
        />
      </>
    );
  }

  return (
    <>
      <BackLink href="/lokality" label="Lokality" />
      <PageHeader
        title={site.name}
        description={orDash(site.address)}
        action={
          admin ? (
            <SiteForm
              site={{
                id: site.id,
                name: site.name,
                address: site.address,
                timezone: site.timezone,
                armed_from: site.armed_from,
                armed_to: site.armed_to,
                armed_days: site.armed_days,
                cooldown_seconds: site.cooldown_seconds,
                dock_sn: site.dock_sn,
                drone_sn: site.drone_sn,
                fh_project_uuid: site.fh_project_uuid,
                fh_workflow_uuid: site.fh_workflow_uuid,
              }}
            />
          ) : undefined
        }
      />

      {/* Dva sloupce jako na přehledu: údaje vlevo, podklad vpravo.
          Na celou šířku by mapa areálu vyšla nesmyslně velká. */}
      <div className="lg:grid lg:grid-cols-2">
        <div className="min-w-0 lg:border-r lg:border-[var(--line)]">
          <Section>
            <BlockTitle>Lokalita</BlockTitle>
            <dl className="text-sm">
            <Row icon={<ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />} label="Stav">
              {armed === null
                ? "Stav neznámý"
                : armed
                  ? "Právě střeženo"
                  : "Právě nestřeženo"}
            </Row>
            <Row icon={<Clock className="h-3.5 w-3.5" aria-hidden="true" />} label="Okno střežení">
              {formatArmedWindow(site.armed_from, site.armed_to)}
              <span className="text-[var(--text-muted)]">
                {" · "}
                {formatArmedDays(site.armed_days)}
              </span>
            </Row>
            <Row icon={<ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />} label="Zóny">
              <Link href="/zony" className="hover:underline">
                {plural(site.zones[0]?.count ?? 0, "zóna", "zóny", "zón")}
              </Link>
            </Row>
            <Row icon={<Cctv className="h-3.5 w-3.5" aria-hidden="true" />} label="Kamery">
              <Link href="/kamery" className="hover:underline">
                {plural(site.cameras[0]?.count ?? 0, "kamera", "kamery", "kamer")}
              </Link>
            </Row>
            {/* Sériová čísla vidí jen admin, stejně jako u kamer. */}
            {admin ? (
              <Row icon={<Warehouse className="h-3.5 w-3.5" aria-hidden="true" />} label="Dok">
                <span className="font-mono text-xs">{orDash(site.dock_sn)}</span>
              </Row>
            ) : null}
            </dl>
          </Section>
        </div>

        <div className="flex min-w-0 flex-col">
          <Section flush className="p-5 sm:p-6 lg:sticky lg:top-0">
            <BlockTitle>Areál</BlockTitle>
            <AreaMap
              imageUrl={map?.imageUrl ?? null}
              bounds={map?.bounds ?? null}
              points={map?.points ?? []}
              siteName={site.name}
            />
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

function BackLink({ href, label }: { href: string; label: string }) {
  return (
    <div className="border-b border-[var(--line)] px-5 py-2.5 sm:px-8">
      <Link
        href={href}
        className="inline-flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.12em] text-[var(--text-muted)] transition hover:text-[var(--text)]"
      >
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
        {label}
      </Link>
    </div>
  );
}

/** Řádek údaje: popisek vlevo, hodnota vpravo, oddělené linkou. */
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
