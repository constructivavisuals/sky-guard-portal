import type { Metadata } from "next";
import Link from "next/link";
import { Bell, MapPin, ScrollText, ShieldAlert, Users } from "lucide-react";

import { DataTable, Td, Th, Tr } from "@/components/table.tsx";
import {
  BlockTitle,
  EmptyState,
  IconBadge,
  PageHeader,
  Section,
} from "@/components/ui.tsx";
import { orDash, plural } from "@/lib/format.ts";
import type { EffectivePrefs } from "@/lib/push/rules.ts";
import { getCurrentProfile } from "@/lib/current-profile.ts";
import { isAdmin, profileInitial } from "@/lib/profile.ts";
import { createClient } from "@/lib/supabase/server.ts";
import { USER_ROLE_LABELS, type UserRole } from "@/types/database.ts";

import {
  NotificationSettings,
  type DeviceRow,
  type SiteOption,
} from "./notifications.tsx";

export const metadata: Metadata = { title: "Nastavení" };

interface AccessibleSite {
  id: string;
  name: string;
  address: string | null;
  timezone: string;
}

interface ManagedUser {
  id: string;
  email: string | null;
  full_name: string | null;
  role: UserRole;
  site_grants: { sites: { name: string } | null }[];
}

export default async function Page() {
  const profile = await getCurrentProfile();

  if (!profile) {
    return (
      <>
        <PageHeader title="Nastavení" />
        <EmptyState
          icon={<ShieldAlert className="h-5 w-5" aria-hidden="true" />}
          title="Účet se nepodařilo načíst"
          description="Zkuste se odhlásit a přihlásit znovu."
        />
      </>
    );
  }

  const admin = isAdmin(profile);

  // Seznam lokalit filtruje RLS — vrátí se právě ty, na které uživatel
  // dosáhne. Adminovi tedy všechny, klientovi ty s grantem.
  let sites: AccessibleSite[] = [];
  let users: ManagedUser[] = [];
  let devices: DeviceRow[] = [];
  let prefs: Record<string, EffectivePrefs> = {};
  let failed = false;

  try {
    const supabase = await createClient();

    const { data: siteRows, error: siteError } = await supabase
      .from("sites")
      .select("id, name, address, timezone")
      .order("name")
      .returns<AccessibleSite[]>();

    if (siteError) failed = true;
    else sites = siteRows ?? [];

    // Odběry a předvolby filtruje RLS na vlastní řádky. Chybějící
    // sloupce (migrace 20260904120000 ještě neběžela) se tu neprojeví
    // jako pád stránky — sekce notifikací se prostě chová, jako by
    // uživatel zatím nic nenastavil.
    const [deviceRows, prefRows] = await Promise.all([
      supabase
        .from("push_subscriptions")
        .select("id, endpoint, user_agent, created_at, last_used_at")
        .order("created_at", { ascending: false })
        .returns<DeviceRow[]>(),
      supabase
        .from("notification_prefs")
        .select("*")
        .returns<(EffectivePrefs & { site_id: string })[]>(),
    ]);

    devices = deviceRows.data ?? [];
    prefs = Object.fromEntries(
      (prefRows.data ?? []).map((row) => [row.site_id, row]),
    );

    if (admin) {
      const { data: userRows, error: userError } = await supabase
        .from("profiles")
        .select("id, email, full_name, role, site_grants(sites(name))")
        .order("email")
        .returns<ManagedUser[]>();

      if (userError) failed = true;
      else users = userRows ?? [];
    }
  } catch {
    failed = true;
  }

  return (
    <>
      <PageHeader
        title="Nastavení"
        description="Účet a rozsah přístupu."
      />

      <Section>
          <BlockTitle>Můj účet</BlockTitle>
          <div className="flex items-center gap-4">
            <span
              className="inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-[var(--accent)] text-lg font-semibold text-white"
              aria-hidden="true"
            >
              {profileInitial(profile)}
            </span>
            <div className="min-w-0">
              <p className="truncate text-lg tracking-tight">
                {profile.fullName ?? profile.email ?? "Bez jména"}
              </p>
              <p className="truncate text-sm text-[var(--text-muted)]">
                {orDash(profile.email)}
                {" · "}
                {USER_ROLE_LABELS[profile.role]}
              </p>
            </div>
          </div>
        </Section>

        <Section>
          <BlockTitle>Přístup k lokalitám</BlockTitle>
          {failed ? (
            <p className="text-sm text-[var(--danger)]">
              Seznam se nepodařilo načíst.
            </p>
          ) : sites.length === 0 ? (
            <p className="text-sm leading-relaxed text-[var(--text-muted)]">
              Zatím nemáte přístup k žádné lokalitě. O přidělení požádejte
              správce portálu.
            </p>
          ) : (
            <>
              <p className="text-sm text-[var(--text-muted)]">
                {admin
                  ? "Jako administrátor vidíte všechny lokality."
                  : plural(sites.length, "lokalita", "lokality", "lokalit")}
              </p>
              <ul className="mt-4 space-y-3">
                {sites.map((site) => (
                  <li key={site.id} className="flex items-center gap-3">
                    <IconBadge>
                      <MapPin className="h-5 w-5" aria-hidden="true" />
                    </IconBadge>
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{site.name}</p>
                      <p className="truncate text-sm text-[var(--text-muted)]">
                        {orDash(site.address)}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )}
        </Section>

        <Section>
          <BlockTitle>
            <span className="inline-flex items-center gap-2">
              <Bell className="h-3.5 w-3.5" aria-hidden="true" />
              Notifikace
            </span>
          </BlockTitle>
          {sites.length === 0 ? (
            <p className="text-sm leading-relaxed text-[var(--text-muted)]">
              Bez přístupu k lokalitě není o čem dávat vědět.
            </p>
          ) : (
            <NotificationSettings
              // Veřejný klíč jde do prohlížeče schválně — bez něj se
              // odběr nedá založit. Privátní zůstává na serveru.
              vapidPublicKey={process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? null}
              devices={devices}
              sites={sites satisfies SiteOption[]}
              prefs={prefs}
            />
          )}
        </Section>

        {admin ? (
          <Section>
            <BlockTitle>
              <span className="inline-flex items-center gap-2">
                <ScrollText className="h-3.5 w-3.5" aria-hidden="true" />
                Deník změn
              </span>
            </BlockTitle>
            <p className="text-sm leading-relaxed text-[var(--text-muted)]">
              Kdo co změnil v konfiguraci — lokality, zóny, kamery, značky,
              dopravce a klienty. Zápisy jde jen číst.
            </p>
            <Link
              href="/nastaveni/audit"
              className="mt-3 inline-flex items-center gap-1.5 text-sm text-[var(--accent)] hover:underline"
            >
              Otevřít deník
            </Link>
          </Section>
        ) : null}

        {/* Přehled uživatelů je jen pro čtení — udělovat granty se bude
            jinde. RLS na profiles i site_grants stejně nikomu jinému
            než adminovi tenhle dotaz nezodpoví. */}
        {admin ? (
          <>
            <Section className="pb-0 sm:pb-0">
              <BlockTitle className="mb-0">
                <span className="inline-flex items-center gap-2">
                  <Users className="h-3.5 w-3.5" aria-hidden="true" />
                  Uživatelé
                </span>
              </BlockTitle>
            </Section>

            {users.length === 0 ? (
              <Section>
                <p className="text-sm text-[var(--text-muted)]">
                  Žádní uživatelé.
                </p>
              </Section>
            ) : (
              <div className="border-b border-[var(--line)]">
                <DataTable
                  caption="Uživatelé portálu a jejich přístup k lokalitám"
                  head={
                    <>
                      <Th>Uživatel</Th>
                      <Th>Role</Th>
                      <Th>Přístup k lokalitám</Th>
                    </>
                  }
                >
                  {users.map((user) => (
                    <Tr key={user.id}>
                      <Td label="Uživatel">
                        <p className="font-medium">
                          {orDash(user.full_name ?? user.email)}
                        </p>
                        {user.full_name ? (
                          <p className="text-xs text-[var(--text-muted)]">
                            {orDash(user.email)}
                          </p>
                        ) : null}
                      </Td>
                      <Td label="Role">{USER_ROLE_LABELS[user.role]}</Td>
                      <Td label="Lokality" className="text-[var(--text-muted)]">
                        <GrantList user={user} />
                      </Td>
                    </Tr>
                  ))}
                </DataTable>
              </div>
            )}
          </>
        ) : null}
    </>
  );
}

function GrantList({ user }: { user: ManagedUser }) {
  // Admin granty nepotřebuje — site_is_visible() ho pustí všude, takže
  // prázdný seznam u něj neznamená „nikam“.
  if (user.role === "admin") return <>Všechny lokality</>;

  const names = user.site_grants
    .map((grant) => grant.sites?.name)
    .filter((name): name is string => Boolean(name))
    .sort((a, b) => a.localeCompare(b, "cs"));

  if (names.length === 0) return <>Žádný přístup</>;
  return <>{names.join(", ")}</>;
}
