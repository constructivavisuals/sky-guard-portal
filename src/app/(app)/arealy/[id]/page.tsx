import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Cctv, Clock, ShieldCheck, Warehouse } from "lucide-react";
import type { ReactNode } from "react";

import { BlockTitle, Section } from "@/components/ui.tsx";
import { getCurrentProfile } from "@/lib/current-profile.ts";
import { formatArmedDays, formatArmedWindow, orDash, plural } from "@/lib/format.ts";
import { isAdmin } from "@/lib/profile.ts";

import { SiteForm } from "../site-form.tsx";
import { nactiAreal } from "./site.ts";

export const metadata: Metadata = { title: "Areál" };

// Karta „Lokalita“: údaje o areálu. Hlavičku, mapu a karty kreslí
// layout, takže tady zbývá jen obsah.

export default async function Page({ params }: PageProps<"/arealy/[id]">) {
  const { id } = await params;
  const [{ site, armed }, profile] = await Promise.all([
    nactiAreal(id),
    getCurrentProfile(),
  ]);

  if (!site) notFound();
  const admin = isAdmin(profile);

  return (
    <Section last>
      <BlockTitle
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
      >
        Lokalita
      </BlockTitle>

      <dl className="text-sm">
        <Row icon={<ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />} label="Stav">
          {armed === null ? "Stav neznámý" : armed ? "Právě střeženo" : "Právě nestřeženo"}
        </Row>
        <Row icon={<Clock className="h-3.5 w-3.5" aria-hidden="true" />} label="Okno střežení">
          {formatArmedWindow(site.armed_from, site.armed_to)}
          <span className="text-[var(--text-muted)]">
            {" · "}
            {formatArmedDays(site.armed_days)}
          </span>
        </Row>
        <Row icon={<ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />} label="Zóny">
          <Link href={`/arealy/${id}/zony`} className="hover:underline">
            {plural(site.zones[0]?.count ?? 0, "zóna", "zóny", "zón")}
          </Link>
        </Row>
        <Row icon={<Cctv className="h-3.5 w-3.5" aria-hidden="true" />} label="Kamery">
          <Link href={`/arealy/${id}/kamery`} className="hover:underline">
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
