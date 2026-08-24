import type { Metadata } from "next";
import { Suspense } from "react";

import { LoginForm } from "./login-form.tsx";
import { Logo } from "@/components/logo.tsx";

export const metadata: Metadata = { title: "Přihlášení" };

export default function LoginPage() {
  return (
    <main className="min-h-dvh flex items-center justify-center px-6 py-12">
      <div className="w-full max-w-sm">
        <div className="flex justify-center mb-8">
          <Logo />
        </div>
        <Suspense>
          <LoginForm />
        </Suspense>
        <p className="mt-6 text-center text-xs text-[var(--text-muted)]">
          Sky Guard s.r.o. — perimetrická ochrana dronem
        </p>
      </div>
    </main>
  );
}
