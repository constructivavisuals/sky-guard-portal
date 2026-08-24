import type { Metadata } from "next";
import { MapPin } from "lucide-react";

import { EmptyState, PageHeader } from "@/components/ui.tsx";

export const metadata: Metadata = { title: "Lokality" };

export default function Page() {
  return (
    <>
      <PageHeader title="Lokality" description="Areály, docky a hlídané zóny." />
      <EmptyState
        icon={<MapPin className="h-5 w-5" aria-hidden="true" />}
        title="Žádné lokality"
        description="Založte první lokalitu s dockem, zónami a kamerami."
      />
    </>
  );
}
