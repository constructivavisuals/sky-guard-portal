import type { Metadata } from "next";
import Link from "next/link";
import { Cctv, Clock, MapPin, ShieldCheck } from "lucide-react";

import { EmptyState, PageHeader } from "@/components/ui.tsx";
import { formatArmedDays, formatArmedWindow, orDash, plural } from "@/lib/format.ts";
import { getCurrentProfile } from "@/lib/current-profile.ts";
import { isAdmin } from "@/lib/profile.ts";
import { getSiteSelection } from "@/lib/selected-site.ts";
import { createClient } from "@/lib/supabase/server.ts";
import { isSiteArmed, type IsoWeekday } from "@/types/database.ts";

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
  retention_days: number;
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
        "id, name, address, timezone, armed_from, armed_to, armed_days, cooldown_seconds, retention_days, dock_sn, drone_sn, fh_project_uuid, fh_workflow_uuid, zones(count), cameras(count)",
      )
      .order("name")
      .returns<SiteRow[]>();

    if (error) failed = true;
    else {
      sites = data ?? [];
      // Ostrý režim se počítá z okna, které lokalita už poslala s sebou.
      // Dřív se na to volalo site_is_armed() zvlášť pro každý řádek —
      // deset lokalit znamenalo deset dalších kol přes síť, a to jen
      // kvůli tečce u názvu. Shodu se SQL hlídá paritní test.
      armed = new Map(
        sites.map((site) => [
          site.id,
          isSiteArmed(site) ? ("armed" as const) : ("disarmed" as const),
        ]),
      );
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
        // Mřížka bez mezer; buňky dělí vlasová linka a na čtvrtinovém
        // rastru navazuje na linky pokračující pod obsahem.
        <ul className="hairline-grid sm:grid-cols-2">
          {sites.map((site) => (
            <li key={site.id} className="min-w-0">
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
    armed:
      "border-[var(--success)]/35 text-[var(--success)] bg-[var(--success)]/[0.08]",
    disarmed: "border-[var(--line-strong)] text-[var(--text-muted)]",
    unknown: "border-[var(--line-strong)] text-[var(--text-muted)]",
  } as const;
  const stateLabels = {
    armed: "Střeženo",
    disarmed: "Nestřeženo",
    unknown: "Stav neznámý",
  } as const;

  return (
    <div className="relative h-full px-5 py-5 sm:px-6">
      {/* Vybraná lokalita má svislý pruh, ne obarvený rámeček —
          rámeček by rozbil linku mřížky. */}
      {current ? (
        <span
          aria-hidden="true"
          className="absolute inset-y-0 left-0 w-[2px] bg-[var(--accent-bright)]"
        />
      ) : null}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="truncate text-base tracking-tight">
            <Link
              href={`/arealy/${site.id}`}
              className="transition hover:text-[var(--accent-bright)]"
            >
              {site.name}
            </Link>
          </h2>
          <p className="mt-0.5 text-sm text-[var(--text-muted)] truncate">
            {orDash(site.address)}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
        <span
          className={`inline-flex h-7 shrink-0 items-center gap-2 rounded-[var(--radius-pill)] border px-2.5 text-[11px] font-medium uppercase tracking-[0.08em] ${stateStyles[state]}`}
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
                retention_days: site.retention_days,
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
    </div>
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
