const SHELL_CACHE = "news-scraper-shell-v9";

const shellUrls = (base) => [
  `${base}index.html`,
  `${base}open.html`,
  `${base}assets/zeit.svg`,
  `${base}assets/ksta.svg`,
  `${base}manifest.webmanifest`,
];

function pageName(pathname) {
  const leaf = pathname.replace(/\/$/, "").split("/").pop() || "";
  return leaf || "index.html";
}

self.addEventListener("install", (event) => {
  const base = new URL("./", self.registration.scope).href;
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(shellUrls(base)).catch(() => {})),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.matchAll({ type: "window" }))
      .then((clients) => clients.forEach((c) => c.postMessage({ type: "SW_UPDATED" }))),
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
    event.respondWith(fetch(event.request).catch(() => caches.match(event.request)));
    return;
  }

  if (event.request.mode !== "navigate") return;

  const page = pageName(url.pathname);
  if (page !== "index.html" && page !== "open.html" && page !== "") return;

  const scope = self.registration.scope;
  const indexUrl = new URL("index.html", scope).href;
  const openUrl = new URL("open.html", scope).href;
  const isOpen = url.pathname.includes("open.html");

  event.respondWith(
    (async () => {
      try {
        const network = await fetch(event.request);
        if (network.ok) return network;
      } catch {
        /* offline */
      }
      const cached =
        (isOpen ? await caches.match(openUrl) : null) ||
        (await caches.match(indexUrl)) ||
        (await caches.match(event.request));
      if (cached) return cached;
      try {
        return await fetch(event.request);
      } catch {
        return isOpen ? fetch(openUrl) : fetch(indexUrl);
      }
    })(),
  );
});