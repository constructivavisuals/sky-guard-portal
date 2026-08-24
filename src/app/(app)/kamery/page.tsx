import type { Metadata } from "next";
import { Cctv } from "lucide-react";

import { EmptyState, PageHeader } from "@/components/ui.tsx";

export const metadata: Metadata = { title: "Kamery" };

export default function Page() {
  return (
    <>
      <PageHeader title="Kamery" description="Kamery na lokalitách a jejich stav." />
      <EmptyState
        icon={<Cctv className="h-5 w-5" aria-hidden="true" />}
        title="Žádné kamery"
        description="Přidejte kameru k zóně, aby mohla posílat detekce."
      />
    </>
  );
}
