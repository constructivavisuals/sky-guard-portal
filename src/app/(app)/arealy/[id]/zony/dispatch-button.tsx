"use client";

import { Send } from "lucide-react";
import { useActionState, useState } from "react";

import { FormDialog, SubmitButton } from "@/components/form.tsx";
import { Button } from "@/components/ui.tsx";

import { poslatDronDoZony, type ManualDispatchState } from "./dispatch-actions.ts";

const PRAZDNY: ManualDispatchState = { ok: false };

// Tlačítko „poslat dron do zóny“ u řádku zóny. Vidí ho admin
// a operátor; že se nezobrazuje klientovi, není ochrana — tou je
// kontrola role v samotné akci a RLS pod ní.

export function DispatchButton({
  zone,
}: {
  zone: { id: string; name: string; hasWayline: boolean };
}) {
  const [session, setSession] = useState(0);
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setSession((value) => value + 1);
          setOpen(true);
        }}
        aria-label={`Poslat dron do zóny ${zone.name}`}
        className="inline-flex h-9 w-9 shrink-0 items-center justify-center border border-transparent text-[var(--text-muted)] transition hover:border-[var(--line-strong)] hover:bg-[var(--surface-2)] hover:text-[var(--text)]"
      >
        <Send className="h-4 w-4" aria-hidden="true" />
      </button>

      {open ? (
        <DispatchDialog key={session} zone={zone} onClose={() => setOpen(false)} />
      ) : null}
    </>
  );
}

function DispatchDialog({
  zone,
  onClose,
}: {
  zone: { id: string; name: string; hasWayline: boolean };
  onClose: () => void;
}) {
  const [state, formAction] = useActionState(poslatDronDoZony, PRAZDNY);

  // Dialog se po odeslání NEZAVÍRÁ, ani když se povedlo. Zásah může
  // skončit potlačením a operátor se musí dozvědět, že dron nevzlétl —
  // zavřené okno by vypadalo stejně jako úspěch.
  const done = Boolean(state.message);

  return (
    <FormDialog title="Poslat dron do zóny" open onClose={onClose}>
      {done ? (
        <div className="space-y-4">
          <p
            className={`text-sm ${state.ok ? "text-[var(--success)]" : "text-[var(--warning)]"}`}
          >
            {state.message}
          </p>
          <div className="flex justify-end">
            <Button type="button" variant="secondary" onClick={onClose}>
              Zavřít
            </Button>
          </div>
        </div>
      ) : (
        <form action={formAction} className="space-y-4">
          <input type="hidden" name="zone_id" value={zone.id} />

          <p className="text-sm">
            Dron vyrazí do zóny <span className="font-medium">{zone.name}</span> po
            trase, kterou má zóna přiřazenou.
          </p>

          {/* Ruční zásah neobchází pravidla. Kdo to neví předem, bude
              potlačení číst jako poruchu. */}
          <p className="text-sm text-[var(--text-muted)]">
            Platí stejná pravidla jako u zásahu z detekce: mimo hlídané okno,
            během cooldownu nebo s nepřipraveným dokem dron nevzlétne. Pokus se
            v obou případech zapíše mezi zásahy.
          </p>

          {!zone.hasWayline ? (
            <p className="text-sm text-[var(--warning)]">
              Zóna nemá trasu, takže úlohu ve FlightHubu nejde založit. Zásah se
              zapíše jako neúspěšný.
            </p>
          ) : null}

          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={onClose}>
              Zrušit
            </Button>
            <SubmitButton>Poslat dron</SubmitButton>
          </div>
        </form>
      )}
    </FormDialog>
  );
}
