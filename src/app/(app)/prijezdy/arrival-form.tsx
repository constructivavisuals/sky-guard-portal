"use client";

import { useActionState, useState } from "react";
import { Plus, X } from "lucide-react";

import {
  FormDialog,
  FormError,
  SelectField,
  SubmitButton,
  TextField,
} from "@/components/form.tsx";
import { Button } from "@/components/ui.tsx";

import {
  zalozitOhlaseni,
  zrusitOhlaseniAdmin,
  type ArrivalAdminState,
} from "./actions.ts";

const PRAZDNY: ArrivalAdminState = { ok: false };

export interface CarrierOption {
  id: string;
  name: string;
  siteName: string;
}

export function ArrivalForm({
  carriers,
  today,
  maxDate,
}: {
  carriers: CarrierOption[];
  today: string;
  maxDate: string;
}) {
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
        disabled={carriers.length === 0}
      >
        <Plus className="h-4 w-4" aria-hidden="true" />
        Ohlásit příjezd
      </Button>

      {open ? (
        <ArrivalDialog
          key={session}
          carriers={carriers}
          today={today}
          maxDate={maxDate}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

function ArrivalDialog({
  carriers,
  today,
  maxDate,
  onClose,
}: {
  carriers: CarrierOption[];
  today: string;
  maxDate: string;
  onClose: () => void;
}) {
  const [state, formAction] = useActionState(zalozitOhlaseni, PRAZDNY);
  if (state.ok) return null;

  const keep = (name: string) => state.values?.[name] ?? "";

  return (
    <FormDialog title="Nové ohlášení" open onClose={onClose}>
      <form action={formAction} className="space-y-4">
        <FormError error={state.error} />

        <SelectField
          label="Dopravce"
          name="carrier_id"
          defaultValue={keep("carrier_id")}
          placeholder="Vyberte dopravce"
          options={carriers.map((carrier) => ({
            value: carrier.id,
            label: `${carrier.name} — ${carrier.siteName}`,
          }))}
          hint="Lokalita se bere od dopravce."
        />
        <TextField
          label="Registrační značka"
          name="plate"
          defaultValue={keep("plate")}
          placeholder="1AB 2345"
          required
        />
        <TextField
          label="Datum příjezdu"
          name="arrival_date"
          type="date"
          defaultValue={keep("arrival_date") || today}
          required
        />
        <TextField
          label="Poznámka"
          name="note"
          defaultValue={keep("note")}
          hint="Nepovinné."
        />

        <label className="flex cursor-pointer items-start gap-3 border border-[var(--line)] bg-[var(--surface-2)] p-3.5">
          <input
            type="checkbox"
            name="night_ok"
            defaultChecked={state.values?.night_ok !== undefined}
            className="mt-0.5 h-4 w-4 shrink-0"
          />
          <span className="min-w-0">
            <span className="block text-sm">Přijede i v době střežení</span>
            <span className="mt-1 block text-xs leading-relaxed text-[var(--text-muted)]">
              Bez tohohle platí ohlášení jen mimo ostrý režim a noční příjezd
              zásah nezastaví.
            </span>
          </span>
        </label>

        <input type="hidden" name="max_date" value={maxDate} />

        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Zrušit
          </Button>
          <SubmitButton>Ohlásit</SubmitButton>
        </div>
      </form>
    </FormDialog>
  );
}

export function CancelArrival({ id, plate }: { id: string; plate: string }) {
  const [state, formAction] = useActionState(zrusitOhlaseniAdmin, PRAZDNY);

  return (
    <form action={formAction} className="inline">
      <input type="hidden" name="id" value={id} />
      <button
        type="submit"
        aria-label={`Zrušit ohlášení ${plate}`}
        className="inline-flex h-9 w-9 items-center justify-center border border-transparent text-[var(--text-muted)] transition hover:border-[var(--line-strong)] hover:text-[var(--danger)]"
      >
        <X className="h-4 w-4" aria-hidden="true" />
      </button>
      {state.error ? (
        <span className="sr-only" role="status">
          {state.error}
        </span>
      ) : null}
    </form>
  );
}
