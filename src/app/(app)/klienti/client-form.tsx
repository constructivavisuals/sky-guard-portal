"use client";

import { KeyRound, Pencil, Plus, ShieldOff, ShieldCheck } from "lucide-react";
import { useActionState, useState } from "react";

import {
  FormDialog,
  FormError,
  SelectField,
  SubmitButton,
  TextField,
} from "@/components/form.tsx";
import { Button } from "@/components/ui.tsx";
import type { SiteOption } from "@/lib/site.ts";
import { MIN_PASSWORD_LENGTH } from "@/lib/validation.ts";
import { USER_ROLES, USER_ROLE_LABELS } from "@/types/database.ts";

import {
  prepnoutPristup,
  upravitKlienta,
  vytvoritKlienta,
  zmenitHeslo,
  type ClientFormState,
} from "./actions.ts";

const EMPTY: ClientFormState = { ok: false, errors: {}, attempt: 0 };

export interface ClientInitial {
  id: string;
  email: string | null;
  full_name: string | null;
  company_name: string | null;
  role: string;
  site_ids: string[];
  blocked: boolean;
}

// ── Založení a úprava ────────────────────────────────────────────

export function ClientForm({
  sites,
  client,
}: {
  sites: SiteOption[];
  client?: ClientInitial;
}) {
  const [session, setSession] = useState(0);
  const [open, setOpen] = useState(false);
  const show = () => {
    setSession((value) => value + 1);
    setOpen(true);
  };

  return (
    <>
      {client ? (
        <IconButton onClick={show} label={`Upravit klienta ${client.email ?? ""}`}>
          <Pencil className="h-4 w-4" aria-hidden="true" />
        </IconButton>
      ) : (
        <Button type="button" onClick={show}>
          <Plus className="h-4 w-4" aria-hidden="true" />
          Přidat klienta
        </Button>
      )}

      {open ? (
        <ClientDialog
          key={session}
          sites={sites}
          client={client}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

function ClientDialog({
  sites,
  client,
  onClose,
}: {
  sites: SiteOption[];
  client?: ClientInitial;
  onClose: () => void;
}) {
  const [state, formAction] = useActionState(
    client ? upravitKlienta : vytvoritKlienta,
    EMPTY,
  );
  const [role, setRole] = useState(client?.role ?? "viewer");

  if (state.ok) return null;

  // React 19 po server akci nekontrolovaná pole vynuluje, takže se
  // předvyplňují z hodnot, které akce vrátila zpět. Heslo mezi nimi
  // schválně není — nemá se vracet do HTML stránky.
  const keep = <T,>(name: string, fallback: T) => {
    const sent = state.values?.[name];
    return typeof sent === "string" ? sent : fallback;
  };

  const keptSites = state.values?.site_ids;
  const checkedSites = new Set(
    Array.isArray(keptSites)
      ? keptSites
      : typeof keptSites === "string"
        ? [keptSites]
        : (client?.site_ids ?? []),
  );

  const e = state.errors;
  // Administrátor vidí všechno přes is_admin(), granty pro něj nic
  // neznamenají — nabízet je by bylo matoucí.
  const grantyPlati = role !== "admin";

  return (
    <FormDialog
      title={client ? "Upravit klienta" : "Nový klient"}
      open
      onClose={onClose}
    >
      <form key={state.attempt} action={formAction} className="space-y-4">
        {client ? <input type="hidden" name="id" value={client.id} /> : null}
        <FormError error={e._form} />

        <TextField
          label="E-mail"
          name="email"
          type="email"
          error={e.email}
          defaultValue={keep("email", client?.email ?? "")}
          required
          hint="Slouží zároveň jako přihlašovací jméno."
        />

        {client ? null : (
          <TextField
            label="Heslo"
            name="password"
            type="password"
            error={e.password}
            required
            hint={`Aspoň ${MIN_PASSWORD_LENGTH} znaků. Předejte ho klientovi bezpečnou cestou, do portálu se už nikdy nezobrazí.`}
          />
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          <TextField
            label="Jméno"
            name="full_name"
            error={e.full_name}
            defaultValue={keep("full_name", client?.full_name ?? "")}
          />
          <TextField
            label="Firma"
            name="company_name"
            error={e.company_name}
            defaultValue={keep("company_name", client?.company_name ?? "")}
          />
        </div>

        <SelectField
          label="Role"
          name="role"
          error={e.role}
          value={role}
          onChange={setRole}
          options={USER_ROLES.map((r) => ({
            value: r,
            label: USER_ROLE_LABELS[r],
          }))}
          hint="Klient je „Klient“. Operátor navíc vidí ladicí údaje, administrátor všechno."
        />

        <LogoField error={e.logo} />

        <fieldset>
          <legend className="mb-2 block text-[11px] font-medium uppercase tracking-[0.12em] text-[var(--text-muted)]">
            Přístup k lokalitám
          </legend>

          {!grantyPlati ? (
            <p className="text-sm text-[var(--text-muted)]">
              Administrátor vidí všechny lokality bez ohledu na granty.
            </p>
          ) : sites.length === 0 ? (
            <p className="text-sm text-[var(--text-muted)]">
              Zatím není žádná lokalita, kterou by šlo přidělit.
            </p>
          ) : (
            <div className="border border-[var(--line-strong)]">
              {sites.map((site) => (
                <label
                  key={site.id}
                  className="flex cursor-pointer items-center gap-3 border-b border-[var(--line)] px-3.5 py-2.5 text-sm last:border-b-0 hover:bg-[var(--surface-2)]"
                >
                  <input
                    type="checkbox"
                    name="site_ids"
                    value={site.id}
                    defaultChecked={checkedSites.has(site.id)}
                    className="h-4 w-4 border-[var(--line-strong)] bg-[var(--surface-2)] accent-[var(--accent-bright)]"
                  />
                  {site.name}
                </label>
              ))}
            </div>
          )}

          {e.site_ids ? (
            <p className="mt-1 text-xs text-[var(--danger)]">{e.site_ids}</p>
          ) : (
            <p className="mt-1.5 text-xs text-[var(--text-muted)]">
              Bez jediné lokality klient portál otevře a neuvidí v něm nic.
            </p>
          )}
        </fieldset>

        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Zrušit
          </Button>
          <SubmitButton>{client ? "Uložit" : "Založit"}</SubmitButton>
        </div>
      </form>
    </FormDialog>
  );
}

/** Výběr souboru s logem. Nahrává se až s odesláním formuláře. */
function LogoField({ error }: { error?: string }) {
  const [nazev, setNazev] = useState<string | null>(null);

  return (
    <div>
      <label
        htmlFor="logo"
        className="mb-2 block text-[11px] font-medium uppercase tracking-[0.12em] text-[var(--text-muted)]"
      >
        Logo
      </label>
      <input
        id="logo"
        name="logo"
        type="file"
        accept="image/png,image/jpeg,image/webp,image/svg+xml"
        onChange={(event) => setNazev(event.target.files?.[0]?.name ?? null)}
        aria-invalid={Boolean(error)}
        className="w-full border border-[var(--line-strong)] bg-[var(--surface-2)] px-3.5 py-2.5 text-sm file:mr-3 file:border-0 file:bg-[var(--surface-3)] file:px-3 file:py-1.5 file:text-sm file:text-[var(--text)] aria-[invalid=true]:border-[var(--danger)]"
      />
      {error ? (
        <p className="mt-1 text-xs text-[var(--danger)]">{error}</p>
      ) : (
        <p className="mt-1 text-xs text-[var(--text-muted)]">
          PNG, JPEG, WebP nebo SVG do 2 MB.
          {nazev ? ` Vybráno: ${nazev}` : " Beze změny zůstane stávající."}
        </p>
      )}
    </div>
  );
}

// ── Heslo ────────────────────────────────────────────────────────

export function PasswordForm({ client }: { client: ClientInitial }) {
  const [session, setSession] = useState(0);
  const [open, setOpen] = useState(false);

  return (
    <>
      <IconButton
        onClick={() => {
          setSession((value) => value + 1);
          setOpen(true);
        }}
        label={`Změnit heslo klientovi ${client.email ?? ""}`}
      >
        <KeyRound className="h-4 w-4" aria-hidden="true" />
      </IconButton>

      {open ? (
        <PasswordDialog
          key={session}
          client={client}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

function PasswordDialog({
  client,
  onClose,
}: {
  client: ClientInitial;
  onClose: () => void;
}) {
  const [state, formAction] = useActionState(zmenitHeslo, EMPTY);
  if (state.ok) return null;

  return (
    <FormDialog title="Změna hesla" open onClose={onClose}>
      <form key={state.attempt} action={formAction} className="space-y-4">
        <input type="hidden" name="id" value={client.id} />
        <FormError error={state.errors._form} />

        <p className="text-sm text-[var(--text-muted)]">
          Nové heslo pro <span className="text-[var(--text)]">{client.email}</span>.
          Klient o změně nedostane zprávu — předejte mu ho sami.
        </p>

        <TextField
          label="Nové heslo"
          name="new_password"
          type="password"
          error={state.errors.new_password}
          required
          hint={`Aspoň ${MIN_PASSWORD_LENGTH} znaků. Po uložení už ho portál nezobrazí.`}
        />

        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Zrušit
          </Button>
          <SubmitButton>Změnit heslo</SubmitButton>
        </div>
      </form>
    </FormDialog>
  );
}

// ── Zablokování ──────────────────────────────────────────────────

export function AccessToggle({ client }: { client: ClientInitial }) {
  const [state, formAction] = useActionState(prepnoutPristup, EMPTY);

  return (
    <form action={formAction} className="inline">
      <input type="hidden" name="id" value={client.id} />
      <input type="hidden" name="blokovat" value={client.blocked ? "0" : "1"} />
      <IconButton
        type="submit"
        label={
          client.blocked
            ? `Obnovit přístup klientovi ${client.email ?? ""}`
            : `Zablokovat přístup klientovi ${client.email ?? ""}`
        }
        title={state.errors._form}
      >
        {client.blocked ? (
          <ShieldCheck className="h-4 w-4 text-[var(--success)]" aria-hidden="true" />
        ) : (
          <ShieldOff className="h-4 w-4" aria-hidden="true" />
        )}
      </IconButton>
    </form>
  );
}

function IconButton({
  children,
  label,
  onClick,
  type = "button",
  title,
}: {
  children: React.ReactNode;
  label: string;
  onClick?: () => void;
  type?: "button" | "submit";
  title?: string;
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      aria-label={label}
      title={title ?? label}
      className="inline-flex h-9 w-9 shrink-0 items-center justify-center border border-transparent text-[var(--text-muted)] transition hover:border-[var(--line-strong)] hover:bg-[var(--surface-2)] hover:text-[var(--text)]"
    >
      {children}
    </button>
  );
}
