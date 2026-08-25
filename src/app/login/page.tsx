import type { Metadata } from "next";
import { Suspense } from "react";

import { LoginForm } from "./login-form.tsx";
import { Logo } from "@/components/logo.tsx";

export const metadata: Metadata = { title: "Přihlášení" };

// Přihlášení stojí na téže mřížce jako zbytek portálu: linky procházejí
// celou plochou a formulář je jedna z buněk. Prázdné buňky kolem něj
// nejsou výplň — je to tentýž rastr, jen v něm zatím nic není.

export default function LoginPage() {
  return (
    <main className="relative grid min-h-dvh place-items-center overflow-hidden px-4 py-10">
      {/* Mřížka na pozadí, stejná jako na sky-guard.cz. Formulář v ní
          sedí jako jedna obsazená buňka. */}
      <div
        aria-hidden="true"
        className="rule-field pointer-events-none absolute inset-0"
        style={{ "--col": "12.5%" } as React.CSSProperties}
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-[18%] h-px bg-[var(--line)]"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 bottom-[18%] h-px bg-[var(--line)]"
      />

      <div className="relative w-full max-w-[420px] border border-[var(--line-strong)] bg-[var(--surface)]">
        <div className="flex h-20 items-center justify-center border-b border-[var(--line)]">
          <Logo />
        </div>

        <Suspense>
          <LoginForm />
        </Suspense>

        <p className="border-t border-[var(--line)] px-8 py-4 text-center text-[11px] uppercase tracking-[0.12em] text-[var(--text-muted)]">
          Sky Guard s.r.o.
        </p>
      </div>
    </main>
  );
}
