const SHELL_CACHE = "news-scraper-shell-v1";

const shellUrls = (base) => [
  `${base}index.html`,
  `${base}assets/zeit.svg`,
  `${base}assets/ksta.svg`,
  `${base}manifest.webmanifest`,
];

self.addEventListener("install", (event) => {
  const base = new URL("./", self.registration.scope).href;
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(shellUrls(base)).catch(() => {})),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== SHELL_CACHE).map((k) => caches.delete(k))),
    ),
  );
  self.clients.claim();
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "CLEAR_CACHES") {
    event.waitUntil(caches.keys().then((keys) => Promise.all(keys.map((k) => caches.delete(k)))));
  }
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (url.pathname.endsWith("/articles.json")) {
    event.respondWith(
      fetch(event.request).catch(() => caches.match(event.request)),
    );
    return;
  }
  if (event.request.mode === "navigate" || url.pathname.endsWith("/index.html")) {
    event.respondWith(
      fetch(event.request).catch(() => caches.match(`${url.origin}${url.pathname.replace(/\/?$/, "/")}index.html`)),
    );
  }
});