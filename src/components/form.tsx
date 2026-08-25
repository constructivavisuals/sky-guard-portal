"use client";

import { X } from "lucide-react";
import { useEffect, useId, useState, type ReactNode } from "react";
import { useFormStatus } from "react-dom";

import { Button } from "./ui.tsx";

// Formulářová primitiva. Chyby přicházejí ze serveru klíčované názvem
// pole, takže se vypisují rovnou pod ním a zároveň se pole označí přes
// aria-invalid a aria-describedby.

export interface FormState {
  ok: boolean;
  errors: Record<string, string>;
  /**
   * Odeslané hodnoty vrácené serverem. React 19 po server akci
   * nekontrolovaná pole resetuje, takže se z nich formulář předvyplní
   * zpátky — jinak by po jediné chybě zmizel celý vyplněný obsah.
   */
  values?: Record<string, string | string[]>;
  /**
   * Pořadí pokusu. Formulář se jím klíčuje, takže se po každé odpovědi
   * serveru přemountuje a načte defaultValue znovu — jinak by se
   * obnovila jen textová pole, ne <select> a zaškrtávátka, u kterých
   * defaultValue platí pouze při připojení komponenty.
   */
  attempt?: number;
}

export const EMPTY_FORM_STATE: FormState = { ok: false, errors: {}, attempt: 0 };

// Pole je hranaté jako zbytek mřížky; kulaté jsou jen akce.
const inputClass =
  "w-full h-11 bg-[var(--surface-2)] border border-[var(--line-strong)] px-3.5 text-sm tracking-tight placeholder:text-[var(--text-muted)] focus:border-[var(--accent-bright)] focus:outline-none aria-[invalid=true]:border-[var(--danger)]";

export function Field({
  label,
  name,
  error,
  hint,
  children,
}: {
  label: string;
  name: string;
  error?: string;
  hint?: string;
  children: (props: {
    id: string;
    name: string;
    "aria-invalid": boolean;
    "aria-describedby": string | undefined;
    className: string;
  }) => ReactNode;
}) {
  const id = useId();
  const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined;

  return (
    <div>
      <label htmlFor={id} className="mb-2 block text-[11px] font-medium uppercase tracking-[0.12em] text-[var(--text-muted)]">
        {label}
      </label>
      {children({
        id,
        name,
        "aria-invalid": Boolean(error),
        "aria-describedby": describedBy,
        className: inputClass,
      })}
      {error ? (
        <p id={`${id}-error`} className="mt-1 text-xs text-[var(--danger)]">
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="mt-1 text-xs text-[var(--text-muted)]">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

/** Textové pole s popiskem a chybou. */
export function TextField(props: {
  label: string;
  name: string;
  error?: string;
  hint?: string;
  type?: string;
  defaultValue?: string | number | null;
  required?: boolean;
  placeholder?: string;
  inputMode?: "text" | "decimal" | "numeric";
  /** Když je potřeba na hodnotu reagovat (živé varování u intervalu). */
  onChange?: (value: string) => void;
}) {
  const { type = "text", defaultValue, required, placeholder, inputMode } = props;
  return (
    <Field label={props.label} name={props.name} error={props.error} hint={props.hint}>
      {(field) => (
        <input
          {...field}
          type={type}
          required={required}
          placeholder={placeholder}
          inputMode={inputMode}
          defaultValue={defaultValue ?? ""}
          onChange={
            props.onChange
              ? (event) => props.onChange?.(event.target.value)
              : undefined
          }
        />
      )}
    </Field>
  );
}

export function SelectField(props: {
  label: string;
  name: string;
  error?: string;
  hint?: string;
  defaultValue?: string;
  value?: string;
  onChange?: (value: string) => void;
  options: { value: string; label: string }[];
  placeholder?: string;
}) {
  return (
    <Field label={props.label} name={props.name} error={props.error} hint={props.hint}>
      {(field) => (
        <select
          {...field}
          defaultValue={props.value === undefined ? (props.defaultValue ?? "") : undefined}
          value={props.value}
          onChange={props.onChange ? (e) => props.onChange!(e.target.value) : undefined}
        >
          {props.placeholder ? <option value="">{props.placeholder}</option> : null}
          {props.options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      )}
    </Field>
  );
}

export function CheckboxField({
  label,
  name,
  defaultChecked,
  hint,
}: {
  label: string;
  name: string;
  defaultChecked?: boolean;
  hint?: string;
}) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className="flex items-center gap-2.5 text-sm">
        <input
          id={id}
          name={name}
          type="checkbox"
          defaultChecked={defaultChecked}
          className="h-4 w-4 border-[var(--line-strong)] bg-[var(--surface-2)] accent-[var(--accent-bright)]"
        />
        {label}
      </label>
      {hint ? (
        <p className="mt-1 text-xs text-[var(--text-muted)]">{hint}</p>
      ) : null}
    </div>
  );
}

/** Sedm přepínačů dnů. Hodnoty jsou ISO čísla 1–7, jak je čeká databáze. */
export function WeekdayField({
  name,
  error,
  defaultValue = [],
}: {
  name: string;
  error?: string;
  defaultValue?: number[];
}) {
  const days = [
    [1, "Po"],
    [2, "Út"],
    [3, "St"],
    [4, "Čt"],
    [5, "Pá"],
    [6, "So"],
    [7, "Ne"],
  ] as const;

  return (
    <fieldset>
      <legend className="mb-2 block text-[11px] font-medium uppercase tracking-[0.12em] text-[var(--text-muted)]">Dny střežení</legend>
      <div className="flex flex-wrap gap-1.5">
        {days.map(([value, label]) => (
          <label
            key={value}
            className="inline-flex h-9 cursor-pointer select-none items-center border border-[var(--line-strong)] bg-[var(--surface-2)] px-3 text-sm transition has-checked:border-[var(--accent-bright)] has-checked:bg-[var(--accent)] has-checked:text-white"
          >
            <input
              type="checkbox"
              name={name}
              value={value}
              defaultChecked={defaultValue.includes(value)}
              className="sr-only"
            />
            {label}
          </label>
        ))}
      </div>
      {error ? (
        <p className="mt-1 text-xs text-[var(--danger)]">{error}</p>
      ) : null}
    </fieldset>
  );
}

/** Chyba, která nepatří ke konkrétnímu poli. */
export function FormError({ error }: { error?: string }) {
  if (!error) return null;
  return (
    <p
      role="alert"
      className="border border-[var(--danger)]/40 bg-[var(--danger)]/[0.1] px-3.5 py-2.5 text-sm text-[var(--danger)]"
    >
      {error}
    </p>
  );
}

export function SubmitButton({ children }: { children: ReactNode }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending}>
      {pending ? "Ukládám…" : children}
    </Button>
  );
}

/**
 * Modální okno s formulářem. Zavírá se po úspěšném uložení — server akce
 * to hlásí přes state.ok, ne přes návrat z fetch.
 */
export function FormDialog({
  title,
  open,
  onClose,
  children,
}: {
  title: string;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4 sm:p-8">
      <button
        type="button"
        aria-label="Zavřít"
        onClick={onClose}
        className="fixed inset-0 -z-10 cursor-default bg-black/70"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="w-full max-w-lg border border-[var(--line-strong)] bg-[var(--surface)] shadow-[0_24px_80px_rgba(0,0,0,0.7)]"
      >
        <div className="flex h-14 items-center justify-between gap-4 border-b border-[var(--line)] px-5">
          <h2 className="text-sm font-medium tracking-tight">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Zavřít"
            className="inline-flex h-9 w-9 items-center justify-center text-[var(--text-muted)] transition hover:bg-[var(--surface-2)] hover:text-[var(--text)]"
          >
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}

/** Tlačítko, které otevře dialog s formulářem. */
export function useDialog() {
  const [open, setOpen] = useState(false);
  return {
    open,
    show: () => setOpen(true),
    hide: () => setOpen(false),
  };
}
