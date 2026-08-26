import type { NextConfig } from "next";

// Bezpečnostní hlavičky.
//
// Portál je jednostránková aplikace pod přihlášením; nic z něj se nemá
// vkládat do cizí stránky ani odesílat jinam než do Supabase.
//
// POZNÁMKA ke script-src: Next si do stránky vkládá vlastní inline
// skripty (streamování, hydratace), takže bez 'unsafe-inline' by se
// portál nespustil. Utáhnout by to šlo jedině nonce vydávaným
// v proxy.ts a protaženým do všech skriptů — to je samostatná
// změna, ne řádek v konfiguraci. Zbytek direktiv je přísný, protože
// právě ty brání odeslání dat jinam a vložení do cizího rámu.

/**
 * Odkud smí prohlížeč mluvit se Supabase.
 *
 * Doména projektu se mezi prostředími liší, tak se bere z proměnné.
 * Když chybí (build bez .env), pustí se celá supabase.co — přísnější
 * hodnota by rozbila přihlášení a projevilo by se to až u klienta.
 */
function supabaseOrigin(): string {
  const raw = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!raw) return "https://*.supabase.co wss://*.supabase.co";
  try {
    const url = new URL(raw);
    const ws = url.protocol === "https:" ? "wss:" : "ws:";
    return `${url.origin} ${ws}//${url.host}`;
  } catch {
    return "https://*.supabase.co wss://*.supabase.co";
  }
}

const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline' 'unsafe-eval'`,
  "style-src 'self' 'unsafe-inline'",
  // Loga klientů leží v Supabase Storage, podklady areálu v public/.
  `img-src 'self' data: blob: ${supabaseOrigin()}`,
  "font-src 'self' data:",
  `connect-src 'self' ${supabaseOrigin()}`,
  // Nic se nesmí vkládat do rámu a portál sám nikam nepatří.
  "frame-ancestors 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'self'",
  // Formuláře smí odesílat jen na vlastní původ — brzda pro případ,
  // že by se do stránky dostal cizí <form action>.
  "form-action 'self'",
  "upgrade-insecure-requests",
].join("; ");

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
