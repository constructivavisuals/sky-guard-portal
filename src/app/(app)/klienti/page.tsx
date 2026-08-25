import type { Metadata } from "next";
import { Users } from "lucide-react";
import { notFound } from "next/navigation";

import { DataTable, Td, Th, Tr } from "@/components/table.tsx";
import { EmptyState, PageHeader, Section } from "@/components/ui.tsx";
import { getCurrentProfile } from "@/lib/current-profile.ts";
import { logoUrl } from "@/lib/logo.ts";
import { isAdmin } from "@/lib/profile.ts";
import { getSiteSelection } from "@/lib/selected-site.ts";
import { createClient } from "@/lib/supabase/server.ts";
import { supabaseAdmin } from "@/lib/supabase-admin.ts";
import { USER_ROLE_LABELS, type UserRole } from "@/types/database.ts";

import { AccessToggle, ClientForm, PasswordForm } from "./client-form.tsx";

export const metadata: Metadata = { title: "Klienti" };

interface ClientRow {
  id: string;
  email: string | null;
  full_name: string | null;
  company_name: string | null;
  logo_path: string | null;
  role: UserRole;
  created_at: string;
  site_grants: { site_id: string; sites: { name: string } | null }[];
}

/**
 * Kdo má zamčený přístup.
 *
 * Zámek žije v auth.users, kam se přes PostgREST nedostaneme — musí
 * se na něj zeptat Admin API. Je to jediné volání navíc a jen na téhle
 * stránce; bez něj by seznam tvrdil, že zablokovaný klient se může
 * přihlásit.
 */
async function zablokovani(): Promise<Set<string>> {
  try {
    const { data, error } = await supabaseAdmin().auth.admin.listUsers({
      perPage: 200,
    });
    if (error || !data) return new Set();

    const now = Date.now();
    return new Set(
      data.users
        .filter((user) => {
          const until = (user as { banned_until?: string | null }).banned_until;
          return Boolean(until) && new Date(until as string).getTime() > now;
        })
        .map((user) => user.id),
    );
  } catch {
    // Nedostupné Admin API nesmí shodit stránku; sloupec se stavem
    // pak jen nikoho neoznačí za zablokovaného.
    return new Set();
  }
}

export default async function Page() {
  const profile = await getCurrentProfile();

  // Ne skrytí, ale zavření. Stránka pracuje s Admin API, které RLS
  // obchází — kdo sem nemá, nesmí ji vidět ani prázdnou.
  if (!isAdmin(profile)) notFound();

  const { sites } = await getSiteSelection();

  let rows: ClientRow[] = [];
  let blocked = new Set<string>();
  let failed = false;

  try {
    const supabase = await createClient();
    const [{ data, error }, banned] = await Promise.all([
      supabase
        .from("profiles")
        .select(
          "id, email, full_name, company_name, logo_path, role, created_at, " +
            "site_grants(site_id, sites(name))",
        )
        .order("created_at", { ascending: true })
        .returns<ClientRow[]>(),
      zablokovani(),
    ]);

    if (error) failed = true;
    else rows = data ?? [];
    blocked = banned;
  } catch {
    failed = true;
  }

  return (
    <>
      <PageHeader
        title="Klienti"
        description="Účty, přístup k lokalitám a loga."
        action={<ClientForm sites={sites} />}
      />

      {failed ? (
        <EmptyState
          icon={<Users className="h-5 w-5" aria-hidden="true" />}
          title="Klienty se nepodařilo načíst"
          description="Zkuste to za chvíli znovu. Pokud potíž trvá, zkontrolujte připojení k databázi."
        />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<Users className="h-5 w-5" aria-hidden="true" />}
          title="Žádní klienti"
          description="Založte první účet. Klient uvidí jen lokality, které mu přidělíte."
        />
      ) : (
        <>
          <DataTable
            caption="Klienti portálu"
            head={
              <>
                <Th>Klient</Th>
                <Th>Firma</Th>
                <Th>Role</Th>
                <Th>Lokality</Th>
                <Th>Přístup</Th>
                <Th className="w-32">
                  <span className="sr-only">Akce</span>
                </Th>
              </>
            }
          >
            {rows.map((row) => {
              const initial = {
                id: row.id,
                email: row.email,
                full_name: row.full_name,
                company_name: row.company_name,
                role: row.role,
                site_ids: row.site_grants.map((grant) => grant.site_id),
                blocked: blocked.has(row.id),
              };

              return (
                <Tr key={row.id}>
                  <Td label="Klient">
                    <div className="flex items-center gap-3">
                      <Logo path={row.logo_path} alt={row.company_name ?? ""} />
                      <div className="min-w-0">
                        <p className="truncate">
                          {row.full_name ?? row.email ?? "Bez jména"}
                        </p>
                        {row.full_name ? (
                          <p className="truncate text-xs text-[var(--text-muted)]">
                            {row.email ?? "—"}
                          </p>
                        ) : null}
                      </div>
                    </div>
                  </Td>
                  <Td label="Firma">{row.company_name ?? "—"}</Td>
                  <Td label="Role">{USER_ROLE_LABELS[row.role]}</Td>
                  <Td label="Lokality">
                    <SiteList row={row} />
                  </Td>
                  <Td label="Přístup">
                    {initial.blocked ? (
                      <span className="text-[var(--danger)]">Zablokován</span>
                    ) : (
                      <span className="text-[var(--text-muted)]">Aktivní</span>
                    )}
                  </Td>
                  <Td className="text-right">
                    <div className="inline-flex items-center">
                      <ClientForm sites={sites} client={initial} />
                      <PasswordForm client={initial} />
                      <AccessToggle client={initial} />
                    </div>
                  </Td>
                </Tr>
              );
            })}
          </DataTable>

          <Section className="text-xs leading-relaxed text-[var(--text-muted)]">
            Hesla portál nikde nezobrazuje ani neposílá — po založení je
            předejte klientovi sami. Účty se nemažou; přístup se zamyká,
            aby v historii zásahů zůstalo, kdo co udělal.
          </Section>
        </>
      )}
    </>
  );
}

/** Lokality, na které klient vidí. Admin je nepotřebuje. */
function SiteList({ row }: { row: ClientRow }) {
  if (row.role === "admin") {
    return <span className="text-[var(--text-muted)]">Všechny</span>;
  }

  const names = row.site_grants
    .map((grant) => grant.sites?.name)
    .filter((name): name is string => Boolean(name))
    .sort((a, b) => a.localeCompare(b, "cs"));

  if (names.length === 0) {
    // Není to chyba, ale admin to má vidět na první pohled — takový
    // klient se přihlásí do prázdného portálu.
    return <span className="text-[var(--warning)]">Žádné</span>;
  }
  return <>{names.join(", ")}</>;
}

function Logo({ path, alt }: { path: string | null; alt: string }) {
  const url = logoUrl(path);
  if (!url) {
    return (
      <span
        aria-hidden="true"
        className="inline-flex h-9 w-9 shrink-0 items-center justify-center border border-[var(--line-strong)] text-[var(--text-muted)]"
      >
        <Users className="h-4 w-4" aria-hidden="true" />
      </span>
    );
  }

  // Obyčejný <img>: adresa vzniká za běhu z proměnné prostředí, takže
  // by next/image potřeboval remotePatterns pro doménu, která se
  // mezi prostředími liší. Loga jsou malá a je jich pár na stránku.
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={url}
      alt={alt ? `Logo ${alt}` : ""}
      className="h-9 w-9 shrink-0 border border-[var(--line)] object-contain"
    />
  );
}
