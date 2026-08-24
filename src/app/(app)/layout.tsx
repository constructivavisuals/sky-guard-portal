import { Shell } from "./shell.tsx";

// App shell pro přihlášené: sidebar vlevo (pod lg v šuplíku), lišta
// nahoře, obsah vpravo. Přístup hlídá middleware.ts, tahle vrstva se
// autentizací nezabývá.

export default function AppLayout({ children }: LayoutProps<"/">) {
  return <Shell>{children}</Shell>;
}
