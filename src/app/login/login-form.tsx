"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useState, useSyncExternalStore, type FormEvent } from "react";
import { AlertCircle } from "lucide-react";

import { Button } from "@/components/ui.tsx";
import { createClient } from "@/lib/supabase/client.ts";

export function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  // Do nahydratování se odesílání blokuje. Bez JS by se formulář odeslal
  // nativně a heslo by skončilo v URL a v access logu serveru; method
  // POST je druhá pojistka pro případ, že by tlačítko někdo obešel
  // klávesou Enter dřív, než se stav propíše.
  //
  // useSyncExternalStore místo useState + useEffect: na serveru a při
  // hydrataci vrací false, po ní true — bez cascading renderu.
  const hydrated = useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);

    const supabase = createClient();
    const { error: signInError } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (signInError) {
      // Chyba se nerozlišuje na "neznámý e-mail" a "špatné heslo" —
      // jinak by šlo přes formulář zjistit, kdo má účet.
      setError("Přihlášení se nezdařilo. Zkontrolujte e-mail a heslo.");
      setPending(false);
      return;
    }

    // Kam se uživatel chtěl dostat, než ho middleware odklonil.
    const next = searchParams.get("dalsi");
    router.replace(next?.startsWith("/") ? next : "/prehled");
    router.refresh();
  }

  return (
    <div className="px-8 py-8">
      <h1 className="text-2xl font-normal tracking-tight">Přihlášení</h1>
      <p className="mt-1.5 text-sm text-[var(--text-muted)]">
        Přístup jen pro pověřené osoby.
      </p>

      <form
        method="post"
        onSubmit={handleSubmit}
        className="mt-6 space-y-4"
      >
        <Field
          id="email"
          label="E-mail"
          type="email"
          value={email}
          onChange={setEmail}
          autoComplete="email"
        />
        <Field
          id="password"
          label="Heslo"
          type="password"
          value={password}
          onChange={setPassword}
          autoComplete="current-password"
        />

        {error ? (
          <p
            role="alert"
            className="flex items-start gap-2 border border-[var(--danger)]/40 bg-[var(--danger)]/[0.08] px-3 py-2.5 text-sm text-[var(--danger)]"
          >
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            {error}
          </p>
        ) : null}

        <Button type="submit" className="w-full" disabled={pending || !hydrated}>
          {pending ? "Přihlašuji…" : "Přihlásit se"}
        </Button>
      </form>
    </div>
  );
}

function Field({
  id,
  label,
  type,
  value,
  onChange,
  autoComplete,
}: {
  id: string;
  label: string;
  type: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete: string;
}) {
  return (
    <div>
      <label htmlFor={id} className="mb-2 block text-[11px] font-medium uppercase tracking-[0.12em] text-[var(--text-muted)]">
        {label}
      </label>
      <input
        id={id}
        name={id}
        type={type}
        required
        autoComplete={autoComplete}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-11 w-full border border-[var(--line-strong)] bg-[var(--surface-2)] px-3.5 text-sm tracking-tight placeholder:text-[var(--text-muted)] focus:border-[var(--accent-bright)] focus:outline-none"
      />
    </div>
  );
}
