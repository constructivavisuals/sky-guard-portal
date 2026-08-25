// Service worker Sky Guard — schválně minimální.
//
// Cachuje se JEDINÁ věc: offline stránka. Žádná data, žádné odpovědi
// API, žádné stránky se stavem střežení. U bezpečnostního systému je
// horší ukázat hodinu starý stav jako aktuální než neukázat nic —
// operátor by podle něj mohl usoudit, že je areál střežený, i když
// dávno není.
//
// Push notifikace tu zatím nejsou; až přijdou, přibude posluchač
// 'push' a 'notificationclick'.

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
