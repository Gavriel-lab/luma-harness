import React, { useState } from 'react';

function webUrl(value: string) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

export function MomentPicture({ src, alt, onOpen }: { src: string; alt: string; onOpen: (src: string) => void }) {
  const [failed, setFailed] = useState(false);
  const url = webUrl(src);
  if (!url) return null;
  return failed ? (
    <button type="button" onClick={() => setFailed(false)} className="block w-full rounded-2xl bg-white/30 border border-white/40 p-5 text-xs text-stone-600">
      图片暂时加载失败，点击重试
    </button>
  ) : (
    <button type="button" onClick={() => onOpen(url)} aria-label={`查看大图：${alt}`} className="block w-full overflow-hidden rounded-2xl bg-stone-200/30 border border-white/40 cursor-zoom-in">
      <img src={url} alt={alt} referrerPolicy="no-referrer" loading="lazy" decoding="async" onError={() => setFailed(true)} className="block w-full max-h-96 object-contain" />
    </button>
  );
}

// Render image URLs as photos and ordinary source URLs as links, without raw HTML.
export function MomentText({ text, onOpen }: { text: string; onOpen: (src: string) => void }) {
  const parts: React.ReactNode[] = [];
  const tokens = /(!?\[([^\]\n]*)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<>]+))/g;
  let last = 0;
  for (const match of text.matchAll(tokens)) {
    if (match.index! > last) parts.push(text.slice(last, match.index));
    const raw = match[3] || match[4];
    const url = webUrl(raw);
    if (!url) parts.push(match[0]);
    else if (match[0].startsWith('![') || /\.(?:png|jpe?g|gif|webp|avif)(?:[?#]|$)/i.test(new URL(url).pathname)) {
      parts.push(<MomentPicture key={match.index} src={url} alt={match[2] || '动态配图'} onOpen={onOpen} />);
    } else {
      parts.push(<a key={match.index} href={url} target="_blank" rel="noreferrer noopener" className="underline underline-offset-2 break-all">{match[2] || url}</a>);
    }
    last = match.index! + match[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <div className="text-xs font-serif text-stone-800 leading-relaxed whitespace-pre-wrap break-words space-y-2">{parts}</div>;
}
