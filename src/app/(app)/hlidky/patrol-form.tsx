"use client";

import { Pencil, Plus } from "lucide-react";
import { useActionState, useState } from "react";

import {
  CheckboxField,
  EMPTY_FORM_STATE,
  FormDialog,
  FormError,
  SelectField,
  SubmitButton,
  TextField,
  WeekdayField,
} from "@/components/form.tsx";
import { Button } from "@/components/ui.tsx";
import type { Wayline } from "@/lib/dispatch/flighthub.ts";
import type { SiteOption } from "@/lib/site.ts";

import { savePatrol } from "../entity-actions.ts";

export interface PatrolInitial {
  id: string;
  site_id: string;
  name: string;
  wayline_uuid: string;
  enabled: boolean;
  window_from: string;
  window_to: string;
  days: number[];
  interval_minutes: number;
}

function toTimeInput(value: string): string {
  return value.slice(0, 5);
}

export function PatrolForm({
  sites,
  waylines,
  waylineError,
  patrol,
}: {
  sites: SiteOption[];
  waylines: Wayline[];
  waylineError: string | null;
  patrol?: PatrolInitial;
}) {
  const [session, setSession] = useState(0);
  const [open, setOpen] = useState(false);
  const show = () => {
    setSession((value) => value + 1);
    setOpen(true);
  };

  return (
    <>
      {patrol ? (
        <button
          type="button"
          onClick={show}
          aria-label={`Upravit hlídku ${patrol.name}`}
          className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-[var(--text-muted)] transition hover:bg-[var(--surface-2)] hover:text-[var(--text)]"
        >
          <Pencil className="h-4 w-4" aria-hidden="true" />
        </button>
      ) : (
        <Button type="button" onClick={show} disabled={sites.length === 0}>
          <Plus className="h-4 w-4" aria-hidden="true" />
          Přidat hlídku
        </Button>
      )}

      {open ? (
        <PatrolDialog
          key={session}
          sites={sites}
          waylines={waylines}
          waylineError={waylineError}
          patrol={patrol}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

function PatrolDialog({
  sites,
  waylines,
  waylineError,
  patrol,
  onClose,
}: {
  sites: SiteOption[];
  waylines: Wayline[];
  waylineError: string | null;
  patrol?: PatrolInitial;
  onClose: () => void;
}) {
  const [state, formAction] = useActionState(savePatrol, EMPTY_FORM_STATE);
  if (state.ok) return null;

  const keep = <T,>(name: string, fallback: T) => {
    const sent = state.values?.[name];
    return typeof sent === "string" ? sent : fallback;
  };
  const keepDays = (fallback: number[]) => {
    const sent = state.values?.days;
    if (sent === undefined) return fallback;
    return (Array.isArray(sent) ? sent : [sent]).map(Number);
  };
  const keepChecked = (name: string, fallback: boolean) =>
    state.values === undefined ? fallback : state.values[name] !== undefined;

  const e = state.errors;

  // Trasa uložená u hlídky nemusí být v seznamu z FlightHubu — mohla
  // být přejmenovaná nebo smazaná. Ať ji formulář neztratí.
  const options = waylines.map((w) => ({ value: w.uuid, label: w.name }));
  const current = patrol?.wayline_uuid;
  if (current && !options.some((o) => o.value === current)) {
    options.unshift({ value: current, label: `${current} (mimo seznam)` });
  }

  return (
    <FormDialog
      title={patrol ? "Upravit hlídku" : "Nová hlídka"}
      open
      onClose={onClose}
    >
      <form key={state.attempt} action={formAction} className="space-y-4">
        {patrol ? <input type="hidden" name="id" value={patrol.id} /> : null}
        <FormError error={e._form} />
        {waylineError ? <FormError error={`Trasy z FlightHubu se nepodařilo načíst: ${waylineError}`} /> : null}

        <SelectField
          label="Lokalita"
          name="site_id"
          error={e.site_id}
          defaultValue={keep("site_id", patrol?.site_id)}
          placeholder="Vyberte lokalitu"
          options={sites.map((site) => ({ value: site.id, label: site.name }))}
        />
        <TextField
          label="Název"
          name="name"
          error={e.name}
          defaultValue={keep("name", patrol?.name)}
          required
        />
        <SelectField
          label="Trasa"
          name="wayline_uuid"
          error={e.wayline_uuid}
          defaultValue={keep("wayline_uuid", patrol?.wayline_uuid ?? "")}
          placeholder={options.length ? "Vyberte trasu" : "Žádné trasy z FlightHubu"}
          options={options}
          hint="Načteno z FlightHubu."
        />

        <div className="grid grid-cols-2 gap-3">
          <TextField
            label="Létat od"
            name="window_from"
            type="time"
            error={e.window_from}
            defaultValue={keep("window_from", toTimeInput(patrol?.window_from ?? "08:00:00"))}
            required
          />
          <TextField
            label="Létat do"
            name="window_to"
            type="time"
            error={e.window_to}
            defaultValue={keep("window_to", toTimeInput(patrol?.window_to ?? "18:00:00"))}
            required
          />
        </div>

        <WeekdayField
          name="days"
          error={e.days}
          defaultValue={keepDays(patrol?.days ?? [1, 2, 3, 4, 5])}
        />

        <IntervalField
          error={e.interval_minutes}
          defaultValue={String(keep("interval_minutes", patrol?.interval_minutes ?? 60))}
        />

        <CheckboxField
          label="Hlídka je zapnutá"
          name="enabled"
          defaultChecked={keepChecked("enabled", patrol?.enabled ?? true)}
          hint="Vypnutá se neplánuje — místo mazání."
        />

        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Zrušit
          </Button>
          <SubmitButton>{patrol ? "Uložit" : "Vytvořit"}</SubmitButton>
        </div>
      </form>
    </FormDialog>
  );
}

/** Pod touhle hranicí se dron nestihne mezi lety dobít. */
const CHARGE_WARNING_MINUTES = 45;

/**
 * Interval s varováním u krátkých hodnot. Není to chyba — hlídku po
 * 30 minutách si někdo nastavit může, jen se dron nemusí stihnout
 * nabít a cron ho pak pro nízkou baterii přeskočí.
 */
function IntervalField({
  error,
  defaultValue,
}: {
  error?: string;
  defaultValue: string;
}) {
  const [value, setValue] = useState(defaultValue);
  const minutes = Number.parseInt(value, 10);
  const tooShort =
    Number.isFinite(minutes) && minutes > 0 && minutes < CHARGE_WARNING_MINUTES;

  return (
    <div>
      <TextField
        label="Interval mezi starty (min)"
        name="interval_minutes"
        type="number"
        inputMode="numeric"
        error={error}
        defaultValue={value}
        onChange={setValue}
        hint={error ? undefined : "Časy se počítají v časovém pásmu lokality."}
        required
      />
      {tooShort ? (
        <p className="mt-1 rounded-lg border border-[var(--warning)]/40 bg-[var(--warning)]/10 px-3 py-2 text-xs text-[var(--warning)]">
          Kratší odstup než {CHARGE_WARNING_MINUTES} minut nemusí stačit na
          nabití dronu. Hlídka se uloží, ale cron ji při nízké baterii
          přeskočí.
        </p>
      ) : null}
    </div>
  );
}
