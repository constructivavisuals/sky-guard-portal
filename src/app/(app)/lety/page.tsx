import type { Metadata } from "next";
import { Plane } from "lucide-react";

import { EmptyState, PageHeader } from "@/components/ui.tsx";

export const metadata: Metadata = { title: "Lety" };

export default function Page() {
  return (
    <>
      <PageHeader title="Lety" description="Co dron skutečně odletěl." />
      <EmptyState
        icon={<Plane className="h-5 w-5" aria-hidden="true" />}
        title="Žádné lety"
        description="Lety se doplní z FlightHubu po prvním zásahu."
      />
    </>
  );
}
