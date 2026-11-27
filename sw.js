/**
 * ============================================================================
 * Service Worker：应用外壳离线缓存
 * ----------------------------------------------------------------------------
 * 设计取舍：
 *   - 只缓存"外壳"（index/css/js/图标/manifest），课程与任务数据在 localStorage，
 *     不经过网络，因此不需要、也不应该在这里缓存。
 *   - stale-while-revalidate：先用缓存立即打开，后台拉新版本写回缓存，
 *     下次启动即生效。这样手机上离线可用，更新也不会被永久钉住。
 *   - 只在 http/https 下注册（见 app.js），`file://` 直接打开时本文件不会被激活。
 *   - 发版时把 VERSION 加一，旧缓存会在 activate 阶段被清掉。
 * ============================================================================
 */
'use strict';

var VERSION = 'v1-2026-11-28';
var CACHE_NAME = 'course-manager-' + VERSION;

/** 应用外壳：缺一个都不影响启动，但缺了对应功能会失效 */
var SHELL = [
  './',
  './index.html',
  './css/styles.css',
  './js/timetable.js',
  './js/import-service.js',
  './js/swap-log.js',
  './js/sections.js',
  './js/ringtone.js',
  './js/catalog.js',
  './js/app.js',
  './manifest.webmanifest',
  './assets/icons/favicon.svg',
  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png',
  './assets/icons/icon-maskable-512.png',
  './assets/icons/apple-touch-icon-180.png'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then(function (cache) {
        // 逐个 add，单个 404 不会让整次安装失败
        return Promise.all(
          SHELL.map(function (url) {
            return cache.add(new Request(url, { cache: 'reload' })).catch(function () {
              return null;
            });
          })
        );
      })
      .then(function () {
        return self.skipWaiting();
      })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches
      .keys()
      .then(function (keys) {
        return Promise.all(
          keys.map(function (key) {
            if (key !== CACHE_NAME && key.indexOf('course-manager-') === 0) {
              return caches.delete(key);
            }
            return null;
          })
        );
      })
      .then(function () {
        return self.clients.claim();
      })
  );
});

self.addEventListener('fetch', function (event) {
  var request = event.request;
  if (request.method !== 'GET') {
    return;
  }

  var url;
  try {
    url = new URL(request.url);
  } catch (e) {
    return;
  }

  // 只处理同源资源；识别服务的跨域请求一律不缓存、不拦截
  if (url.origin !== self.location.origin) {
    return;
  }

  // 导航请求：网络优先，断网时回落到缓存的 index.html（保证从主屏图标能进应用）
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then(function (response) {
          var copy = response.clone();
          caches.open(CACHE_NAME).then(function (cache) {
            cache.put('./index.html', copy).catch(function () {});
          });
          return response;
        })
        .catch(function () {
          return caches.match('./index.html').then(function (cached) {
            return cached || caches.match('./');
          });
        })
    );
    return;
  }

  event.respondWith(
    caches.match(request).then(function (cached) {
      var network = fetch(request)
        .then(function (response) {
          if (response && response.ok) {
            var copy = response.clone();
            caches.open(CACHE_NAME).then(function (cache) {
              cache.put(request, copy).catch(function () {});
            });
          }
          return response;
        })
        .catch(function () {
          return cached;
        });
      return cached || network;
    })
  );
});
