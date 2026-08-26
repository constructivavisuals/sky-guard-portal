import { redirect } from "next/navigation";

// Samotná /brana nic neukazuje — první karta je seznam vjezdů.
export default function Page() {
  redirect("/brana/vjezdy");
}
