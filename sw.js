const CACHE_NAME = 'chuanxun-v1';

// 需要预缓存的核心资源（离线可用）
const PRECACHE_URLS = [
  '/',
  '/index.html',
  '/css/styles.css',
  '/js/config.js',
  '/js/utils.js',
  '/js/state.js',
  '/js/core.js',
  '/js/data.js',
  '/js/listeners.js',
  '/js/onboarding.js',
  '/js/backup-engine.js',
  '/js/games.js',
  '/js/features.js',
  '/js/app.js',
  '/js/features/call.js',
  '/js/features/envelope.js',
  '/js/features/group-chat.js',
  '/js/features/mood.js',
  '/js/features/reply-library.js',
  '/js/features/theme-editor.js',
  '/manifest.json'
];

// 安装阶段：预缓存核心资源
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(PRECACHE_URLS);
    }).then(() => self.skipWaiting())
  );
});

// 激活阶段：清理旧版本缓存
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(key => key !== CACHE_NAME)
          .map(key => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

// 请求拦截：优先网络，降级缓存（Network First）
// 对于本地资源使用缓存优先（Cache First）
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // 跳过非 GET 请求和 chrome-extension
  if (event.request.method !== 'GET') return;
  if (url.protocol === 'chrome-extension:') return;

  // 本地资源：缓存优先，网络兜底
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(event.request).then(cached => {
        if (cached) return cached;
        return fetch(event.request).then(response => {
          if (response && response.status === 200) {
            const responseClone = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, responseClone));
          }
          return response;
        }).catch(() => {
          // 离线且无缓存时，对 HTML 请求返回主页
          if (event.request.headers.get('accept').includes('text/html')) {
            return caches.match('/index.html');
          }
        });
      })
    );
    return;
  }

  // 外部 CDN 资源：网络优先，缓存兜底
  event.respondWith(
    fetch(event.request).then(response => {
      if (response && response.status === 200) {
        const responseClone = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(event.request, responseClone));
      }
      return response;
    }).catch(() => caches.match(event.request))
  );
});
