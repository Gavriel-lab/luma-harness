import React, { useEffect, useRef, useState } from 'react';
import { Upload, Type, Loader2 } from 'lucide-react';
import { applyChatFontCss, resetChatFont, uploadChatFont, useChatFont } from '../utils/chatFont';

const EXAMPLE = '@import url("https://fontsapi.zeoseven.com/256/main/result.css");\n\nbody {\n  font-family: "Huiwen-mincho";\n  font-weight: normal;\n}';
export function ChatFontPanel() {
  const font = useChatFont();
  const [tab, setTab] = useState<'local' | 'css'>('local');
  const [css, setCss] = useState('');
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (font.record?.kind === 'css') { setCss(font.record.css); setTab('css'); }
  }, [font.record]);
  return <div role="group" aria-label="聊天字体" className="space-y-2.5 border-b border-stone-300/35 pb-4">
    <div className="flex items-center justify-between text-xs text-stone-700">
      <span className="flex items-center gap-1.5"><Type className="w-3.5 h-3.5" />聊天字体</span>
      <button type="button" aria-label="恢复默认字体" disabled={font.busy} onClick={() => void resetChatFont()} className="text-[10px] text-stone-500 rounded-lg bg-white/40 px-2 py-1 disabled:opacity-50">默认字体</button>
    </div>
    <div className="flex gap-2">
      {(['local', 'css'] as const).map(id => <button key={id} type="button" aria-pressed={tab === id} onClick={() => setTab(id)} className={`flex-1 rounded-xl px-3 py-2 text-xs border ${tab === id ? 'bg-amber-100/70 border-amber-800/25 text-amber-950' : 'bg-white/30 border-white/60 text-stone-600'}`}>{id === 'local' ? '本地字体' : 'CSS 字体'}</button>)}
    </div>
    {tab === 'local' ? <div className="space-y-2">
      <input ref={input} aria-label="上传本地字体文件" type="file" accept=".ttf,.otf,.woff,.woff2" className="sr-only" disabled={font.busy} onChange={event => { const file = event.target.files?.[0]; if (file) void uploadChatFont(file); event.target.value = ''; }} />
      <button type="button" disabled={font.busy} onClick={() => input.current?.click()} className="w-full rounded-xl bg-white/55 border border-white/70 p-3 flex items-center justify-center gap-2 text-xs text-stone-700 disabled:opacity-50"><Upload className="w-3.5 h-3.5" />上传字体文件</button>
      <p className="text-[10px] text-stone-500">支持 TTF、OTF、WOFF、WOFF2，最大 30 MB。可在手机“文件”中选择。</p>
    </div> : <div className="space-y-2">
      <textarea aria-label="字体 CSS 代码" value={css} onChange={event => setCss(event.target.value)} placeholder={EXAMPLE} maxLength={20000} rows={5} spellCheck={false} className="w-full min-w-0 rounded-xl border border-stone-300/55 bg-white/55 p-2.5 text-[11px] leading-relaxed font-mono text-stone-700 resize-y" />
      <button type="button" disabled={font.busy || !css.trim()} onClick={() => void applyChatFontCss(css)} className="w-full rounded-xl px-3 py-2 text-xs bg-amber-100/70 border border-amber-800/25 text-amber-950 disabled:opacity-50">应用字体并预览</button>
      <p className="text-[10px] text-stone-500">粘贴字体网站提供的 @import / @font-face 代码，也可直接粘贴字体 CSS 链接。</p>
    </div>}
    <p role="status" className={`text-[10px] leading-relaxed break-words ${font.error ? 'text-rose-800' : 'text-stone-500'}`}>
      {font.busy ? <span className="flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" />正在加载字体…</span> : font.error || (font.record ? `已应用：${font.family} · 上方预览与聊天同步生效` : '当前使用默认字体 · 选好后在上方预览')}
    </p>
    <p className="text-[10px] text-stone-500">双方气泡一起生效，保存在当前手机。本地字体可离线使用；网络字体需要联网加载。</p>
  </div>;
}
