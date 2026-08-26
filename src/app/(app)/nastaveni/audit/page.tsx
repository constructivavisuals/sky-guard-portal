import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, ScrollText } from "lucide-react";

import { PAGE_SIZE, Pagination, pageFromParam, pageRange } from "@/components/pagination.tsx";
import { DataTable, Td, TdTight, Th, Tr } from "@/components/table.tsx";
import { EmptyState, PageHeader } from "@/components/ui.tsx";
import {
  AUDIT_ACTION_LABELS,
  AUDIT_ENTITY_LABELS,
  auditChangedFields,
  auditLabel,
  type AuditMetadata,
} from "@/lib/audit.ts";
import { getCurrentProfile } from "@/lib/current-profile.ts";
import { formatDateTime, orDash } from "@/lib/format.ts";
import { isAdmin } from "@/lib/profile.ts";
import { createClient } from "@/lib/supabase/server.ts";

export const metadata: Metadata = { title: "Deník změn" };

// Kdo co změnil v konfiguraci.
//
// Jen pro čtení a jen pro admina — politika read_audit_log stojí na
// is_admin(), takže tahle stránka je jen kabát nad tím, co pustí RLS.
// Zápis nemá kdo přepsat: audit_log je append-only, UPDATE i DELETE na
// něm blokuje trigger, a to i pro service_role.
//
// Zapisuje trigger v databázi, ne aplikace. Deník proto zachytí i
// změnu udělanou cestou, která o auditu neví — třeba přímo v SQL
// editoru.

interface AuditRow {
  id: string;
  actor_id: string | null;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  metadata: AuditMetadata | null;
  created_at: string;
  profiles: { email: string | null; full_name: string | null } | null;
}

const SELECT =
  "id, actor_id, action, entity_type, entity_id, metadata, created_at, " +
  "profiles!audit_log_actor_id_fkey(email, full_name)";

/** Bez vazby na profil — cizí klíč na audit_log nemusí existovat. */
const SELECT_BEZ_AUTORA =
  "id, actor_id, action, entity_type, entity_id, metadata, created_at";

export default async function Page({ searchParams }: PageProps<"/nastaveni/audit">) {
  const { strana } = await searchParams;
  const page = pageFromParam(typeof strana === "string" ? strana : undefined);
  const { from, to } = pageRange(page);

  const profile = await getCurrentProfile();
  // Skrytí není zámek — ten je v politice na audit_log. Tohle jen
  // ušetří klientovi prázdnou tabulku.
  if (!isAdmin(profile)) notFound();

  let rows: AuditRow[] = [];
  let total = 0;
  let failed = false;

  try {
    const supabase = await createClient();

    const dotaz = (sloupce: string) =>
      supabase
        .from("audit_log")
        .select(sloupce, { count: "exact" })
        .order("created_at", { ascending: false })
        .range(from, to)
        .returns<AuditRow[]>();

    let vysledek = await dotaz(SELECT);
    if (vysledek.error) vysledek = await dotaz(SELECT_BEZ_AUTORA);

    if (vysledek.error) failed = true;
    else {
      rows = vysledek.data ?? [];
      total = vysledek.count ?? 0;
    }
  } catch {
    failed = true;
  }

  return (
    <>
      <div className="border-b border-[var(--line)] px-5 py-2.5 sm:px-8">
        <Link
          href="/nastaveni"
          className="inline-flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.12em] text-[var(--text-muted)] transition hover:text-[var(--text)]"
        >
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
          Nastavení
        </Link>
      </div>

      <PageHeader
        title="Deník změn"
        description="Kdo co změnil v konfiguraci. Zápisy jde jen číst, ne upravovat ani mazat."
      />

      {failed ? (
        <EmptyState
          icon={<ScrollText className="h-5 w-5" aria-hidden="true" />}
          title="Deník se nepodařilo načíst"
          description="Zkuste to za chvíli znovu. Pokud potíž trvá, zkontrolujte připojení k databázi."
        />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<ScrollText className="h-5 w-5" aria-hidden="true" />}
          title="Zatím žádné změny"
          description="Jakmile někdo upraví lokalitu, zónu, kameru, značku, dopravce nebo klienta, objeví se to tady."
        />
      ) : (
        <>
          <DataTable
            caption="Změny konfigurace, nejnovější první"
            head={
              <>
                <Th>Kdy</Th>
                <Th>Kdo</Th>
                <Th>Co</Th>
                <Th>Čeho se to týkalo</Th>
                <Th>Změněno</Th>
              </>
            }
          >
            {rows.map((row) => (
              <Tr key={row.id}>
                <TdTight label="Kdy" className="text-[var(--text-muted)] tabular-nums">
                  {formatDateTime(row.created_at)}
                </TdTight>
                <Td label="Kdo">
                  {orDash(row.profiles?.full_name ?? row.profiles?.email)}
                </Td>
                <Td label="Co">
                  {AUDIT_ACTION_LABELS[row.action] ?? row.action}
                  {" · "}
                  <span className="text-[var(--text-muted)]">
                    {AUDIT_ENTITY_LABELS[row.entity_type ?? ""] ?? row.entity_type}
                  </span>
                </Td>
                <Td label="Čeho">{popis(row)}</Td>
                <Td label="Změněno" className="text-[var(--text-muted)]">
                  {auditChangedFields(row.metadata).join(", ") || "—"}
                </Td>
              </Tr>
            ))}
          </DataTable>
          <Pagination
            page={page}
            total={total}
            basePath="/nastaveni/audit"
            size={PAGE_SIZE}
          />
        </>
      )}
    </>
  );
}

/**
 * Čeho se změna týkala.
 *
 * Trigger ukládá celý řádek, takže název jde vytáhnout z něj. U úpravy
 * se ukládají jen změněná pole, tedy název v nich nemusí být — pak
 * zbývá id, které aspoň řekne, o který řádek šlo.
 */
function popis(row: AuditRow): string {
  return auditLabel(row.metadata) ?? orDash(row.entity_id?.slice(0, 8) ?? null);
}
