import type { Metadata } from "next";
import { MapPin, ShieldAlert, Users } from "lucide-react";

import { DataTable, Td, Th, Tr } from "@/components/table.tsx";
import { Card, EmptyState, IconBadge, PageHeader } from "@/components/ui.tsx";
import { orDash, plural } from "@/lib/format.ts";
import { getCurrentProfile } from "@/lib/current-profile.ts";
import { isAdmin, profileInitial } from "@/lib/profile.ts";
import { createClient } from "@/lib/supabase/server.ts";
import { USER_ROLE_LABELS, type UserRole } from "@/types/database.ts";

export const metadata: Metadata = { title: "Nastavení" };

interface AccessibleSite {
  id: string;
  name: string;
  address: string | null;
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
  let failed = false;

  try {
    const supabase = await createClient();

    const { data: siteRows, error: siteError } = await supabase
      .from("sites")
      .select("id, name, address")
      .order("name")
      .returns<AccessibleSite[]>();

    if (siteError) failed = true;
    else sites = siteRows ?? [];

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

      <div className="space-y-6">
        <Card className="p-5">
          <h2 className="text-sm font-medium text-[var(--text-muted)]">Můj účet</h2>
          <div className="mt-4 flex items-center gap-4">
            <span
              className="inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-[var(--accent)] text-lg font-semibold text-white"
              aria-hidden="true"
            >
              {profileInitial(profile)}
            </span>
            <div className="min-w-0">
              <p className="truncate font-medium">
                {profile.fullName ?? profile.email ?? "Bez jména"}
              </p>
              <p className="truncate text-sm text-[var(--text-muted)]">
                {orDash(profile.email)}
                {" · "}
                {USER_ROLE_LABELS[profile.role]}
              </p>
            </div>
          </div>
        </Card>

        <Card className="p-5">
          <h2 className="text-sm font-medium text-[var(--text-muted)]">
            Přístup k lokalitám
          </h2>
          {failed ? (
            <p className="mt-3 text-sm text-[var(--danger)]">
              Seznam se nepodařilo načíst.
            </p>
          ) : sites.length === 0 ? (
            <p className="mt-3 text-sm text-[var(--text-muted)]">
              Zatím nemáte přístup k žádné lokalitě. O přidělení požádejte
              správce portálu.
            </p>
          ) : (
            <>
              <p className="mt-1 text-sm text-[var(--text-muted)]">
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
        </Card>

        {/* Přehled uživatelů je jen pro čtení — udělovat granty se bude
            jinde. RLS na profiles i site_grants stejně nikomu jinému
            než adminovi tenhle dotaz nezodpoví. */}
        {admin ? (
          <Card className="p-5">
            <div className="flex items-center gap-2">
              <Users className="h-4 w-4 text-[var(--text-muted)]" aria-hidden="true" />
              <h2 className="text-sm font-medium text-[var(--text-muted)]">
                Uživatelé
              </h2>
            </div>

            {users.length === 0 ? (
              <p className="mt-3 text-sm text-[var(--text-muted)]">
                Žádní uživatelé.
              </p>
            ) : (
              <div className="mt-4">
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
                      <Td>
                        <p className="font-medium">
                          {orDash(user.full_name ?? user.email)}
                        </p>
                        {user.full_name ? (
                          <p className="text-xs text-[var(--text-muted)]">
                            {orDash(user.email)}
                          </p>
                        ) : null}
                      </Td>
                      <Td>{USER_ROLE_LABELS[user.role]}</Td>
                      <Td className="text-[var(--text-muted)]">
                        <GrantList user={user} />
                      </Td>
                    </Tr>
                  ))}
                </DataTable>
              </div>
            )}
          </Card>
        ) : null}
      </div>
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
