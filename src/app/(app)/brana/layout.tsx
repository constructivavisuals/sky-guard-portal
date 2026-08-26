import { getCurrentProfile } from "@/lib/current-profile.ts";
import { isAdmin } from "@/lib/profile.ts";

import { BranaTabs } from "./tabs.tsx";

// Společný rám pro Bránu. Karty jsou v layoutu, ne v každé stránce —
// jinak by se při přepnutí překreslily a poskočily.

export default async function Layout({ children }: LayoutProps<"/brana">) {
  const admin = isAdmin(await getCurrentProfile());

  return (
    <>
      <BranaTabs isAdmin={admin} />
      {children}
    </>
  );
}
