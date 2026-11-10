/* DAMM+ service worker — cacheable app shell with on-delivery brand normalization. */
const CACHE = "damm-plus-static-v38";
const CORE = ["./", "./index.html", "./styles.css", "./app.js", "./manifest.webmanifest", "./icon.svg"];

function rebrand(response) {
  if (!response || !response.ok) return response;
  const type = response.headers.get("content-type") || "";
  if (!/(text\/html|javascript|json|manifest)/i.test(type)) return response;
  return response.text().then(text => {
    // Keep service/API hostnames and compatibility identifiers intact; normalize user-facing brand text.
    text = text.replace(/\bDammPulse(?:\s*360)?\+?(?![-\w])/gi, "DAMM+");
    text = text.replace(/\bDAMM\+\s+PULSE\b/gi, "DAMM+");
    const headers = new Headers(response.headers);
    headers.delete("content-length");
    headers.delete("content-encoding");
    return new Response(text, { status: response.status, statusText: response.statusText, headers });
  });
}

self.addEventListener("install", event => event.waitUntil((async () => {
  const cache = await caches.open(CACHE);
  await Promise.all(CORE.map(async path => {
    try {
      const response = await fetch(path, { cache: "no-store" });
      if (response.ok) await cache.put(path, await rebrand(response.clone()));
    } catch { /* Continue installation if an optional shell resource is unavailable. */ }
  }));
  await self.skipWaiting();
})()));

self.addEventListener("activate", event => event.waitUntil((async () => {
  const keys = await caches.keys();
  await Promise.all(keys.filter(key => key !== CACHE && (key.startsWith("dammpulse-static-") || key.startsWith("damm-plus-static-"))).map(key => caches.delete(key)));
  await self.clients.claim();
})()));

self.addEventListener("fetch", event => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  const isShellResource = request.mode === "navigate" || [".js", ".css", ".webmanifest", ".svg"].some(ext => url.pathname.endsWith(ext)) || url.pathname.endsWith("/");
  if (!isShellResource) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cacheKey = request.mode === "navigate" ? "./index.html" : request;
    try {
      const response = await fetch(request);
      if (response.ok) {
        const branded = await rebrand(response.clone());
        await cache.put(cacheKey, branded.clone());
        return branded;
      }
      return response;
    } catch {
      const cached = await cache.match(cacheKey);
      if (cached) return rebrand(cached);
      if (request.mode === "navigate") return new Response("Sin conexión. Comprueba la red y vuelve a intentarlo.", { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } });
      return new Response("", { status: 503 });
    }
  })());
});
