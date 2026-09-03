const CACHE = "psd-passvoice-v2";
const SHELL = [
  "./", "./index.html", "./app.css", "./app.js", "./manifest.json",
  "./icon.svg", "./icon-192.png", "./icon-512.png", "./apple-touch-icon.png", "./sm-logo-mark.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (url.origin === location.origin) {
    e.respondWith(
      caches.match(e.request).then((cached) => cached || fetch(e.request))
    );
  }
  // 다른 출처(예: Tesseract.js CDN)는 브라우저 기본 캐시에 맡긴다.
});
