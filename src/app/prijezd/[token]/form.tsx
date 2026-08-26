"use client";

import { useActionState } from "react";
import { CalendarCheck, Moon, Trash2 } from "lucide-react";

import { Button } from "@/components/ui.tsx";

import {
  ohlasitPrijezd,
  zrusitOhlaseni,
  type ArrivalActionState,
} from "./actions.ts";

// Formulář a seznam vlastních ohlášení.
//
// Mobile first: jeden sloupec, velká pole, žádné tabulky. Řidič to
// vyplňuje jednou rukou u brány, ne u stolu.

export interface ArrivalRow {
  id: string;
  plate: string;
  arrival_date: string;
  note: string | null;
  night_ok: boolean;
}

const PRAZDNY: ArrivalActionState = { ok: false };

function formatDatum(iso: string, timeZone: string): string {
  // Poledne, ne půlnoc: u půlnoci by se datum v jiném pásmu posunulo
  // o den zpátky.
  const at = new Date(`${iso}T12:00:00Z`);
  return new Intl.DateTimeFormat("cs-CZ", {
    timeZone,
    weekday: "short",
    day: "numeric",
    month: "numeric",
  }).format(at);
}

export function ArrivalForm({
  token,
  today,
  maxDate,
  arrivals,
  daysAhead,
  timeZone,
}: {
  token: string;
  today: string;
  maxDate: string;
  arrivals: ArrivalRow[];
  daysAhead: number;
  timeZone: string;
}) {
  const [state, formAction] = useActionState(ohlasitPrijezd, PRAZDNY);

  // React 19 po server akci nekontrolovaná pole vynuluje. Po úspěchu je
  // to správně (formulář se má vyprázdnit), po chybě ne — proto se
  // hodnoty vracejí zpátky.
  const keep = state.values;

  return (
    <>
      <form
        key={state.ok ? "cisty" : "pokus"}
        action={formAction}
        className="mt-8 space-y-5"
      >
        <input type="hidden" name="token" value={token} />

        <Pole label="Registrační značka" hint="Například 1AB 2345.">
          <input
            name="plate"
            required
            autoCapitalize="characters"
            autoComplete="off"
            spellCheck={false}
            defaultValue={keep?.plate ?? ""}
            placeholder="1AB 2345"
            className="h-12 w-full border border-[var(--line-strong)] bg-[var(--surface)] px-3 text-base uppercase tracking-wide"
          />
        </Pole>

        <Pole label="Datum příjezdu" hint="Dnešek nebo dál. Zpětně to nejde.">
          <input
            name="arrival_date"
            type="date"
            required
            min={today}
            max={maxDate}
            defaultValue={keep?.arrival_date ?? today}
            className="h-12 w-full border border-[var(--line-strong)] bg-[var(--surface)] px-3 text-base"
          />
        </Pole>

        <Pole label="Poznámka" hint="Nepovinné. Třeba co vezete nebo pro koho.">
          <input
            name="note"
            autoComplete="off"
            defaultValue={keep?.note ?? ""}
            placeholder="Beton pro halu B"
            className="h-12 w-full border border-[var(--line-strong)] bg-[var(--surface)] px-3 text-base"
          />
        </Pole>

        <label className="flex cursor-pointer items-start gap-3 border border-[var(--line)] bg-[var(--surface-2)] p-4">
          <input
            type="checkbox"
            name="night_ok"
            defaultChecked={keep?.night_ok ?? false}
            className="mt-0.5 h-5 w-5 shrink-0"
          />
          <span className="min-w-0">
            <span className="flex items-center gap-2 text-sm font-medium">
              <Moon className="h-4 w-4 shrink-0" aria-hidden="true" />
              Přijedu i v noci
            </span>
            {/* Vysvětlení je tu podstatné: bez něj řidič netuší, proč by
                to měl zaškrtávat, a v noci ho pak překvapí dron. */}
            <span className="mt-1.5 block text-[13px] leading-relaxed text-[var(--text-muted)]">
              Areál v noci hlídá dron. Bez tohohle zaškrtnutí platí ohlášení
              jen na dobu, kdy se nestřeží — když dorazíte v noci, dron
              k vám vyletí a někdo to bude řešit.
            </span>
          </span>
        </label>

        {state.error ? (
          <p className="border border-[var(--danger)]/40 bg-[var(--danger)]/[0.1] px-3.5 py-2.5 text-sm text-[var(--danger)]">
            {state.error}
          </p>
        ) : null}
        {state.ok ? (
          <p className="border border-[var(--success)]/35 bg-[var(--success)]/[0.07] px-3.5 py-2.5 text-sm text-[var(--success)]">
            Příjezd je ohlášený.
          </p>
        ) : null}

        <Button type="submit" className="h-12 w-full">
          <CalendarCheck className="h-4 w-4" aria-hidden="true" />
          Ohlásit příjezd
        </Button>
      </form>

      <section className="mt-10">
        <h2 className="text-[11px] font-medium uppercase tracking-[0.12em] text-[var(--text-muted)]">
          Vaše ohlášení na {daysAhead} dní dopředu
        </h2>

        {arrivals.length === 0 ? (
          <p className="mt-3 text-sm leading-relaxed text-[var(--text-muted)]">
            Zatím nic. Co ohlásíte, uvidíte tady.
          </p>
        ) : (
          <ul className="mt-3">
            {arrivals.map((arrival) => (
              <li
                key={arrival.id}
                className="flex items-start justify-between gap-4 border-b border-[var(--line)] py-3.5 last:border-b-0"
              >
                <div className="min-w-0">
                  <p className="font-mono text-sm tracking-wide">{arrival.plate}</p>
                  <p className="mt-0.5 text-[13px] text-[var(--text-muted)]">
                    {formatDatum(arrival.arrival_date, timeZone)}
                    {arrival.night_ok ? " · i v noci" : ""}
                  </p>
                  {arrival.note ? (
                    <p className="mt-0.5 truncate text-[13px] text-[var(--text-muted)]">
                      {arrival.note}
                    </p>
                  ) : null}
                </div>
                <CancelButton token={token} id={arrival.id} plate={arrival.plate} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

function CancelButton({
  token,
  id,
  plate,
}: {
  token: string;
  id: string;
  plate: string;
}) {
  const [state, formAction] = useActionState(zrusitOhlaseni, PRAZDNY);

  return (
    <form action={formAction} className="shrink-0">
      <input type="hidden" name="token" value={token} />
      <input type="hidden" name="id" value={id} />
      <button
        type="submit"
        aria-label={`Zrušit ohlášení ${plate}`}
        className="inline-flex h-10 w-10 items-center justify-center border border-transparent text-[var(--text-muted)] transition hover:border-[var(--line-strong)] hover:text-[var(--danger)]"
      >
        <Trash2 className="h-4 w-4" aria-hidden="true" />
      </button>
      {state.error ? (
        <span className="sr-only" role="status">
          {state.error}
        </span>
      ) : null}
    </form>
  );
}

function Pole({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[11px] font-medium uppercase tracking-[0.1em] text-[var(--text-muted)]">
        {label}
      </span>
      {children}
      {hint ? (
        <span className="mt-1.5 block text-[13px] text-[var(--text-muted)]">
          {hint}
        </span>
      ) : null}
    </label>
  );
}
