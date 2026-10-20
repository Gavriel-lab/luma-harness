import React, { useLayoutEffect, useRef } from 'react';
import { X, Radio } from 'lucide-react';
import { Message } from '../types';
import { ChatAppearance, useLiquidGlass } from '../utils/chatAppearance';
import { ChatWallpaper } from './ChatWallpaper';
import './xiaoduFloating.css';

// Desktop supplies the authoritative channel tags. Request IDs also survive older caches.
export const isXiaoduMessage = (message: Message) => message.sourceChannel === 'xiaodu'
  || (!message.sourceChannel && /^(?:req_)?xiaodu_/.test(message.requestId || ''));
const isDeviceEvent = (message: Message) => message.eventKind === 'device-event'
  || /^(?:req_)?xiaodu_event_/.test(message.requestId || '');

function timeline(messages: Message[]) {
  const rows: { messages: Message[]; device: boolean }[] = [];
  for (const message of messages) {
    const device = isDeviceEvent(message);
    const previous = rows.at(-1);
    if (device && previous?.device) previous.messages.push(message);
    else rows.push({ messages: [message], device });
  }
  return rows;
}

export function XiaoduChannelModal({ messages, renderMessage, onClose, error, wallpaperUrl, appearance }: {
  messages: Message[];
  renderMessage: (message: Message) => React.ReactNode;
  onClose: () => void;
  error: string | null;
  wallpaperUrl: string | null;
  appearance: ChatAppearance;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useLiquidGlass(dialogRef, appearance.bubbleTheme === 'liquid');
  const viewportRef = useRef<HTMLDivElement>(null);
  const followLatestRef = useRef(true);
  useLayoutEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    const panel = dialogRef.current;
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); onClose(); }
    };
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('keydown', handleKey);
      // Never steal focus back from the main composer when this nonmodal panel closes.
      if (panel?.contains(document.activeElement)) previousFocus?.focus({ preventScroll: true });
    };
  }, [onClose]);
  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (viewport && followLatestRef.current) viewport.scrollTop = viewport.scrollHeight;
  }, [messages]);

  return (
      <div ref={dialogRef} id="xiaodu-channel" role="dialog" aria-modal="false" aria-labelledby="xiaodu-channel-title"
        className="xiaodu-floating min-w-0 flex flex-col rounded-2xl overflow-hidden border border-white/80 bg-[#f5eee3] shadow-xl">
        <ChatWallpaper url={wallpaperUrl} appearance={appearance} />
        <header className="relative flex items-center justify-between gap-2 px-3 py-1.5 shrink-0 bg-white/45 border-b border-white/60">
          <div><h2 id="xiaodu-channel-title" className="flex items-center gap-1.5 text-stone-800 text-xs font-serif"><Radio className="w-3.5 h-3.5" />小度陪伴</h2>
            <p className="text-[9px] text-stone-600 mt-0.5">记忆共享 · 主聊天可继续输入</p></div>
          <button type="button" onClick={onClose} aria-label="关闭小度陪伴" className="p-2 rounded-full text-stone-600 hover:bg-white/60"><X className="w-4 h-4" /></button>
        </header>
        {error && <p role="status" className="relative px-3 py-1 text-[10px] text-amber-900 bg-amber-100/60">同步中，先显示已收到的记录</p>}
        <div ref={viewportRef} aria-label="小度消息" tabIndex={0} className="xiaodu-floating-messages relative flex-1 min-h-0 min-w-0 overflow-y-auto overflow-x-hidden overscroll-contain touch-pan-y px-2 py-2 space-y-2.5"
          onScroll={event => { const node = event.currentTarget; followLatestRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 100; }}>
          {!messages.length && <p className="text-center text-xs text-stone-600 py-6">小度的交谈会出现在这里</p>}
          {timeline(messages).map(row => row.device ?
            <details key={row.messages[0].id} className="rounded-xl bg-white/35 border border-white/70 px-2 py-1.5 text-stone-600">
              <summary className="cursor-pointer text-[10px]">设备唤醒记录 · {new Set(row.messages.map(message => message.requestId || message.id)).size} 轮</summary>
              <div className="space-y-2.5 pt-2">{row.messages.map(renderMessage)}</div>
            </details> : renderMessage(row.messages[0]))}
        </div>
      </div>
  );
}
