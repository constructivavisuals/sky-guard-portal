import type { NextConfig } from "next";

import { contentSecurityPolicy } from "./src/lib/csp.ts";

// Bezpečnostní hlavičky.
//
// Portál je jednostránková aplikace pod přihlášením; nic z něj se nemá
// vkládat do cizí stránky ani odesílat jinam než do Supabase.
//
// Samotná politika bydlí v `src/lib/csp.ts`, aby šla otestovat.
// Chybějící direktiva se totiž při buildu ani v testech aplikace nijak
// neprojeví — pozná se až v prohlížeči u klienta jako „video nejde“.
// Přesně tak tu chyběl `media-src`.
//
// ═══ Proměnné se čtou při BUILDU ═══════════════════════════════════
// Hlavička se skládá tady, tedy v době sestavení, ne za běhu.
// NEXT_PUBLIC_SUPABASE_URL, HETZNER_S3_ENDPOINT a LIVE_STREAM_BASE_URL
// proto musí být
// v prostředí BUILDU, ne jen běhu — jinak se použijí volnější
// náhradní hodnoty a nikde to nezakřičí.

const csp = contentSecurityPolicy({
  supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
  hetznerEndpoint: process.env.HETZNER_S3_ENDPOINT,
  liveBaseUrl: process.env.LIVE_STREAM_BASE_URL,
  dev: process.env.NODE_ENV === "development",
});

const nextConfig: NextConfig = {
  /**
   * Fonty pro PDF report musí doputovat do serverless funkce.
   *
   * Next balí jen to, co v kódu vidí jako import. Font se čte přes
   * fs.readFile z cesty složené za běhu, takže by ho tam nedal — a PDF
   * by na Vercelu spadlo zpátky na Helveticu bez diakritiky. Lokálně
   * by přitom bylo v pořádku, což je nejhorší druh chyby.
   */
  outputFileTracingIncludes: {
    "/api/reporty": ["./src/lib/fonts/**"],
  },

  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: csp },
          // frame-ancestors výše je novější a silnější; tohle je pro
          // prohlížeče, které CSP neumí.
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Permissions-Policy",
            // Portál nic z toho nepotřebuje. Kamera a mikrofon
            // schválně taky ne — video z dronu se prohlíží, nenahrává.
            value: [
              "accelerometer=()",
              "camera=()",
              "geolocation=()",
              "gyroscope=()",
              "magnetometer=()",
              "microphone=()",
              "payment=()",
              "usb=()",
            ].join(", "),
          },
        ],
      },
    ];
  },
};

export default nextConfig;
