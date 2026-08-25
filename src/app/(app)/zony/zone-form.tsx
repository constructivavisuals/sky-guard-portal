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
} from "@/components/form.tsx";
import { Button } from "@/components/ui.tsx";
import type { SiteOption } from "@/lib/site.ts";

import { saveZone } from "../entity-actions.ts";

export interface ZoneInitial {
  id: string;
  site_id: string;
  name: string;
  latitude: number | null;
  longitude: number | null;
  default_level: number;
  enabled: boolean;
}

export function ZoneForm({
  sites,
  zone,
}: {
  sites: SiteOption[];
  zone?: ZoneInitial;
}) {
  const [session, setSession] = useState(0);
  const [open, setOpen] = useState(false);
  const show = () => {
    setSession((value) => value + 1);
    setOpen(true);
  };

  return (
    <>
      {zone ? (
        <button
          type="button"
          onClick={show}
          aria-label={`Upravit zónu ${zone.name}`}
          className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-[var(--text-muted)] transition hover:bg-[var(--surface-2)] hover:text-[var(--text)]"
        >
          <Pencil className="h-4 w-4" aria-hidden="true" />
        </button>
      ) : (
        <Button type="button" onClick={show} disabled={sites.length === 0}>
          <Plus className="h-4 w-4" aria-hidden="true" />
          Přidat zónu
        </Button>
      )}

      {open ? (
        <ZoneDialog
          key={session}
          sites={sites}
          zone={zone}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

function ZoneDialog({
  sites,
  zone,
  onClose,
}: {
  sites: SiteOption[];
  zone?: ZoneInitial;
  onClose: () => void;
}) {
  const [state, formAction] = useActionState(saveZone, EMPTY_FORM_STATE);
  if (state.ok) return null;


  // React 19 po server akci nekontrolovaná pole vynuluje, takže se
  // předvyplňují z hodnot, které akce vrátila zpět.
  const keep = <T,>(name: string, fallback: T) => {
    const sent = state.values?.[name];
    return typeof sent === "string" ? sent : fallback;
  };
  const keepChecked = (name: string, fallback: boolean) =>
    state.values === undefined ? fallback : state.values[name] !== undefined;

  const e = state.errors;

  return (
    <FormDialog title={zone ? "Upravit zónu" : "Nová zóna"} open onClose={onClose}>
      <form key={state.attempt} action={formAction} className="space-y-4">
        {zone ? <input type="hidden" name="id" value={zone.id} /> : null}
        <FormError error={e._form} />

        <SelectField
          label="Lokalita"
          name="site_id"
          error={e.site_id}
          defaultValue={keep("site_id", zone?.site_id)}
          placeholder="Vyberte lokalitu"
          options={sites.map((site) => ({ value: site.id, label: site.name }))}
        />
        <TextField label="Název" name="name" error={e.name} defaultValue={keep("name", zone?.name)} required />

        {/* Šířka a délka vedle sebe, WGS84. Mapa zatím není, takže
            aspoň nápověda, v jakém tvaru se čísla čekají. */}
        <div className="grid grid-cols-2 gap-3">
          <TextField
            label="Zeměpisná šířka"
            name="latitude"
            error={e.latitude}
            inputMode="decimal"
            defaultValue={keep("latitude", zone?.latitude ?? "")}
            placeholder="50.0755"
            hint="−90 až 90"
            required
          />
          <TextField
            label="Zeměpisná délka"
            name="longitude"
            error={e.longitude}
            inputMode="decimal"
            defaultValue={keep("longitude", zone?.longitude ?? "")}
            placeholder="14.4378"
            hint="−180 až 180"
            required
          />
        </div>

        <SelectField
          label="Výchozí úroveň"
          name="default_level"
          error={e.default_level}
          defaultValue={keep("default_level", String(zone?.default_level ?? 1))}
          options={[1, 2, 3, 4, 5].map((level) => ({
            value: String(level),
            label: String(level),
          }))}
          hint="Stupeň zásahu předaný do FlightHubu."
        />

        <CheckboxField
          label="Zóna je zapnutá"
          name="enabled"
          defaultChecked={keepChecked("enabled", zone?.enabled ?? true)}
          hint="Vypnutá zóna se chová, jako by lokalita nestřežila — místo mazání."
        />

        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Zrušit
          </Button>
          <SubmitButton>{zone ? "Uložit" : "Vytvořit"}</SubmitButton>
        </div>
      </form>
    </FormDialog>
  );
}
