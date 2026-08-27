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
import { CAMERA_STATUSES, CAMERA_STATUS_LABELS } from "@/types/database.ts";

import { saveCamera } from "@/app/(app)/entity-actions.ts";

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
  lan_ip: string | null;
  mount_description: string | null;
  detects_person: boolean;
  detects_vehicle: boolean;
  reads_plate: boolean;
  focal_mm: number | null;
  latitude: number | null;
  longitude: number | null;
  azimuth: number | null;
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
          className="inline-flex h-9 w-9 shrink-0 items-center justify-center border border-transparent text-[var(--text-muted)] transition hover:border-[var(--line-strong)] hover:bg-[var(--surface-2)] hover:text-[var(--text)]"
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

  // Nezaškrtnutý checkbox se v odeslaných datech vůbec neobjeví, takže
  // se nedá rozlišit „nezaškrtnuto“ od „formulář se ještě neodesílal“
  // podle jediného pole. Rozhoduje proto přítomnost celého snímku:
  // bez něj platí hodnota z databáze, s ním to, co uživatel zaškrtl.
  const keepChecked = (name: string, fallback: boolean) =>
    state.values ? state.values[name] !== undefined : fallback;

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

        <TextField
          label="IP v LAN"
          name="lan_ip"
          error={e.lan_ip}
          inputMode="decimal"
          defaultValue={keep("lan_ip", camera?.lan_ip)}
          placeholder="192.168.1.50"
          hint="Adresa, na které je kamera dostupná v síti areálu. Portál se na ni nepřipojuje, je to údaj pro toho, kdo jede na místo."
        />

        <TextField
          label="Popis umístění"
          name="mount_description"
          error={e.mount_description}
          defaultValue={keep("mount_description", camera?.mount_description)}
          placeholder="Sloup u hlavní brány, 4 m nad vjezdem"
          hint="Kde kamera visí a kam se dívá. Bez toho se detekce těžko zasazuje do místa."
        />

        <div className="grid gap-3 sm:grid-cols-3">
          <TextField
            label="Zeměpisná šířka"
            name="latitude"
            error={e.latitude}
            inputMode="decimal"
            defaultValue={keep("latitude", camera?.latitude ?? "")}
            placeholder="50,329607"
          />
          <TextField
            label="Zeměpisná délka"
            name="longitude"
            error={e.longitude}
            inputMode="decimal"
            defaultValue={keep("longitude", camera?.longitude ?? "")}
            placeholder="15,426257"
          />
          <TextField
            label="Azimut (°)"
            name="azimuth"
            error={e.azimuth}
            inputMode="numeric"
            defaultValue={keep("azimuth", camera?.azimuth ?? "")}
            placeholder="180"
            hint="0 sever, 90 východ."
          />
        </div>
        <p className="text-xs text-[var(--text-muted)]">
          Bez souřadnic se kamera na podkladu areálu nevykreslí, bez azimutu
          jen jako bod bez výseče záběru. Šířka záběru se počítá z ohniska.
        </p>

        <fieldset className="border border-[var(--line)] p-4">
          <legend className="px-2 text-[11px] font-medium uppercase tracking-[0.12em] text-[var(--text-muted)]">
            Co kamera umí
          </legend>
          <div className="space-y-2.5">
            <CheckboxField
              label="Detekuje osobu"
              name="detects_person"
              defaultChecked={keepChecked("detects_person", camera?.detects_person ?? true)}
            />
            <CheckboxField
              label="Detekuje vozidlo"
              name="detects_vehicle"
              defaultChecked={keepChecked("detects_vehicle", camera?.detects_vehicle ?? false)}
            />
            <CheckboxField
              label="Čte značku sama"
              name="reads_plate"
              defaultChecked={keepChecked("reads_plate", camera?.reads_plate ?? false)}
              hint="Kamera na bráně, která značku pošle v požadavku. Portál ji pak nečte modelem — sáhne po něm, jen když značka chybí nebo je nejistá."
            />
          </div>
          {/* Chyby celé skupiny: CheckboxField je nezná, protože se
              netýkají jednoho políčka, ale jejich kombinace. */}
          {e.detects_person ? (
            <p className="mt-2 text-xs text-[var(--danger)]">{e.detects_person}</p>
          ) : null}
          {e.reads_plate ? (
            <p className="mt-2 text-xs text-[var(--danger)]">{e.reads_plate}</p>
          ) : null}
          <p className="mt-3 text-xs text-[var(--text-muted)]">
            Detekce třídy, kterou kamera nemá zaškrtnutou, se zapíše — důkaz se
            nezahazuje — ale označí se jako neočekávaná a je vidět v detailu.
          </p>
        </fieldset>

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
