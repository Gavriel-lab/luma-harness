/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * Luma Mobile Members R3 - Service Worker 统一安全缓存过滤器
 * 供 sw.js 与合成探针直接复用，确保 install 与 fetch 遵循完全一致的安全边界
 */

export const CACHE_PREFIX = 'luma-static-';
export const CACHE_VERSION = 'v3';
export const CACHE_NAME = `${CACHE_PREFIX}${CACHE_VERSION}`;

// 固定公开静态素材白名单（路径必须与真实 public 根目录/打包资源一致）
export const STATIC_WHITELIST = [
  '/manifest.webmanifest',
  '/icons/icon-192.svg',
  '/icons/icon-512.svg',
  '/assets/luma-day.png',
  '/assets/luma-night.jpg',
  '/assets/luma-splash.jpg'
];

export interface MinimalResponseLike {
  status: number;
  redirected: boolean;
  url?: string;
  headers: {
    get(name: string): string | null;
  };
}

/**
 * 严格的安全可缓存性校验：
 * 1. 响应状态必须为 200；
 * 2. 绝不可为重定向（response.redirected 为 true 通常为 Access 登录跳转）；
 * 3. 最终响应 URL 与请求 URL 必须同源（除白名单中的 Google Fonts）；
 * 4. 最终响应 URL 绝不可包含 Access 登录/认证特征（如 /cdn-cgi/access/, /login, cloudflareaccess.com）；
 * 5. 绝对排除 API、v1 接口、私人聊天或动态路由；
 * 6. 内容类型 (Content-Type) 绝不可包含 text/html（防止将 Access 登录 HTML 当成静态资源缓存）；
 * 7. 静态素材 Content-Type 合法性检查。
 */
export function isValidCacheableResponse(
  response: MinimalResponseLike | null | undefined,
  requestUrl?: string,
  selfOrigin = 'https://luma.local'
): boolean {
  if (!response || response.status !== 200) {
    return false;
  }
  if (response.redirected) {
    return false;
  }

  // 1. 检查请求与最终响应 URL
  const checkUrlStrings = [requestUrl, response.url].filter(Boolean) as string[];
  for (const urlStr of checkUrlStrings) {
    try {
      const u = new URL(urlStr, selfOrigin);

      // 绝不缓存 API、v1 或 Access 路径
      if (
        u.pathname.startsWith('/api') ||
        u.pathname.startsWith('/v1') ||
        u.pathname.includes('/cdn-cgi/access/') ||
        u.pathname.includes('/login') ||
        u.hostname.includes('cloudflareaccess.com')
      ) {
        return false;
      }

      // 同源或安全字体源检查
      const isSelfOrigin = u.origin === selfOrigin;
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

  // 2. 检查响应内容类型：绝对排除 HTML
  const contentType = (response.headers.get('content-type') || '').toLowerCase();
  if (contentType.includes('text/html')) {
    return false;
  }

  return true;
}

export interface CacheLike {
  put(request: any, response: any): Promise<void>;
}

export interface PrecacheResult {
  url: string;
  cached: boolean;
  reason?: string;
}

/**
 * 逐个受控预缓存：
 * 替代危险的 cache.addAll，对每个白名单资源进行严格的安全校验后才存入缓存
 */
export async function safelyPrecacheUrl(
  cache: CacheLike,
  url: string,
  fetchFn: (input: string, init?: any) => Promise<any>,
  selfOrigin = 'https://luma.local'
): Promise<PrecacheResult> {
  try {
    const res = await fetchFn(url, { redirect: 'follow' });
    if (isValidCacheableResponse(res, url, selfOrigin)) {
      await cache.put(url, typeof res.clone === 'function' ? res.clone() : res);
      return { url, cached: true };
    } else {
      const ct = res.headers ? res.headers.get('content-type') : 'unknown';
      return {
        url,
        cached: false,
        reason: `rejected: status=${res.status}, redirected=${res.redirected}, contentType=${ct}`
      };
    }
  } catch (err) {
    return {
      url,
      cached: false,
      reason: `network_error: ${err instanceof Error ? err.message : String(err)}`
    };
  }
}

/**
 * 批量受控预缓存
 */
export async function safelyPrecacheWhitelist(
  cache: CacheLike,
  whitelist: string[],
  fetchFn: (input: string, init?: any) => Promise<any>,
  selfOrigin = 'https://luma.local'
): Promise<PrecacheResult[]> {
  const results = await Promise.all(
    whitelist.map((url) => safelyPrecacheUrl(cache, url, fetchFn, selfOrigin))
  );
  return results;
}
