import { redirect } from "next/navigation";

// Kořen nemá vlastní obsah; nepřihlášené odkloní middleware na /login.
export default function RootPage() {
  redirect("/prehled");
}
