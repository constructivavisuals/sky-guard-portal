import type { Metadata } from "next";
import { Settings } from "lucide-react";

import { EmptyState, PageHeader } from "@/components/ui.tsx";

export const metadata: Metadata = { title: "Nastavení" };

export default function Page() {
  return (
    <>
      <PageHeader title="Nastavení" description="Uživatelé, klíče a integrace." />
      <EmptyState
        icon={<Settings className="h-5 w-5" aria-hidden="true" />}
        title="Zatím prázdné"
        description="Nastavení se doplní, až budou hotové jednotlivé moduly."
      />
    </>
  );
}
