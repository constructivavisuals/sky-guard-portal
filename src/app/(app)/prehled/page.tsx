import type { Metadata } from "next";
import { LayoutDashboard } from "lucide-react";

import { EmptyState, PageHeader } from "@/components/ui.tsx";

export const metadata: Metadata = { title: "Přehled" };

export default function Page() {
  return (
    <>
      <PageHeader title="Přehled" description="Stav střežení napříč lokalitami." />
      <EmptyState
        icon={<LayoutDashboard className="h-5 w-5" aria-hidden="true" />}
        title="Zatím není co zobrazit"
        description="Až přibude první lokalita a kamera, uvidíte tady souhrn."
      />
    </>
  );
}
