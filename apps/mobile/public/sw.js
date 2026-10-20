/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * Luma Mobile Members R3 - Static Assets Only Service Worker
 * 严格限制：只缓存公开静态白名单素材；绝不缓存 /api、/v1、Cloudflare Access 页面或聊天消息！
 * 修复：install 阶段废弃 cache.addAll，逐个受控校验；install 与 fetch 遵循完全一致的安全边界。
 */

const CACHE_PREFIX = 'luma-static-';
const CACHE_VERSION = 'v9';
const CACHE_NAME = `${CACHE_PREFIX}${CACHE_VERSION}`;

// 固定公开静态素材白名单（路径必须与真实 public 根目录/打包资源一致）
const STATIC_WHITELIST = [
  '/manifest.webmanifest',
  '/icons/icon-192.svg',
  '/icons/icon-512.svg',
  '/assets/luma-day.png',
  '/assets/luma-night.jpg',
  '/assets/luma-splash.jpg',
  '/assets/study/study-leaf.png',
  '/assets/study/study-bg-mobile.png',
  '/assets/study/manuscript-sheets.png',
];

/**
 * 严格的安全可缓存性校验：
 * 规则统一供 install 与 fetch 复用：
 * 1. 响应状态必须为 200；
 * 2. 绝不可为重定向（response.redirected 为 true 通常为 Access 登录跳转）；
 * 3. 最终响应 URL 与请求 URL 必须同源（除白名单中的 Google Fonts）；
 * 4. 最终响应 URL 绝不可包含 Access 登录/认证特征（如 /cdn-cgi/access/, /login, cloudflareaccess.com）；
 * 5. 绝对排除 API、v1 接口、私人聊天或动态路由；
 * 6. 内容类型 (Content-Type) 绝不可包含 text/html（防止将 Access 登录 HTML 当成静态资源缓存）；
 * 7. 静态素材 Content-Type 合法性检查。
 */
function isValidCacheableResponse(response, requestUrl) {
  if (!response || response.status !== 200) {
    return false;
  }
  if (response.redirected) {
    return false;
  }

  const checkUrlStrings = [requestUrl, response.url].filter(Boolean);
  for (const urlStr of checkUrlStrings) {
    try {
      const u = new URL(urlStr, self.location.origin);

      if (
        u.pathname.startsWith('/api') ||
        u.pathname.startsWith('/v1') ||
        u.pathname.includes('/cdn-cgi/access/') ||
        u.pathname.includes('/login') ||
        u.hostname.includes('cloudflareaccess.com')
      ) {
        return false;
      }

      const isSelfOrigin = u.origin === self.location.origin;
      const isAllowedFontOrigin =
        u.origin === 'https://fonts.googleapis.com' ||
        u.origin === 'https://fonts.gstatic.com';
      if (!isSelfOrigin && !isAllowedFontOrigin) {
        return false;
      }
    } catch {
      return false;
    }
  }

  const contentType = (response.headers.get('content-type') || '').toLowerCase();
  if (contentType.includes('text/html')) {
    return false;
  }

  return true;
}

/**
 * 逐个受控预缓存，替代危险的 cache.addAll
 */
async function safelyPrecacheUrl(cache, url) {
  try {
    const res = await fetch(url, { redirect: 'follow' });
    if (isValidCacheableResponse(res, url)) {
      await cache.put(url, res);
      return { url, cached: true };
    } else {
      console.warn(`[SW] 预缓存拒绝不安全资源 (${url}): status=${res.status}, redirected=${res.redirected}, type=${res.headers.get('content-type')}`);
      return { url, cached: false, reason: 'rejected_by_security_filter' };
    }
  } catch (err) {
    console.warn(`[SW] 预缓存网络异常 (${url}):`, err);
    return { url, cached: false, reason: 'network_error' };
  }
}

/**
 * 批量受控预缓存白名单
 */
async function safelyPrecacheWhitelist(cache, whitelist) {
  const results = await Promise.all(
    whitelist.map((url) => safelyPrecacheUrl(cache, url))
  );
  return results;
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => safelyPrecacheWhitelist(cache, STATIC_WHITELIST))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => {
        // 严格仅清理本项目的旧版本缓存，只清理明确的 luma-static- 命名空间，不扩大到同域其他缓存
        return Promise.all(
          keys.map((key) => {
            if (key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME) {
              return caches.delete(key);
            }
          })
        );
      })
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);

  // 1. 严格排除非 GET 请求
  if (request.method !== 'GET') {
    return;
  }

  // 2. 严格排除同源 API、v1 接口、Cloudflare Access 认证与登录路由
  if (
    url.pathname.startsWith('/api') ||
    url.pathname.startsWith('/v1') ||
    url.pathname.includes('/cdn-cgi/access/') ||
    url.pathname.includes('/login') ||
    url.hostname.includes('cloudflareaccess.com')
  ) {
    return;
  }

  // 3. 首页与应用导航走网络，登录页绝不写缓存
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() => {
        return caches.match('/index.html').then((cached) => {
          return cached || Response.error();
        });
      })
    );
    return;
  }

  // 4. 仅对公开静态资源（白名单列表、/assets/、/icons/ 静态构建产物及 Google Fonts）提供缓存
  const isWhitelistAsset =
    url.origin === self.location.origin && STATIC_WHITELIST.includes(url.pathname);

  const isBuiltStaticAsset =
    url.origin === self.location.origin &&
    (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/icons/')) &&
    /\.(js|css|png|jpg|jpeg|svg|webp|woff2?|ttf|eot)$/i.test(url.pathname);

  const isGoogleFont =
    url.origin === 'https://fonts.googleapis.com' ||
    url.origin === 'https://fonts.gstatic.com';

  if (isWhitelistAsset || isBuiltStaticAsset || isGoogleFont) {
    event.respondWith(
      caches.match(request).then((cachedResponse) => {
        if (cachedResponse) {
          // 命中有缓存直接返回，后台轻量尝试 revalidate
          fetch(request)
            .then((networkResponse) => {
              if (isValidCacheableResponse(networkResponse, request.url)) {
                caches.open(CACHE_NAME).then((cache) => {
                  cache.put(request, networkResponse.clone());
                });
              }
            })
            .catch(() => {});
          return cachedResponse;
        }

        // 未命中则走网络，校验通过后再写入缓存
        return fetch(request).then((networkResponse) => {
          if (isValidCacheableResponse(networkResponse, request.url)) {
            const responseToCache = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(request, responseToCache);
            });
          }
          return networkResponse;
        });
      })
    );
  }
});

// 支持客户端发起注销或清空缓存消息
self.addEventListener('message', (event) => {
  if (event.data && event.data.action === 'skipWaiting') {
    self.skipWaiting();
  }
  if (event.data && event.data.action === 'clearCache') {
    caches.delete(CACHE_NAME);
  }
});
