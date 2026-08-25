import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Cctv, Clock, MapPin, ShieldCheck, Warehouse } from "lucide-react";
import type { ReactNode } from "react";

import { AreaMap } from "@/components/area-map.tsx";
import { Card, EmptyState, PageHeader } from "@/components/ui.tsx";
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
        <BackLink />
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
      <BackLink />
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

      <div className="space-y-6">
        <Card className="p-5">
          <h2 className="mb-3 text-sm font-medium text-[var(--text-muted)]">Areál</h2>
          <AreaMap
            imageUrl={map?.imageUrl ?? null}
            bounds={map?.bounds ?? null}
            points={map?.points ?? []}
            siteName={site.name}
          />
        </Card>

        <Card className="p-5">
          <h2 className="text-sm font-medium text-[var(--text-muted)]">Lokalita</h2>
          <dl className="mt-3 space-y-2 text-sm">
            <Row icon={<ShieldCheck className="h-4 w-4" aria-hidden="true" />} label="Stav">
              {armed === null
                ? "Stav neznámý"
                : armed
                  ? "Právě střeženo"
                  : "Právě nestřeženo"}
            </Row>
            <Row icon={<Clock className="h-4 w-4" aria-hidden="true" />} label="Okno střežení">
              {formatArmedWindow(site.armed_from, site.armed_to)}
              <span className="text-[var(--text-muted)]">
                {" · "}
                {formatArmedDays(site.armed_days)}
              </span>
            </Row>
            <Row icon={<ShieldCheck className="h-4 w-4" aria-hidden="true" />} label="Zóny">
              <Link href="/zony" className="hover:underline">
                {plural(site.zones[0]?.count ?? 0, "zóna", "zóny", "zón")}
              </Link>
            </Row>
            <Row icon={<Cctv className="h-4 w-4" aria-hidden="true" />} label="Kamery">
              <Link href="/kamery" className="hover:underline">
                {plural(site.cameras[0]?.count ?? 0, "kamera", "kamery", "kamer")}
              </Link>
            </Row>
            {/* Sériová čísla vidí jen admin, stejně jako u kamer. */}
            {admin ? (
              <Row icon={<Warehouse className="h-4 w-4" aria-hidden="true" />} label="Dok">
                <span className="font-mono text-xs">{orDash(site.dock_sn)}</span>
              </Row>
            ) : null}
          </dl>
        </Card>
      </div>
    </>
  );
}

function BackLink() {
  return (
    <Link
      href="/lokality"
      className="mb-4 inline-flex items-center gap-1.5 text-sm text-[var(--text-muted)] transition hover:text-[var(--text)]"
    >
      <ArrowLeft className="h-4 w-4" aria-hidden="true" />
      Lokality
    </Link>
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
    <div className="flex items-center gap-2">
      <span className="text-[var(--text-muted)]" aria-hidden="true">
        {icon}
      </span>
      <dt className="text-[var(--text-muted)]">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  );
}
