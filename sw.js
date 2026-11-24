const CACHE_NAME = 'chuanxun-v51';

// 需要预缓存的核心资源（离线可用）
const PRECACHE_URLS = [
  '/',
  '/index.html',
  '/css/styles.css',
  '/vendor/localforage.min.js',
  '/vendor/jszip.min.js',
  '/vendor/fontawesome/css/all.min.css',
  '/vendor/fontawesome/webfonts/fa-solid-900.woff2',
  '/vendor/fontawesome/webfonts/fa-regular-400.woff2',
  '/vendor/fontawesome/webfonts/fa-brands-400.woff2',
  '/vendor/fontawesome/webfonts/fa-v4compatibility.woff2',
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
  '/js/cloud-backup.js',
  '/js/album-sync.js',
  '/js/remote-debug.js',
  '/js/android-keepalive.js',
  '/js/back-nav.js',
  '/js/app-updater.js',
  '/js/pwa-install.js',
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

  // 跳过非 GET 请求、非同源外部请求、服务端 API、管理查看页和版本检测文件
  if (event.request.method !== 'GET') return;
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/admin') || url.pathname === '/version.json') return;

  // 本地 HTML / JS / CSS：网络优先，离线回退缓存（在线时永远立刻拿到最新版）
  if (url.origin === self.location.origin) {
    const isCodeAsset = event.request.mode === 'navigate'
      || url.pathname === '/'
      || url.pathname.endsWith('.html')
      || url.pathname.endsWith('.js')
      || url.pathname.endsWith('.css');

    if (isCodeAsset) {
      event.respondWith(
        fetch(event.request).then(response => {
          if (response && response.status === 200) {
            const responseClone = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, responseClone));
          }
          return response;
        }).catch(() => caches.match(event.request).then(cached => {
          if (cached) return cached;
          if (event.request.mode === 'navigate') return caches.match('/index.html');
        }))
      );
      return;
    }

    // 图标等静态资源：缓存优先，网络兜底
    event.respondWith(
      caches.match(event.request).then(cached => {
        if (cached) return cached;
        return fetch(event.request).then(response => {
          if (response && response.status === 200) {
            const responseClone = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, responseClone));
          }
          return response;
        });
      })
    );
    return;
  }
});
