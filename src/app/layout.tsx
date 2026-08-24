import type { Metadata } from "next";
import { Figtree } from "next/font/google";

import "./globals.css";

// Jediné místo, kde se mění písmo celé aplikace. Komponenty sahají na
// --font-sans z globals.css, ne přímo na Figtree.
const sans = Figtree({
  variable: "--font-figtree",
  subsets: ["latin", "latin-ext"],
  display: "swap",
});

export const metadata: Metadata = {
  title: {
    default: "Sky Guard",
    template: "%s · Sky Guard",
  },
  description: "Perimetrická ochrana dronem",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="cs" className={`${sans.variable} h-full antialiased`}>
      <body className="min-h-full">{children}</body>
    </html>
  );
}
