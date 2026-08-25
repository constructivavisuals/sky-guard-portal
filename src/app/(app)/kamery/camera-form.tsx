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
} from "@/components/form.tsx";
import { Button } from "@/components/ui.tsx";
import type { SiteOption } from "@/lib/site.ts";
import { CAMERA_STATUSES, CAMERA_STATUS_LABELS } from "@/types/database.ts";

import { saveCamera } from "../entity-actions.ts";

export interface ZoneChoice {
  id: string;
  name: string;
  site_id: string;
}

export interface CameraInitial {
  id: string;
  site_id: string;
  zone_id: string | null;
  name: string;
  model: string | null;
  serial_number: string | null;
  focal_mm: number | null;
  status: string;
}

export function CameraForm({
  sites,
  zones,
  camera,
}: {
  sites: SiteOption[];
  zones: ZoneChoice[];
  camera?: CameraInitial;
}) {
  const [session, setSession] = useState(0);
  const [open, setOpen] = useState(false);
  const show = () => {
    setSession((value) => value + 1);
    setOpen(true);
  };

  return (
    <>
      {camera ? (
        <button
          type="button"
          onClick={show}
          aria-label={`Upravit kameru ${camera.name}`}
          className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-[var(--text-muted)] transition hover:bg-[var(--surface-2)] hover:text-[var(--text)]"
        >
          <Pencil className="h-4 w-4" aria-hidden="true" />
        </button>
      ) : (
        <Button type="button" onClick={show} disabled={sites.length === 0}>
          <Plus className="h-4 w-4" aria-hidden="true" />
          Přidat kameru
        </Button>
      )}

      {open ? (
        <CameraDialog
          key={session}
          sites={sites}
          zones={zones}
          camera={camera}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

function CameraDialog({
  sites,
  zones,
  camera,
  onClose,
}: {
  sites: SiteOption[];
  zones: ZoneChoice[];
  camera?: CameraInitial;
  onClose: () => void;
}) {
  const [state, formAction] = useActionState(saveCamera, EMPTY_FORM_STATE);
  // Výběr lokality se drží ve stavu, aby šel nabídnout jen její zóny —
  // zóna z cizí lokality by v databázi nedávala smysl.
  const [siteId, setSiteId] = useState(camera?.site_id ?? "");

  if (state.ok) return null;


  // React 19 po server akci nekontrolovaná pole vynuluje, takže se
  // předvyplňují z hodnot, které akce vrátila zpět.
  const keep = <T,>(name: string, fallback: T) => {
    const sent = state.values?.[name];
    return typeof sent === "string" ? sent : fallback;
  };

  const e = state.errors;
  const zonesForSite = zones.filter((zone) => zone.site_id === siteId);

  return (
    <FormDialog
      title={camera ? "Upravit kameru" : "Nová kamera"}
      open
      onClose={onClose}
    >
      <form key={state.attempt} action={formAction} className="space-y-4">
        {camera ? <input type="hidden" name="id" value={camera.id} /> : null}
        <FormError error={e._form} />

        <SelectField
          label="Lokalita"
          name="site_id"
          error={e.site_id}
          value={siteId}
          onChange={setSiteId}
          placeholder="Vyberte lokalitu"
          options={sites.map((site) => ({ value: site.id, label: site.name }))}
        />

        <SelectField
          label="Zóna"
          name="zone_id"
          error={e.zone_id}
          defaultValue={keep("zone_id", camera?.zone_id ?? "")}
          placeholder={siteId ? "Bez zóny" : "Nejdřív vyberte lokalitu"}
          options={zonesForSite.map((zone) => ({ value: zone.id, label: zone.name }))}
          hint="Kamera bez zóny detekuje, ale zásah z ní nevznikne."
        />

        <TextField label="Název" name="name" error={e.name} defaultValue={keep("name", camera?.name)} required />
        <TextField label="Model" name="model" error={e.model} defaultValue={keep("model", camera?.model)} />

        <div className="grid grid-cols-2 gap-3">
          <TextField
            label="Sériové číslo"
            name="serial_number"
            error={e.serial_number}
            defaultValue={keep("serial_number", camera?.serial_number)}
            hint="Podle něj se páruje ingest."
          />
          <TextField
            label="Ohnisko (mm)"
            name="focal_mm"
            error={e.focal_mm}
            inputMode="decimal"
            defaultValue={keep("focal_mm", camera?.focal_mm ?? "")}
            placeholder="2,8"
          />
        </div>

        <SelectField
          label="Stav"
          name="status"
          error={e.status}
          defaultValue={keep("status", camera?.status ?? "offline")}
          options={CAMERA_STATUSES.map((status) => ({
            value: status,
            label: CAMERA_STATUS_LABELS[status],
          }))}
          hint="Vyřazenou kameru nastavte na „Vyřazena“ — mazání schéma neumožňuje."
        />

        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Zrušit
          </Button>
          <SubmitButton>{camera ? "Uložit" : "Vytvořit"}</SubmitButton>
        </div>
      </form>
    </FormDialog>
  );
}
