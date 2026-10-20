import React from 'react';
import type { ChatAppearance } from '../utils/chatAppearance';

// The main chat and its Xiaodu window share the same wallpaper treatment.
export function ChatWallpaper({ url, appearance }: { url: string | null; appearance: ChatAppearance }) {
  return <div aria-hidden="true" data-chat-wallpaper className="absolute inset-0 z-0 overflow-hidden pointer-events-none">
    {url ? <img src={url} alt="" referrerPolicy="no-referrer"
      className="w-full h-full object-cover scale-105 opacity-65"
      style={{ filter: `blur(${appearance.wallpaperBlur}px)` }} />
      : <div className="w-full h-full bg-gradient-to-b from-[#b8c9d4]/40 via-[#d3decb]/40 to-[#ebd8be]/40 scale-110"
        style={{ filter: `blur(${appearance.wallpaperBlur}px)` }} />}
    <div data-wallpaper-layer="linen" className="absolute inset-0 linen-texture mix-blend-multiply" style={{ opacity: appearance.linenOpacity }} />
    <div data-wallpaper-layer="veil" className="absolute inset-0 bg-[#f5eee3]" style={{ opacity: appearance.veilOpacity }} />
  </div>;
}
