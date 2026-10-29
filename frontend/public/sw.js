/* School ERP service worker: offline-friendly app shell and push notifications.
 *
 * What is kept on the device (Cache Storage):
 *   - "static":  the app's code, styles and fonts (/_next/static, /fonts, /icons, /splash) — they never change
 *                under the same name, so they are served from the cache first;
 *   - "pages":   the HTML of pages opened recently, as a fallback when offline. Page HTML here is only the
 *                empty shell: every name, fee, mark or attendance figure is loaded in the browser after
 *                sign-in, from the API, and that is never cached. Cleared when someone signs out.
 *   - "shell":   the offline page and the app icon.
 * Requests to the API (another origin), sign-in, and anything that isn't a GET pass straight through.
 * Bump VERSION when this file's caching rules change; old caches are removed on activation.
 */
const VERSION = "v1";
const SHELL = `shell-${VERSION}`;
const STATIC = `static-${VERSION}`;
const PAGES = `pages-${VERSION}`;
const KEEP = [SHELL, STATIC, PAGES];
const OFFLINE_URL = "/offline.html";
const SHELL_FILES = [
  OFFLINE_URL, "/icons/icon-192.png", "/icons/badge-72.png", "/manifest.webmanifest",
  "/fonts/figtree-latin-400-normal.woff2", "/fonts/figtree-latin-600-normal.woff2",
];
const MAX_PAGES = 40;
const MAX_STATIC = 300;
const NETWORK_TIMEOUT_MS = 8000;
// pages never kept: sign-in flows, and public pages that carry a personal code in the address
const NO_CACHE_PATHS = [/^\/login/, /^\/auth\//, /^\/verify\//, /^\/apply\//];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)));
  // a new version waits until the app says "reload" (so an open form isn't swapped out underneath someone)
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (!KEEP.includes(key)) await caches.delete(key);
    if (self.registration.navigationPreload) await self.registration.navigationPreload.enable();
    await self.clients.claim();
  })());
});

self.addEventListener("message", (event) => {
  const type = event.data && event.data.type;
  if (type === "SKIP_WAITING") self.skipWaiting();
  if (type === "SIGNED_OUT") event.waitUntil(caches.delete(PAGES));
});

async function trim(cacheName, max) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - max; i++) await cache.delete(keys[i]);
}

function timeout(ms) {
  return new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), ms));
}

async function pageRequest(event) {
  const req = event.request;
  const url = new URL(req.url);
  const cacheable = !NO_CACHE_PATHS.some((re) => re.test(url.pathname));
  try {
    const network = (event.preloadResponse || Promise.resolve(null)).then((r) => r || fetch(req));
    const res = await Promise.race([network, timeout(NETWORK_TIMEOUT_MS)]);
    // keep only a plain, successful page (not a redirect to sign-in, not an error page)
    if (cacheable && res.ok && !res.redirected && res.type === "basic" && (res.headers.get("content-type") || "").includes("text/html")) {
      const copy = res.clone();
      event.waitUntil(caches.open(PAGES).then((c) => c.put(url.pathname + url.search, copy)).then(() => trim(PAGES, MAX_PAGES)));
    }
    return res;
  } catch {
    const cached = cacheable && (await caches.match(url.pathname + url.search, { cacheName: PAGES })
      || await caches.match(url.pathname, { cacheName: PAGES, ignoreSearch: true }));
    return cached || (await caches.match(OFFLINE_URL, { cacheName: SHELL })) || Response.error();
  }
}

async function staticRequest(event) {
  const cached = await caches.match(event.request);
  if (cached) return cached;
  const res = await fetch(event.request);
  if (res.ok && (res.type === "basic" || res.type === "cors")) {
    const copy = res.clone();
    event.waitUntil(caches.open(STATIC).then((c) => c.put(event.request, copy)).then(() => trim(STATIC, MAX_STATIC)));
  }
  return res;
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;            // the API and everything else: untouched
  if (req.mode === "navigate") { event.respondWith(pageRequest(event)); return; }
  if (req.headers.get("RSC") || url.searchParams.has("_rsc")) return;   // in-app page data: always live
  if (url.pathname.startsWith("/_next/static/") || /^\/(fonts|icons|splash)\//.test(url.pathname)) {
    event.respondWith(staticRequest(event));
  }
});

// ------------------------------------------------------------------ push notifications
self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { body: event.data ? event.data.text() : "" }; }
  const title = data.title || "School notification";
  const options = {
    body: data.body || "",
    icon: "/icons/icon-192.png",
    badge: "/icons/badge-72.png",
    tag: data.tag || undefined,           // the same notification never shows twice
    data: { url: data.url || "/notifications" },
    timestamp: Date.now(),
  };
  event.waitUntil((async () => {
    await self.registration.showNotification(title, options);
    // a dot on the app icon where supported; the app shows the exact unread count when opened
    if (self.navigator.setAppBadge) { try { await self.navigator.setAppBadge(); } catch { /* not supported */ } }
  })());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL((event.notification.data && event.notification.data.url) || "/notifications", self.location.origin);
  if (target.origin !== self.location.origin) return;         // only ever opens this app's own pages
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const w of windows) {
      if (new URL(w.url).origin === self.location.origin && "focus" in w) {
        await w.focus();
        return w.navigate ? w.navigate(target.href) : undefined;
      }
    }
    return self.clients.openWindow(target.href);
  })());
});

// The push service renewed this device's address: subscribe again with the same key. The app
// sends the new address to the server the next time it is opened (it re-registers on every start).
self.addEventListener("pushsubscriptionchange", (event) => {
  const options = event.oldSubscription && event.oldSubscription.options;
  if (!options) return;
  event.waitUntil(self.registration.pushManager.subscribe(options).catch(() => undefined));
});
