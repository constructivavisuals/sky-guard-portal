import type { Metadata } from "next";
import { Send } from "lucide-react";

import { EmptyState, PageHeader } from "@/components/ui.tsx";

export const metadata: Metadata = { title: "Výjezdy" };

export default function Page() {
  return (
    <>
      <PageHeader title="Výjezdy" description="Pokusy o výjezd dronu včetně potlačených." />
      <EmptyState
        icon={<Send className="h-5 w-5" aria-hidden="true" />}
        title="Žádné výjezdy"
        description="Každý pokus o výjezd se sem zapíše — i ten potlačený nebo neúspěšný."
      />
    </>
  );
}
