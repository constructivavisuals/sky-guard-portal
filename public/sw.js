// Service worker Sky Guard — schválně minimální.
//
// Cachuje se JEDINÁ věc: offline stránka. Žádná data, žádné odpovědi
// API, žádné stránky se stavem střežení. U bezpečnostního systému je
// horší ukázat hodinu starý stav jako aktuální než neukázat nic —
// operátor by podle něj mohl usoudit, že je areál střežený, i když
// dávno není.
//
const CACHE = "sky-guard-offline-v2";
const OFFLINE_URL = "/offline";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.add(new Request(OFFLINE_URL, { cache: "reload" })))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;

  // Řeší se jen přechody mezi stránkami. Všechno ostatní — data, API,
  // statické soubory — jde rovnou na síť a nikde se neukládá.
  if (request.mode !== "navigate") return;

  event.respondWith(
    fetch(request).catch(async () => {
      const cache = await caches.open(CACHE);
      const fallback = await cache.match(OFFLINE_URL);
      return (
        fallback ??
        new Response("Aplikace je offline.", {
          status: 503,
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        })
      );
    }),
  );
});

// ── Push notifikace ──────────────────────────────────────────────
//
// Tvar zprávy posílá server (lib/push/send.ts):
//   { title, body, url, tag, kind }
//
// Obsah se schválně NECACHUJE a nikam neukládá: je v něm, co kamera
// viděla a kde. Notifikace zmizí s kliknutím a v zařízení po ní
// nezůstane nic než záznam v systému.

const VYCHOZI = {
  title: "Sky Guard",
  body: "Nová událost v portálu.",
  url: "/prehled",
  tag: "sky-guard",
};

function precistData(event) {
  // Payload nemusí dorazit vůbec — push služba smí poslat notifikaci
  // bez těla, a některé prohlížeče to dělají po obnovení odběru.
  if (!event.data) return VYCHOZI;
  try {
    const parsed = event.data.json();
    if (!parsed || typeof parsed !== "object") return VYCHOZI;
    return {
      title: typeof parsed.title === "string" && parsed.title ? parsed.title : VYCHOZI.title,
      body: typeof parsed.body === "string" && parsed.body ? parsed.body : VYCHOZI.body,
      // Jen relativní cesta v portálu. Kdyby se sem dostala cizí
      // adresa, klik by z notifikace otevřel cizí web.
      url:
        typeof parsed.url === "string" && parsed.url.startsWith("/") && !parsed.url.startsWith("//")
          ? parsed.url
          : VYCHOZI.url,
      tag: typeof parsed.tag === "string" && parsed.tag ? parsed.tag : VYCHOZI.tag,
      kind: typeof parsed.kind === "string" ? parsed.kind : null,
    };
  } catch {
    // Tělo, které není JSON, pořád znamená „něco se stalo“. Ukázat
    // obecnou notifikaci je lepší než mlčet.
    return VYCHOZI;
  }
}

self.addEventListener("push", (event) => {
  const data = precistData(event);

  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      // Stejný tag přepíše předchozí notifikaci místo hromadění.
      // Zásahy mají tag s id, takže se nepřepisují navzájem.
      tag: data.tag,
      // Potvrzený nález a odeslaný zásah mají zůstat na displeji,
      // dokud je někdo neodklikne — jsou to věci, kvůli kterým se jde
      // podívat ven.
      requireInteraction: data.kind === "threat_confirmed" || data.kind === "dispatch_sent",
      data: { url: data.url },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const cil = event.notification.data && event.notification.data.url;
  const url = typeof cil === "string" && cil.startsWith("/") ? cil : VYCHOZI.url;

  event.waitUntil(
    (async () => {
      const clients = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });

      // Otevřené okno se použije znovu a jen přenaviguje. Otevřít další
      // kartu k té, kterou má operátor na druhém monitoru, by znamenalo
      // dvě místa se stejným portálem.
      for (const client of clients) {
        if ("focus" in client) {
          await client.focus();
          if ("navigate" in client) {
            try {
              await client.navigate(url);
            } catch {
              // Navigace může selhat u okna v jiném původu nebo při
              // přechodu; zaostření samo o sobě má cenu.
            }
          }
          return;
        }
      }

      if (self.clients.openWindow) await self.clients.openWindow(url);
    })(),
  );
});
