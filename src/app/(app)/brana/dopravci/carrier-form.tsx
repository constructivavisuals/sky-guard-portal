"use client";

import { useActionState, useState } from "react";
import { Check, Copy, Plus } from "lucide-react";

import {
  FormDialog,
  FormError,
  SelectField,
  SubmitButton,
  TextField,
} from "@/components/form.tsx";
import { Button } from "@/components/ui.tsx";
import type { SiteOption } from "@/lib/site.ts";

import { prepnoutDopravce, zalozitDopravce, type CarrierActionState } from "./actions.ts";

const PRAZDNY: CarrierActionState = { ok: false };

export function CarrierForm({ sites }: { sites: SiteOption[] }) {
  const [session, setSession] = useState(0);
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button
        type="button"
        onClick={() => {
          setSession((value) => value + 1);
          setOpen(true);
        }}
        disabled={sites.length === 0}
      >
        <Plus className="h-4 w-4" aria-hidden="true" />
        Přidat dopravce
      </Button>

      {open ? (
        <CarrierDialog key={session} sites={sites} onClose={() => setOpen(false)} />
      ) : null}
    </>
  );
}

function CarrierDialog({
  sites,
  onClose,
}: {
  sites: SiteOption[];
  onClose: () => void;
}) {
  const [state, formAction] = useActionState(zalozitDopravce, PRAZDNY);
  if (state.ok) return null;

  const keep = (name: string) => state.values?.[name] ?? "";

  return (
    <FormDialog title="Nový dopravce" open onClose={onClose}>
      <form action={formAction} className="space-y-4">
        <FormError error={state.error} />

        <SelectField
          label="Lokalita"
          name="site_id"
          defaultValue={keep("site_id")}
          placeholder="Vyberte lokalitu"
          options={sites.map((site) => ({ value: site.id, label: site.name }))}
          hint="Dopravce bude moci ohlašovat příjezdy jen sem."
        />
        <TextField label="Název firmy" name="name" defaultValue={keep("name")} required />
        <TextField
          label="Kontakt"
          name="contact"
          defaultValue={keep("contact")}
          hint="Telefon nebo e-mail dispečinku. Nepovinné."
        />
        <TextField
          label="Platnost do"
          name="valid_until"
          type="date"
          defaultValue={keep("valid_until")}
          hint="Po tomhle dni odkaz přestane fungovat. Prázdné = bez omezení."
        />

        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Zrušit
          </Button>
          <SubmitButton>Vytvořit</SubmitButton>
        </div>
      </form>
    </FormDialog>
  );
}

/**
 * Zkopírování odkazu.
 *
 * Adresa se skládá až v prohlížeči z window.location.origin — server
 * svou veřejnou doménu spolehlivě nezná (za proxy vidí vnitřní jméno)
 * a odkaz s vnitřní adresou by dopravci nefungoval.
 */
export function CopyLink({ token }: { token: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <button
      type="button"
      onClick={async () => {
        const url = `${window.location.origin}/prijezd/${token}`;
        try {
          await navigator.clipboard.writeText(url);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 2000);
        } catch {
          // Bez schránky (staré prohlížeče, http mimo localhost) aspoň
          // ukázat adresu, ať se dá vybrat ručně.
          window.prompt("Zkopírujte odkaz:", url);
        }
      }}
      className="inline-flex h-9 items-center gap-1.5 rounded-[var(--radius-pill)] border border-[var(--line-strong)] px-3 text-xs font-medium text-[var(--text-muted)] transition hover:border-[var(--accent-bright)] hover:text-[var(--accent-bright)]"
    >
      {copied ? (
        <>
          <Check className="h-3.5 w-3.5" aria-hidden="true" />
          Zkopírováno
        </>
      ) : (
        <>
          <Copy className="h-3.5 w-3.5" aria-hidden="true" />
          Kopírovat odkaz
        </>
      )}
    </button>
  );
}

export function ToggleCarrier({ id, active }: { id: string; active: boolean }) {
  const [state, formAction] = useActionState(prepnoutDopravce, PRAZDNY);

  return (
    <form action={formAction} className="inline">
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="active" value={active ? "0" : "1"} />
      <button
        type="submit"
        className="h-9 px-3 text-xs font-medium text-[var(--text-muted)] transition hover:text-[var(--text)]"
      >
        {active ? "Deaktivovat" : "Aktivovat"}
      </button>
      {state.error ? (
        <span className="sr-only" role="status">
          {state.error}
        </span>
      ) : null}
    </form>
  );
}
