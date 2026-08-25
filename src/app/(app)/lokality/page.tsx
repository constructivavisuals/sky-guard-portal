import type { Metadata } from "next";
import { Cctv, Clock, MapPin, ShieldCheck } from "lucide-react";

import { Card, EmptyState, PageHeader } from "@/components/ui.tsx";
import { formatArmedDays, formatArmedWindow, orDash, plural } from "@/lib/format.ts";
import { getCurrentProfile } from "@/lib/current-profile.ts";
import { isAdmin } from "@/lib/profile.ts";
import { getSiteSelection } from "@/lib/selected-site.ts";
import { createClient } from "@/lib/supabase/server.ts";
import type { IsoWeekday } from "@/types/database.ts";

import { SiteForm } from "./site-form.tsx";

export const metadata: Metadata = { title: "Lokality" };

interface SiteRow {
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
  // PostgREST vrací agregaci jako pole s jedním prvkem.
  zones: { count: number }[];
  cameras: { count: number }[];
}

type ArmedState = "armed" | "disarmed" | "unknown";

export default async function Page() {
  // Seznam lokalit se filtrem z cookie zúžit nemá — je to rozcestník
  // všech areálů. Vybraná se jen zvýrazní.
  const [{ selected }, profile] = await Promise.all([
    getSiteSelection(),
    getCurrentProfile(),
  ]);
  const admin = isAdmin(profile);

  let sites: SiteRow[] = [];
  let armed = new Map<string, ArmedState>();
  let failed = false;

  try {
    const supabase = await createClient();
    const { data, error } = await supabase
      .from("sites")
      .select(
        "id, name, address, timezone, armed_from, armed_to, armed_days, cooldown_seconds, dock_sn, drone_sn, fh_project_uuid, fh_workflow_uuid, zones(count), cameras(count)",
      )
      .order("name")
      .returns<SiteRow[]>();

    if (error) failed = true;
    else {
      sites = data ?? [];
      // Ostrý režim počítá databáze v zóně lokality, ne server.
      const states = await Promise.all(
        sites.map(async (site): Promise<[string, ArmedState]> => {
          const { data: isArmed, error: rpcError } = await supabase.rpc(
            "site_is_armed",
            { p_site_id: site.id },
          );
          if (rpcError) return [site.id, "unknown"];
          return [site.id, isArmed ? "armed" : "disarmed"];
        }),
      );
      armed = new Map(states);
    }
  } catch {
    failed = true;
  }

  return (
    <>
      <PageHeader
        title="Lokality"
        description="Areály, docky a hlídané zóny."
        action={admin ? <SiteForm /> : undefined}
      />

      {failed ? (
        <EmptyState
          icon={<MapPin className="h-5 w-5" aria-hidden="true" />}
          title="Lokality se nepodařilo načíst"
          description="Zkuste to za chvíli znovu. Pokud potíž trvá, zkontrolujte připojení k databázi."
        />
      ) : sites.length === 0 ? (
        <EmptyState
          icon={<MapPin className="h-5 w-5" aria-hidden="true" />}
          title="Žádné lokality"
          description="Založte první lokalitu s dockem, zónami a kamerami."
        />
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {sites.map((site) => (
            <li key={site.id}>
              <SiteCard
                site={site}
                state={armed.get(site.id) ?? "unknown"}
                current={site.id === selected?.id}
                admin={admin}
              />
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function SiteCard({
  site,
  state,
  current,
  admin,
}: {
  site: SiteRow;
  state: ArmedState;
  current: boolean;
  admin: boolean;
}) {
  const stateStyles = {
    armed: "border-[var(--success)]/40 text-[var(--success)] bg-[var(--success)]/10",
    disarmed: "border-[var(--border)] text-[var(--text-muted)]",
    unknown: "border-[var(--border)] text-[var(--text-muted)]",
  } as const;
  const stateLabels = {
    armed: "Střeženo",
    disarmed: "Nestřeženo",
    unknown: "Stav neznámý",
  } as const;

  return (
    <Card
      className={`h-full p-5 ${current ? "border-[var(--accent)]/50" : ""}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="font-medium truncate">{site.name}</h2>
          <p className="mt-0.5 text-sm text-[var(--text-muted)] truncate">
            {orDash(site.address)}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
        <span
          className={`inline-flex shrink-0 items-center gap-2 rounded-full border px-2.5 h-7 text-xs font-medium ${stateStyles[state]}`}
        >
          <span
            className={`h-1.5 w-1.5 rounded-full ${
              state === "armed" ? "bg-[var(--success)]" : "bg-[var(--text-muted)]"
            }`}
            aria-hidden="true"
          />
          {stateLabels[state]}
        </span>
        {admin ? (
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
        ) : null}
        </div>
      </div>

      <dl className="mt-4 space-y-2 text-sm">
        <Row icon={<Clock className="h-4 w-4" aria-hidden="true" />} label="Okno střežení">
          {formatArmedWindow(site.armed_from, site.armed_to)}
          <span className="text-[var(--text-muted)]">
            {" · "}
            {formatArmedDays(site.armed_days)}
          </span>
        </Row>
        <Row icon={<ShieldCheck className="h-4 w-4" aria-hidden="true" />} label="Zóny">
          {plural(site.zones[0]?.count ?? 0, "zóna", "zóny", "zón")}
        </Row>
        <Row icon={<Cctv className="h-4 w-4" aria-hidden="true" />} label="Kamery">
          {plural(site.cameras[0]?.count ?? 0, "kamera", "kamery", "kamer")}
        </Row>
      </dl>
    </Card>
  );
}

function Row({
  icon,
  label,
  children,
}: {
  icon: React.ReactNode;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-[var(--text-muted)]" aria-hidden="true">
        {icon}
      </span>
      <dt className="sr-only">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}
