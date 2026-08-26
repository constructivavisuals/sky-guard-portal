"use client";

import { Pencil, Plus } from "lucide-react";
import { useActionState, useState } from "react";

import {
  EMPTY_FORM_STATE,
  FormDialog,
  FormError,
  SelectField,
  SubmitButton,
  TextField,
  WeekdayField,
} from "@/components/form.tsx";
import { Button } from "@/components/ui.tsx";

import { saveSite } from "@/app/(app)/entity-actions.ts";

export interface SiteInitial {
  id: string;
  name: string;
  address: string | null;
  timezone: string;
  armed_from: string;
  armed_to: string;
  armed_days: number[];
  cooldown_seconds: number;
  retention_days: number;
  dock_sn: string | null;
  drone_sn: string | null;
  fh_project_uuid: string | null;
  fh_workflow_uuid: string | null;
}

/** `18:00:00` → `18:00`, což čeká <input type="time">. */
function toTimeInput(value: string): string {
  return value.slice(0, 5);
}

export function SiteForm({ site }: { site?: SiteInitial }) {
  const [session, setSession] = useState(0);
  const [open, setOpen] = useState(false);

  // Nové sezení při každém otevření: dialog si tím vynutí čerstvý stav
  // akce, takže po předchozím uložení jde formulář otevřít znovu.
  const show = () => {
    setSession((value) => value + 1);
    setOpen(true);
  };

  return (
    <>
      {site ? (
        <button
          type="button"
          onClick={show}
          aria-label={`Upravit lokalitu ${site.name}`}
          className="inline-flex h-9 w-9 shrink-0 items-center justify-center border border-transparent text-[var(--text-muted)] transition hover:border-[var(--line-strong)] hover:bg-[var(--surface-2)] hover:text-[var(--text)]"
        >
          <Pencil className="h-4 w-4" aria-hidden="true" />
        </button>
      ) : (
        <Button type="button" onClick={show}>
          <Plus className="h-4 w-4" aria-hidden="true" />
          Přidat lokalitu
        </Button>
      )}

      {open ? (
        <SiteDialog key={session} site={site} onClose={() => setOpen(false)} />
      ) : null}
    </>
  );
}

function SiteDialog({
  site,
  onClose,
}: {
  site?: SiteInitial;
  onClose: () => void;
}) {
  const [state, formAction] = useActionState(saveSite, EMPTY_FORM_STATE);

  // Uloženo — dialog zmizí. Řeší se návratem null při vykreslení, ne
  // efektem, který by dělal kaskádový render.
  if (state.ok) return null;


  // React 19 po server akci nekontrolovaná pole vynuluje, takže se
  // předvyplňují z hodnot, které akce vrátila zpět.
  const keep = <T,>(name: string, fallback: T) => {
    const sent = state.values?.[name];
    return typeof sent === "string" ? sent : fallback;
  };
  const keepDays = (fallback: number[]) => {
    const sent = state.values?.armed_days;
    if (sent === undefined) return fallback;
    return (Array.isArray(sent) ? sent : [sent]).map(Number);
  };

  const e = state.errors;
  const zones = Intl.supportedValuesOf("timeZone");

  return (
    <FormDialog
      title={site ? "Upravit lokalitu" : "Nová lokalita"}
      open
      onClose={onClose}
    >
      <form key={state.attempt} action={formAction} className="space-y-4">
        {site ? <input type="hidden" name="id" value={site.id} /> : null}
        <FormError error={e._form} />

        <TextField
          label="Název"
          name="name"
          error={e.name}
          defaultValue={keep("name", site?.name)}
          required
        />
        <TextField
          label="Adresa"
          name="address"
          error={e.address}
          defaultValue={keep("address", site?.address)}
          placeholder="Volitelné"
        />
        <SelectField
          label="Časové pásmo"
          name="timezone"
          error={e.timezone}
          defaultValue={keep("timezone", site?.timezone ?? "Europe/Prague")}
          options={zones.map((zone) => ({ value: zone, label: zone }))}
          hint="Podle něj se vyhodnocuje okno střežení."
        />

        <div className="grid grid-cols-2 gap-3">
          <TextField
            label="Střeženo od"
            name="armed_from"
            type="time"
            error={e.armed_from}
            defaultValue={keep("armed_from", toTimeInput(site?.armed_from ?? "18:00:00"))}
            required
          />
          <TextField
            label="Střeženo do"
            name="armed_to"
            type="time"
            error={e.armed_to}
            defaultValue={keep("armed_to", toTimeInput(site?.armed_to ?? "06:00:00"))}
            required
          />
        </div>

        <WeekdayField
          name="armed_days"
          error={e.armed_days}
          defaultValue={keepDays(site?.armed_days ?? [1, 2, 3, 4, 5, 6, 7])}
        />

        <TextField
          label="Cooldown mezi zásahy (s)"
          name="cooldown_seconds"
          type="number"
          inputMode="numeric"
          error={e.cooldown_seconds}
          defaultValue={keep("cooldown_seconds", site?.cooldown_seconds ?? 900)}
          hint="Kratší odstup detekce potlačí."
          required
        />

        <TextField
          label="Retence záznamů (dny)"
          name="retention_days"
          type="number"
          inputMode="numeric"
          error={e.retention_days}
          defaultValue={keep("retention_days", site?.retention_days ?? 90)}
          hint="Po téhle době se z úložiště mažou snímky a záznamy z letů. Řádky zůstávají — mizí jen soubory."
          required
        />

        <div className="grid grid-cols-2 gap-3">
          <TextField label="Sériové číslo docku" name="dock_sn" error={e.dock_sn} defaultValue={keep("dock_sn", site?.dock_sn)} />
          <TextField label="Sériové číslo dronu" name="drone_sn" error={e.drone_sn} defaultValue={keep("drone_sn", site?.drone_sn)} />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <TextField label="FlightHub projekt" name="fh_project_uuid" error={e.fh_project_uuid} defaultValue={keep("fh_project_uuid", site?.fh_project_uuid)} />
          <TextField label="FlightHub workflow" name="fh_workflow_uuid" error={e.fh_workflow_uuid} defaultValue={keep("fh_workflow_uuid", site?.fh_workflow_uuid)} />
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Zrušit
          </Button>
          <SubmitButton>{site ? "Uložit" : "Vytvořit"}</SubmitButton>
        </div>
      </form>
    </FormDialog>
  );
}
