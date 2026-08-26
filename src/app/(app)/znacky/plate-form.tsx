"use client";

import { Pencil, Plus, Trash2 } from "lucide-react";
import { useActionState, useState } from "react";

import {
  EMPTY_FORM_STATE,
  FormDialog,
  FormError,
  SelectField,
  SubmitButton,
  TextField,
} from "@/components/form.tsx";
import { Button } from "@/components/ui.tsx";
import type { SiteOption } from "@/lib/site.ts";
import { PLATE_LIST_TYPES, PLATE_LIST_TYPE_LABELS } from "@/types/database.ts";

import { deleteKnownPlate, saveKnownPlate } from "../entity-actions.ts";

export interface PlateInitial {
  id: string;
  site_id: string;
  plate: string;
  label: string | null;
  list_type: string;
  note: string | null;
}

export function PlateForm({
  sites,
  plate,
}: {
  sites: SiteOption[];
  plate?: PlateInitial;
}) {
  const [session, setSession] = useState(0);
  const [open, setOpen] = useState(false);
  const show = () => {
    setSession((value) => value + 1);
    setOpen(true);
  };

  return (
    <>
      {plate ? (
        <button
          type="button"
          onClick={show}
          aria-label={`Upravit značku ${plate.plate}`}
          className="inline-flex h-9 w-9 shrink-0 items-center justify-center border border-transparent text-[var(--text-muted)] transition hover:border-[var(--line-strong)] hover:bg-[var(--surface-2)] hover:text-[var(--text)]"
        >
          <Pencil className="h-4 w-4" aria-hidden="true" />
        </button>
      ) : (
        <Button type="button" onClick={show} disabled={sites.length === 0}>
          <Plus className="h-4 w-4" aria-hidden="true" />
          Přidat značku
        </Button>
      )}

      {open ? (
        <PlateDialog
          key={session}
          sites={sites}
          plate={plate}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

function PlateDialog({
  sites,
  plate,
  onClose,
}: {
  sites: SiteOption[];
  plate?: PlateInitial;
  onClose: () => void;
}) {
  const [state, formAction] = useActionState(saveKnownPlate, EMPTY_FORM_STATE);
  const [listType, setListType] = useState(plate?.list_type ?? "allow");

  if (state.ok) return null;

  const keep = <T,>(name: string, fallback: T) => {
    const sent = state.values?.[name];
    return typeof sent === "string" ? sent : fallback;
  };

  const e = state.errors;

  return (
    <FormDialog
      title={plate ? "Upravit značku" : "Nová značka"}
      open
      onClose={onClose}
    >
      <form key={state.attempt} action={formAction} className="space-y-4">
        {plate ? <input type="hidden" name="id" value={plate.id} /> : null}
        <FormError error={e._form} />

        <SelectField
          label="Lokalita"
          name="site_id"
          error={e.site_id}
          defaultValue={keep("site_id", plate?.site_id ?? "")}
          placeholder="Vyberte lokalitu"
          options={sites.map((site) => ({ value: site.id, label: site.name }))}
          hint="Seznam platí vždy jen pro jeden areál."
        />

        <TextField
          label="Značka"
          name="plate"
          error={e.plate}
          defaultValue={keep("plate", plate?.plate ?? "")}
          placeholder="1AB 2345"
          required
          hint="Zapište ji, jak chcete — mezery a pomlčky se při porovnávání ignorují."
        />

        <SelectField
          label="Seznam"
          name="list_type"
          error={e.list_type}
          value={listType}
          onChange={setListType}
          options={PLATE_LIST_TYPES.map((t) => ({
            value: t,
            label: PLATE_LIST_TYPE_LABELS[t],
          }))}
        />

        <p className="border border-[var(--line-strong)] bg-[var(--surface-2)] px-3.5 py-3 text-xs leading-relaxed text-[var(--text-muted)]">
          {listType === "deny"
            ? "Nežádoucí vozidlo v době střežení zvedne zásah na stupeň jako u osoby."
            : "Známé vozidlo zásah nespouští. Dron ale i tak vzlétne, protože v okamžiku příjezdu značku ještě nikdo nepřečetl — v evidenci pak bude vidět, že šlo o známé auto."}
        </p>

        <TextField
          label="Popisek"
          name="label"
          error={e.label}
          defaultValue={keep("label", plate?.label ?? "")}
          placeholder="Dodávka stavby"
          hint="Ukáže se u vjezdu místo holé značky."
        />

        <TextField
          label="Poznámka"
          name="note"
          error={e.note}
          defaultValue={keep("note", plate?.note ?? "")}
        />

        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Zrušit
          </Button>
          <SubmitButton>{plate ? "Uložit" : "Přidat"}</SubmitButton>
        </div>
      </form>
    </FormDialog>
  );
}

/**
 * Odebrání značky.
 *
 * Mazat se tu smí, na rozdíl od detekcí a vjezdů: je to konfigurace,
 * ne důkaz, a odebrání zachytí audit trigger.
 */
export function PlateDelete({ plate }: { plate: PlateInitial }) {
  const [state, formAction] = useActionState(deleteKnownPlate, EMPTY_FORM_STATE);
  const [confirming, setConfirming] = useState(false);

  if (!confirming) {
    return (
      <button
        type="button"
        onClick={() => setConfirming(true)}
        aria-label={`Odebrat značku ${plate.plate}`}
        title={state.errors._form}
        className="inline-flex h-9 w-9 shrink-0 items-center justify-center border border-transparent text-[var(--text-muted)] transition hover:border-[var(--line-strong)] hover:bg-[var(--surface-2)] hover:text-[var(--danger)]"
      >
        <Trash2 className="h-4 w-4" aria-hidden="true" />
      </button>
    );
  }

  return (
    <form action={formAction} className="inline-flex items-center gap-1">
      <input type="hidden" name="id" value={plate.id} />
      <button
        type="submit"
        className="inline-flex h-9 items-center rounded-[var(--radius-pill)] bg-[var(--danger)] px-3 text-[11px] font-medium uppercase tracking-[0.08em] text-white"
      >
        Odebrat
      </button>
      <button
        type="button"
        onClick={() => setConfirming(false)}
        className="inline-flex h-9 items-center px-2 text-[11px] uppercase tracking-[0.08em] text-[var(--text-muted)] hover:text-[var(--text)]"
      >
        Zpět
      </button>
    </form>
  );
}
