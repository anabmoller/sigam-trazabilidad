/* SIGAM Mortalidade — service worker
   App-shell caching, stale-while-revalidate para o HTML,
   network-first para tudo o mais.
   Requests para Supabase NUNCA são cacheados. */
const CACHE_NAME = 'sigam-mortalidade-v1';
const SHELL = [
  '/mortalidade/',
  '/mortalidade/index.html',
  '/mortalidade/manifest.webmanifest'
];

self.addEventListener('install', function(event){
  event.waitUntil(
    caches.open(CACHE_NAME).then(function(cache){
      return cache.addAll(SHELL).catch(function(){ /* ignore individual failures */ });
    }).then(function(){ return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function(event){
  event.waitUntil(
    caches.keys().then(function(keys){
      return Promise.all(keys.map(function(k){
        if(k !== CACHE_NAME) return caches.delete(k);
      }));
    }).then(function(){ return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function(event){
  var req = event.request;
  if(req.method !== 'GET') return;
  var url = new URL(req.url);

  // Never cache Supabase (REST, storage, auth)
  if(url.hostname.endsWith('.supabase.co')) return;

  // Shell files: stale-while-revalidate
  if(url.pathname.startsWith('/mortalidade/')){
    event.respondWith(
      caches.match(req).then(function(cached){
        var net = fetch(req).then(function(res){
          if(res && res.ok){
            var copy = res.clone();
            caches.open(CACHE_NAME).then(function(c){ c.put(req, copy); });
          }
          return res;
        }).catch(function(){ return cached; });
        return cached || net;
      })
    );
    return;
  }

  // Default: network, fallback to cache
  event.respondWith(
    fetch(req).catch(function(){ return caches.match(req); })
  );
});
