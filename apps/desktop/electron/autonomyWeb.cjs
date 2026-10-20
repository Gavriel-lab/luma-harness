'use strict';
const dns = require('node:dns/promises');
const net = require('node:net');
const path = require('node:path');
function publicAddress(ip) {
  if (net.isIP(ip) === 4) return !/^(?:0|10|127|169\.254|192\.168|172\.(?:1[6-9]|2\d|3[01])|22[4-9]|23\d|24\d|25\d)\./.test(ip);
  const value = ip.toLowerCase();
  if (value.startsWith('::ffff:')) return publicAddress(value.slice(7));
  return net.isIP(ip) === 6 && !/^(?:::|f[cd]|fe[89ab]|ff)/.test(value);
}
async function publicUrl(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw Error('只读取公开网页');
  const addresses = await dns.lookup(url.hostname.replace(/^\[|\]$/g, ''), { all: true });
  if (!addresses.length || addresses.some(a => !publicAddress(a.address))) throw Error('此地址不是公开网页');
  return url;
}
function decode(text) {
  return text.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&#(x[\da-f]+|\d+);/gi, (_, n) => {
    const point = n[0].toLowerCase() === 'x' ? parseInt(n.slice(1), 16) : Number(n);
    return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : '';
  }).replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (_, key) => ({amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' '}[key]));
}
function plain(html) {
  return decode(html.replace(/<(script|style|noscript|svg|nav|footer)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<!--[^]*?-->/g, '').replace(/<(?:br|\/p|\/div|\/h[1-6]|\/li|\/article)\b[^>]*>/gi, '\n').replace(/<[^>]*>/g, ' '))
    .replace(/[\t \r]+/g, ' ').replace(/\n\s*\n+/g, '\n\n').trim();
}
async function download(value, signal) {
  let url = await publicUrl(value);
  for (let redirects = 0; redirects < 6; redirects++) {
    const response = await fetch(url, {redirect:'manual', headers:{'user-agent':'Luma-FamilyWalk/1.0',accept:'text/html,application/rss+xml,application/xml,text/plain'}, signal:AbortSignal.any([signal || new AbortController().signal, AbortSignal.timeout(22000)])});
    if ([301,302,303,307,308].includes(response.status)) { await response.body?.cancel(); url = await publicUrl(new URL(response.headers.get('location'), url).href); continue; }
    if (!response.ok) { await response.body?.cancel(); throw Error('网页暂时打不开（HTTP '+response.status+'）'); }
    if (!/(?:text\/|xml|html|json)/i.test(response.headers.get('content-type') || '')) { await response.body?.cancel(); throw Error('这个链接不是可阅读的网页'); }
    const reader = response.body.getReader(), chunks = []; let size = 0;
    try { while (true) { const {done,value} = await reader.read(); if (done) break; size += value.length; if (size > 1500000) throw Error('网页过大，换一个页面看看'); chunks.push(Buffer.from(value)); } }
    finally { await reader.cancel().catch(()=>{}); }
    return {url:url.href, raw:Buffer.concat(chunks).toString('utf8')};
  }
  throw Error('网页跳转过多');
}
function rssResults(raw) {
  const field = (s, name) => decode(s.match(new RegExp('<'+name+'(?:\\s[^>]*)?>([\\s\\S]*?)<\\/'+name+'>','i'))?.[1] || '').trim();
  return [...raw.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)].map(m=>({title:plain(field(m[1],'title')),url:field(m[1],'link'),snippet:plain(field(m[1],'description')).slice(0,500)})).filter(x=>/^https?:\/\//.test(x.url)).slice(0,8);
}
async function search(query, signal) {
  if (typeof query !== 'string' || !query.trim() || query.length > 220) throw Error('请给一个简短的搜索词');
  const {raw} = await download('https://html.duckduckgo.com/html/?q='+encodeURIComponent(query), signal);
  const results = duckResults(raw); if (!results.length) throw Error('这次搜索没取得可读结果，可能需要验证，换个主题或下次再逛');
  return {query,results};
}
function duckResults(raw) {
  const results=[];
  for(const match of raw.matchAll(/<a\b([^>]+)>([\s\S]*?)<\/a>/gi)) {
    if(!/class=["'][^"']*\bresult__a\b/.test(match[1]))continue;
    const href=decode(match[1].match(/href=["']([^"']+)["']/)?.[1]||'');
    try {
      const link=new URL(href,'https://duckduckgo.com'),url=link.searchParams.get('uddg')||link.href;
      if(!/^https?:\/\//.test(url))continue;
      const tail=raw.slice(match.index+match[0].length,match.index+match[0].length+4500);
      const snippet=tail.match(/class=["'][^"']*result__snippet[^"']*["'][^>]*>([\s\S]*?)<\/(?:a|div)>/i)?.[1]||'';
      results.push({title:plain(match[2]),url,snippet:plain(snippet).slice(0,450)});
    } catch {}
    if(results.length===8)break;
  }
  return results;
}
function extractImages(raw, baseUrl) {
  const images = [];
  const og = raw.match(/<meta\b[^>]*property=["'](?:og:image|twitter:image)["'][^>]*content=["']([^"']+)["']/i)
    || raw.match(/<meta\b[^>]*content=["']([^"']+)["'][^>]*property=["'](?:og:image|twitter:image)["']/i);
  if (og?.[1]) {
    try { images.push(new URL(decode(og[1]), baseUrl).href); } catch {}
  }
  for (const match of raw.matchAll(/<img\b[^>]*src=["']([^"']+)["'][^>]*>/gi)) {
    const src = decode(match[1]);
    if (!src || src.startsWith('data:') || src.includes('.svg') || src.includes('icon') || src.includes('avatar') || src.includes('pixel') || src.includes('badge')) continue;
    try {
      const full = new URL(src, baseUrl).href;
      if (!images.includes(full)) images.push(full);
    } catch {}
    if (images.length >= 6) break;
  }
  return images;
}

function imageMime(b) {
  if (b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png';
  if (b[0]===255 && b[1]===216 && b[2]===255) return 'image/jpeg';
  if (b.subarray(0,6).toString().match(/^GIF8[79]a$/)) return 'image/gif';
  if (b.subarray(0,4).toString()==='RIFF' && b.subarray(8,12).toString()==='WEBP') return 'image/webp';
  if (b.length > 16 && (b.subarray(4,12).toString()==='ftypavif' || b.subarray(4,12).toString()==='ftypavis')) return 'image/avif';
  return null;
}

async function downloadImage(value, signal) {
  let cleanedValue = value.replace(/([?&])auto=format(&|$)/i, '$1').replace(/[?&]$/, '');
  let url = await publicUrl(cleanedValue);
  for (let redirects = 0; redirects < 6; redirects++) {
    const response = await fetch(url, {
      redirect: 'manual',
      headers: { 
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Luma-FamilyWalk/1.0', 
        accept: 'image/jpeg,image/png,image/webp,image/*;q=0.8' 
      },
      signal: AbortSignal.any([signal || new AbortController().signal, AbortSignal.timeout(20000)])
    });
    if ([301,302,303,307,308].includes(response.status)) {
      await response.body?.cancel();
      url = await publicUrl(new URL(response.headers.get('location'), url).href);
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw Error('图片下载失败（HTTP ' + response.status + '）');
    }
    const reader = response.body.getReader(), chunks = [];
    let size = 0;
    try {
      while (true) {
        const { done, value: chunk } = await reader.read();
        if (done) break;
        size += chunk.length;
        if (size > 10 * 1024 * 1024) throw Error('图片过大');
        chunks.push(Buffer.from(chunk));
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    const bytes = Buffer.concat(chunks);
    const mime = imageMime(bytes);
    if (!mime) throw Error('下载的文件不是合法的图片格式');
    const parsedUrl = new URL(url.href);
    let name = path.basename(parsedUrl.pathname) || 'image.jpg';
    if (!name.includes('.')) name += mime === 'image/png' ? '.png' : mime === 'image/webp' ? '.webp' : '.jpg';
    return { name, dataBase64: bytes.toString('base64'), mimeType: mime, size: bytes.length, sourceUrl: url.href };
  }
  throw Error('图片跳转过多');
}

async function read(url, signal) {
  const page = await download(url, signal);
  const text = plain(page.raw), title = plain(page.raw.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] || page.url);
  if (text.length < 120 || /^(?:Just a moment|Access Denied|Attention Required)/i.test(title)) throw Error('没有取得正文，可能需要登录或验证');
  const images = extractImages(page.raw, page.url);
  return { url: page.url, title: title.slice(0, 180), text: text.slice(0, 9000), images, readAt: Date.now() };
}
module.exports = { search, read, plain, rssResults, duckResults, publicAddress, downloadImage, extractImages, imageMime };

