import type { Metadata } from "next";
import { ScanEye } from "lucide-react";

import { EmptyState, PageHeader } from "@/components/ui.tsx";

export const metadata: Metadata = { title: "Detekce" };

export default function Page() {
  return (
    <>
      <PageHeader title="Detekce" description="Co viděly kamery." />
      <EmptyState
        icon={<ScanEye className="h-5 w-5" aria-hidden="true" />}
        title="Žádné detekce"
        description="Detekce z kamer se objeví, jakmile začne ingest posílat data."
      />
    </>
  );
}
