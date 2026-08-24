"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useState, type FormEvent } from "react";
import { AlertCircle } from "lucide-react";

import { Button, Card } from "@/components/ui.tsx";
import { createClient } from "@/lib/supabase/client.ts";

export function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

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
    <Card className="p-8">
      <h1 className="text-xl font-semibold tracking-tight">Přihlášení</h1>
      <p className="mt-1 text-sm text-[var(--text-muted)]">
        Přístup jen pro pověřené osoby.
      </p>

      <form onSubmit={handleSubmit} className="mt-6 space-y-4">
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
            className="flex items-start gap-2 text-sm text-[var(--danger)]"
          >
            <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" aria-hidden="true" />
            {error}
          </p>
        ) : null}

        <Button type="submit" className="w-full" disabled={pending}>
          {pending ? "Přihlašuji…" : "Přihlásit se"}
        </Button>
      </form>
    </Card>
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
      <label htmlFor={id} className="block text-sm font-medium mb-1.5">
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
        className="w-full h-11 rounded-lg bg-[var(--surface-2)] border border-[var(--border)] px-3 text-sm placeholder:text-[var(--text-muted)] focus:border-[var(--accent)]"
      />
    </div>
  );
}
