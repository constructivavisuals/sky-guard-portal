import type { Metadata, Viewport } from "next";
import { DM_Sans } from "next/font/google";

import { ServiceWorkerRegistration } from "@/components/service-worker.tsx";

import "./globals.css";

// Jediné místo, kde se mění písmo celé aplikace. Komponenty sahají na
// --font-sans z globals.css, ne přímo na DM Sans.
//
// DM Sans je písmo z sky-guard.cz. Portál je jeho pokračování za
// přihlášením, takže musí sedět i typograficky.
const sans = DM_Sans({
  variable: "--font-dm-sans",
  subsets: ["latin", "latin-ext"],
  display: "swap",
});

export const metadata: Metadata = {
  title: {
    default: "Sky Guard",
    template: "%s · Sky Guard",
  },
  description: "Perimetrická ochrana dronem",
  applicationName: "Sky Guard Hub",
  // Safari z manifestu přebírá jen část, takže se to samé musí říct
  // ještě přes meta tagy — jinak se aplikace z plochy otevře v prohlížeči
  // s adresním řádkem místo na celé obrazovce.
  appleWebApp: {
    capable: true,
    title: "Sky Guard",
    statusBarStyle: "black-translucent",
  },
  formatDetection: { telephone: false },
  other: {
    // Next emituje standardizované mobile-web-app-capable, ale iOS
    // starší než 15.4 zná jen tuhle apple- variantu. Obě vedle sebe
    // nevadí a pokrývají i starší iPady, které klienti reálně mají.
    "apple-mobile-web-app-capable": "yes",
  },
};

export const viewport: Viewport = {
  themeColor: "#08070E",
  colorScheme: "dark",
  // Kvůli black-translucent stavovému řádku na iOS musí obsah sahat
  // pod výřez; odsazení si řeší layout přes safe-area.
  viewportFit: "cover",
  // Portál je aplikace, ne dokument: přibližovat se v něm nemá co.
  // Roztažené prsty jen posunou obsah mimo obrazovku a operátor pak
  // hledá navigaci, která zůstala za okrajem.
  //
  // V Safari na webu iOS tohle záměrně ignoruje (kvůli přístupnosti),
  // ale v aplikaci spuštěné z plochy — což je způsob, jak se portál
  // používá — to platí. Zbytek dorazí přes touch-action v globals.css.
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="cs" className={`${sans.variable} h-full antialiased`}>
      <body className="min-h-full">
        {children}
        <ServiceWorkerRegistration />
      </body>
    </html>
  );
}
