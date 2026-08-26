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
import type { Wayline } from "@/lib/dispatch/flighthub.ts";
import type { SiteOption } from "@/lib/site.ts";

import { saveZone } from "@/app/(app)/entity-actions.ts";
import { nacistTrasy } from "@/app/(app)/wayline-actions.ts";

export interface ZoneInitial {
  id: string;
  site_id: string;
  name: string;
  latitude: number | null;
  longitude: number | null;
  wayline_uuid: string | null;
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
  // Trasy se tahají až při otevření, ne při renderu stránky — je to
  // volání do FlightHubu, které by jinak zdržovalo každé zobrazení
  // /zony. Stejný vzor jako u hlídek.
  const [waylines, setWaylines] = useState<Wayline[] | null>(null);
  const [waylineError, setWaylineError] = useState<string | null>(null);

  const show = () => {
    setSession((value) => value + 1);
    setOpen(true);
    if (waylines === null && waylineError === null) {
      void nacistTrasy().then((result) => {
        if (result.ok) setWaylines(result.waylines);
        else setWaylineError(result.message);
      });
    }
  };

  return (
    <>
      {zone ? (
        <button
          type="button"
          onClick={show}
          aria-label={`Upravit zónu ${zone.name}`}
          className="inline-flex h-9 w-9 shrink-0 items-center justify-center border border-transparent text-[var(--text-muted)] transition hover:border-[var(--line-strong)] hover:bg-[var(--surface-2)] hover:text-[var(--text)]"
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
          waylines={waylines}
          waylineError={waylineError}
          waylinesLoading={waylines === null && waylineError === null}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

function ZoneDialog({
  sites,
  zone,
  waylines,
  waylineError,
  waylinesLoading,
  onClose,
}: {
  sites: SiteOption[];
  zone?: ZoneInitial;
  waylines: Wayline[] | null;
  waylineError: string | null;
  waylinesLoading: boolean;
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

  // Trasa uložená u zóny nemusí být v seznamu z FlightHubu — mohla být
  // přejmenovaná nebo smazaná. Ať ji formulář neztratí.
  const options = (waylines ?? []).map((w) => ({ value: w.uuid, label: w.name }));
  const current = zone?.wayline_uuid;
  if (current && !options.some((o) => o.value === current)) {
    options.unshift({ value: current, label: `${current} (mimo seznam)` });
  }

  return (
    <FormDialog title={zone ? "Upravit zónu" : "Nová zóna"} open onClose={onClose}>
      <form key={state.attempt} action={formAction} className="space-y-4">
        {zone ? <input type="hidden" name="id" value={zone.id} /> : null}
        <FormError error={e._form} />
        {waylineError ? (
          <FormError error={`Trasy z FlightHubu se nepodařilo načíst: ${waylineError}`} />
        ) : null}

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

        {/* Trasa, ne souřadnice, určuje kudy dron letí: zásah se
            zakládá jako plánovaná úloha a ta chce wayline. Souřadnice
            výš zůstávají kvůli mapě a detailu zásahu. */}
        <SelectField
          label="Trasa zásahu"
          name="wayline_uuid"
          error={e.wayline_uuid}
          defaultValue={keep("wayline_uuid", zone?.wayline_uuid ?? "")}
          placeholder={
            waylinesLoading
              ? "Načítají se trasy…"
              : options.length
                ? "Bez trasy — zásah neodejde"
                : "Žádné trasy z FlightHubu"
          }
          options={options}
          hint="Po téhle trase dron k zóně letí. Bez ní se zásah nezaloží."
        />

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
