import React, { useState, useRef } from 'react';
import { Palette, RotateCcw } from 'lucide-react';
import { ChatFontPanel } from './ChatFontPanel';
import { resetChatFont } from '../utils/chatFont';
import { BUBBLE_THEMES, DEFAULT_APPEARANCE, PREVIEW_USER_STYLE, PREVIEW_COMPANION_STYLE, bubbleAppearance, useChatAppearance, useLiquidGlass } from '../utils/chatAppearance';

const SWATCHES = ['#8fa4b2', '#c69390', '#889c89', '#ebb778', '#ebe1d4', '#453b46'];
const TEXT_SWATCHES = ['#2a2724', '#fffaf2', '#6e5268', '#36566b', '#44634d', '#8d482f'];
export function ChatAppearancePanel({ background }: { background: string | null }) {
  const { appearance, update, saveError } = useChatAppearance();
  const panelRef = useRef<HTMLElement | null>(null);
  useLiquidGlass(panelRef);
  const [target, setTarget] = useState<'user' | 'companion'>('companion');
  const colorKey = target === 'user' ? 'userColor' : 'companionColor';
  const opacityKey = target === 'user' ? 'userOpacity' : 'companionOpacity';
  const textKey = target === 'user' ? 'userTextColor' : 'companionTextColor';
  const automaticInk = bubbleAppearance(appearance, target === 'user' ? PREVIEW_USER_STYLE : PREVIEW_COMPANION_STYLE, target === 'user').color;
  const textColor = appearance[textKey] || (automaticInk === '#fffaf2' ? '#fffaf2' : '#2a2724');
  const color = appearance[colorKey] || (target === 'user' ? '#ebe1d4' : '#8fa4b2');
  const transparency = Math.round(100 - (appearance[opacityKey] ?? (target === 'user' ? .85 : .45)) * 100);
  return <section ref={panelRef} aria-label="聊天调色盘" className="space-y-2">
    <div className="flex items-center justify-between px-1">
      <h2 className="text-xs text-stone-500 tracking-widest flex items-center gap-2"><Palette className="w-3.5 h-3.5" />聊天调色盘</h2>
      <button type="button" onClick={() => { update({ ...DEFAULT_APPEARANCE }); void resetChatFont(); }} className="flex items-center gap-1 text-[11px] text-stone-600 py-1.5" aria-label="恢复默认聊天外观"><RotateCcw className="w-3 h-3" />恢复默认</button>
    </div>
    <div className="bg-white/40 rounded-3xl p-3.5 border border-white/60 shadow-xs space-y-4 min-w-0">
      <div aria-label="聊天外观预览" className="relative overflow-hidden rounded-2xl border border-white/70 p-4 min-h-44">
        <div aria-hidden="true" className="absolute inset-0 scale-105 bg-gradient-to-b from-[#b8c9d4]/40 via-[#d3decb]/40 to-[#ebd8be]/40" style={{ filter: `blur(${appearance.wallpaperBlur}px)` }}>
          {background && <img src={background} alt="" referrerPolicy="no-referrer" className="w-full h-full object-cover opacity-65" />}
        </div>
        <div data-wallpaper-layer="linen" className="absolute inset-0 linen-texture mix-blend-multiply" style={{ opacity: appearance.linenOpacity }} />
        <div data-wallpaper-layer="veil" className="absolute inset-0 bg-[#f5eee3]" style={{ opacity: appearance.veilOpacity }} />
        <div className="relative space-y-3 text-sm font-sans leading-relaxed">
          <p className="text-[10px] text-stone-500 font-serif tracking-wider">APERÇU · 实时预览</p>
          <div data-bubble-style={appearance.bubbleTheme} style={bubbleAppearance(appearance, PREVIEW_COMPANION_STYLE, false)} className="paint-blot px-3 py-2 max-w-[85%]">今天的小屋，也有你喜欢的<strong>颜色</strong>。</div>
          <div data-bubble-style={appearance.bubbleTheme} style={bubbleAppearance(appearance, PREVIEW_USER_STYLE, true)} className="paint-blot-user px-3 py-2 max-w-[85%] ml-auto"><strong>嗯</strong>，就把聊天调成这样～</div>
        </div>
      </div>
      <ChatFontPanel />
      <label className="block text-xs text-stone-700 space-y-2">
        <span className="flex justify-between"><span>壁纸模糊</span><span className="text-stone-500 tabular-nums">{appearance.wallpaperBlur} px</span></span>
        <input aria-label="壁纸模糊" type="range" min="0" max="24" step="1" value={appearance.wallpaperBlur} onChange={event => update({ ...appearance, wallpaperBlur: Number(event.target.value) })} className="w-full accent-amber-700" />
        <span className="flex justify-between text-[10px] text-stone-500"><span>清晰</span><span>柔雾</span></span>
      </label>
      <div className="flex gap-2" role="group" aria-label="选择调色对象">
        {(['companion', 'user'] as const).map(id => <button key={id} type="button" aria-pressed={target === id} onClick={() => setTarget(id)} className={`flex-1 rounded-xl px-3 py-2 text-xs border ${target === id ? 'bg-amber-100/70 border-amber-800/25 text-amber-950' : 'bg-white/30 border-white/60 text-stone-600'}`}>{id === 'user' ? '我的气泡' : '伙伴气泡'}</button>)}
      </div>
      <div className="space-y-2">
        <div className="flex items-center justify-between text-xs text-stone-700"><span>气泡颜色</span><label className="flex items-center gap-2 text-[10px] text-stone-500">自选<input aria-label="气泡自选颜色" type="color" value={color} onChange={event => update({ ...appearance, [colorKey]: event.target.value })} className="w-8 h-8 rounded-lg cursor-pointer" /></label></div>
        <div className="flex justify-between gap-2" role="group" aria-label="气泡色卡">{SWATCHES.map(swatch => <button key={swatch} type="button" aria-label={`选择颜色 ${swatch}`} aria-pressed={color === swatch} onClick={() => update({ ...appearance, [colorKey]: swatch })} style={{ backgroundColor: swatch }} className={`w-8 h-8 shrink-0 rounded-full border-2 border-white shadow-xs ${color === swatch ? 'outline outline-1 outline-offset-2 outline-stone-500' : ''}`} />)}</div>
      </div>
      <div className="space-y-2">
        <div className="flex items-center justify-between text-xs text-stone-700"><span>文字颜色</span>
          <div className="flex items-center gap-2"><button type="button" aria-label="使用自动文字颜色" aria-pressed={appearance[textKey] === null} onClick={() => update({ ...appearance, [textKey]: null })} className={`px-2 py-1 rounded-lg text-[10px] ${appearance[textKey] === null ? 'bg-amber-100/70 text-amber-950' : 'bg-white/40 text-stone-600'}`}>自动</button>
            <label className="flex items-center gap-2 text-[10px] text-stone-500">自选<input aria-label="文字自选颜色" type="color" value={textColor} onChange={event => update({ ...appearance, [textKey]: event.target.value })} className="w-8 h-8 rounded-lg cursor-pointer" /></label>
          </div>
        </div>
        <div className="flex justify-between gap-2" role="group" aria-label="文字色卡">{TEXT_SWATCHES.map(swatch => <button key={swatch} type="button" aria-label={`选择文字颜色 ${swatch}`} aria-pressed={appearance[textKey] === swatch} onClick={() => update({ ...appearance, [textKey]: swatch })} style={{ backgroundColor: swatch }} className={`w-8 h-8 shrink-0 rounded-full border-2 border-white shadow-xs ${appearance[textKey] === swatch ? 'outline outline-1 outline-offset-2 outline-stone-500' : ''}`} />)}</div>
      </div>
      <label className="block text-xs text-stone-700 space-y-2"><span className="flex justify-between"><span>气泡透明度</span><span className="text-stone-500 tabular-nums">{transparency}%</span></span>
        <input aria-label="气泡透明度" type="range" min="0" max="100" value={transparency} onChange={event => update({ ...appearance, [opacityKey]: 1 - Number(event.target.value) / 100 })} className="w-full accent-amber-700" />
        <span className="flex justify-between text-[10px] text-stone-500"><span>实色</span><span>透明</span></span>
      </label>
      {([
        { key: 'veilOpacity', label: '奶油色蒙层透明度' },
        { key: 'linenOpacity', label: '亚麻纹理透明度' },
      ] as const).map(layer => {
        const value = Math.round((1 - appearance[layer.key]) * 100);
        return <label key={layer.key} className="block text-xs text-stone-700 space-y-2">
          <span className="flex justify-between"><span>{layer.label}</span><span className="text-stone-500 tabular-nums">{value}%</span></span>
          <input aria-label={layer.label} type="range" min="0" max="100" value={value} onChange={event => update({ ...appearance, [layer.key]: 1 - Number(event.target.value) / 100 })} className="w-full accent-amber-700" />
          <span className="flex justify-between text-[10px] text-stone-500"><span>浓一些</span><span>完全隐藏</span></span>
        </label>;
      })}
      <div className="space-y-2"><p className="text-xs text-stone-700">气泡样式 <span className="text-[10px] text-stone-500 ml-1">左右滑动试试看</span></p>
        <div role="group" aria-label="气泡样式" className="flex gap-2 overflow-x-auto overscroll-x-contain touch-pan-x pb-2 px-1 no-scrollbar snap-x snap-mandatory">
          {BUBBLE_THEMES.map(theme => <button key={theme.id} type="button" aria-label={`${theme.name}气泡`} aria-pressed={appearance.bubbleTheme === theme.id} onClick={() => update({ ...appearance, bubbleTheme: theme.id })} className={`shrink-0 w-24 rounded-2xl p-2.5 border snap-start ${appearance.bubbleTheme === theme.id ? 'border-amber-700/50 bg-amber-50/70' : 'border-white/70 bg-white/35'}`}>
            <span data-bubble-style={theme.id} style={bubbleAppearance(appearance, PREVIEW_COMPANION_STYLE, false)} className="paint-blot block px-2 py-1.5 mb-2 text-xs font-sans">Bonjour</span><span className="block text-xs text-stone-800">{theme.name}</span><span className="block text-[10px] text-stone-500 mt-1">{theme.note}</span>
          </button>)}
        </div>
      </div>
      <p role="status" className={`text-[10px] leading-relaxed ${saveError ? 'text-rose-800' : 'text-stone-500'}`}>{saveError ? '外观尚未保存：手机存储空间不足，请先腾出空间后再调整。' : '自动保存在当前手机，私聊、群聊和小度气泡一起生效。未改色的伙伴保留各自配色。'}</p>
    </div>
  </section>;
}
