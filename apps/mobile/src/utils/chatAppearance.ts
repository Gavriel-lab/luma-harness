import { useEffect, useState, CSSProperties, RefObject } from 'react';
import '../vendor/hyalite/hyalite.js';
import { useChatFont } from './chatFont';

export type BubbleTheme = 'french' | 'vintage' | 'liquid' | 'pixel' | 'letter';
export interface ChatAppearance {
  wallpaperBlur: number;
  veilOpacity: number;
  linenOpacity: number;
  bubbleTheme: BubbleTheme;
  userColor: string | null;
  companionColor: string | null;
  userTextColor: string | null;
  companionTextColor: string | null;
  userOpacity: number | null;
  companionOpacity: number | null;
}
export const APPEARANCE_KEY = 'luma_chat_appearance_v1';
const EVENT = 'luma_chat_appearance_updated';
export const DEFAULT_APPEARANCE: ChatAppearance = {
  wallpaperBlur: 7, bubbleTheme: 'french', userColor: null, companionColor: null,
  userOpacity: null, companionOpacity: null,
  veilOpacity: .65, linenOpacity: .45,
  userTextColor: null, companionTextColor: null,
};
export const BUBBLE_THEMES: { id: BubbleTheme; name: string; note: string }[] = [
  { id: 'french', name: '法式', note: '柔软水彩' },
  { id: 'vintage', name: '复古', note: '旧信纸笺' },
  { id: 'liquid', name: '液态', note: '透亮玻璃' },
  { id: 'pixel', name: '像素', note: '方格游戏' },
  { id: 'letter', name: '信笺', note: '莫奈信纸' },
];
function normalize(raw: Partial<ChatAppearance>): ChatAppearance {
  const color = (value: unknown) => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value : null;
  const opacity = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : null;
  return {
    wallpaperBlur: typeof raw.wallpaperBlur === 'number' && Number.isFinite(raw.wallpaperBlur) ? Math.max(0, Math.min(24, raw.wallpaperBlur)) : 7,
    veilOpacity: opacity(raw.veilOpacity) ?? .65,
    linenOpacity: opacity(raw.linenOpacity) ?? .45,
    bubbleTheme: BUBBLE_THEMES.some(theme => theme.id === raw.bubbleTheme) ? raw.bubbleTheme! : 'french',
    userColor: color(raw.userColor), companionColor: color(raw.companionColor),
    userTextColor: color(raw.userTextColor), companionTextColor: color(raw.companionTextColor),
    userOpacity: opacity(raw.userOpacity), companionOpacity: opacity(raw.companionOpacity),
  };
}
export function readChatAppearance(): ChatAppearance {
  try { return normalize(JSON.parse(localStorage.getItem(APPEARANCE_KEY) || '{}') || {}); }
  catch { return { ...DEFAULT_APPEARANCE }; }
}
export function useChatAppearance() {
  useChatFont();
  const [appearance, setAppearance] = useState(readChatAppearance);
  const [saveError, setSaveError] = useState(false);
  useEffect(() => {
    const refresh = () => setAppearance(readChatAppearance());
    const storage = (event: StorageEvent) => { if (event.key === APPEARANCE_KEY || event.key === null) refresh(); };
    window.addEventListener(EVENT, refresh);
    window.addEventListener('storage', storage);
    return () => { window.removeEventListener(EVENT, refresh); window.removeEventListener('storage', storage); };
  }, []);
  const update = (value: ChatAppearance) => {
    const next = normalize(value);
    setAppearance(next);
    try { localStorage.setItem(APPEARANCE_KEY, JSON.stringify(next)); setSaveError(false); window.dispatchEvent(new Event(EVENT)); }
    catch { setSaveError(true); }
  };
  return { appearance, update, saveError };
}

// Local Hyalite 0.5.0, MIT VII-Cae. Each viewport owns only its visible lenses.
export function useLiquidGlass(container: RefObject<HTMLElement | null>, active = true) {
  useEffect(() => {
    const root = container.current;
    if (!root || !active) return;
    const engine = window.Hyalite;
    const reduced = window.matchMedia('(prefers-reduced-transparency: reduce)');
    const selector = '[data-bubble-style="liquid"]';
    const observed = new Set<HTMLElement>();
    const attached = new Set<HTMLElement>();
    const detach = (node: HTMLElement) => {
      engine.detach(node); attached.delete(node); delete node.dataset.glassEngine;
    };
    const visible = new IntersectionObserver(entries => {
      for (const entry of entries) {
        const node = entry.target as HTMLElement;
        if (!entry.isIntersecting || !root.contains(node) || !node.matches(selector) || reduced.matches) { detach(node); continue; }
        if (attached.has(node)) continue;
        if (engine.supported()) engine.attach(node, {
          bevel: 20, thickness: 32, slope: 2.4, shape: 'squircle', blur: 1,
          dispersion: 0, shade: .4, rim: 1.6, edge: .42, edgeW: 7, sat: 1,
          materialize: 0, settle: 0,
        });
        node.dataset.glassEngine = engine.supported() ? 'refraction' : 'compatible';
        attached.add(node);
      }
    }, { root, rootMargin: '100px' });
    const reconcile = () => {
      const nodes = new Set(root.querySelectorAll<HTMLElement>(selector));
      for (const node of observed) if (!nodes.has(node)) { visible.unobserve(node); detach(node); observed.delete(node); }
      for (const node of nodes) if (!observed.has(node)) { observed.add(node); visible.observe(node); }
    };
    const refreshPreference = () => {
      for (const node of observed) { detach(node); visible.unobserve(node); visible.observe(node); }
    };
    const mutations = new MutationObserver(reconcile);
    mutations.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-bubble-style'] });
    reduced.addEventListener('change', refreshPreference);
    reconcile();
    return () => {
      mutations.disconnect(); visible.disconnect(); reduced.removeEventListener('change', refreshPreference);
      observed.forEach(detach);
    };
  }, [container, active]);
}

export const PREVIEW_USER_STYLE: CSSProperties = { backgroundColor: 'rgba(235,225,212,.85)', border: '1px solid rgba(198,147,144,.65)', color: 'var(--ink)' };
export const PREVIEW_COMPANION_STYLE: CSSProperties = { backgroundColor: 'rgba(143,164,178,.45)', border: '1px solid rgba(143,164,178,.58)', color: 'var(--ink)' };

export function bubbleAppearance(appearance: ChatAppearance, base: CSSProperties, isUser: boolean): CSSProperties {
  base = { ...base, fontFamily: 'var(--chat-bubble-font, ui-sans-serif, system-ui, sans-serif)' };
  const color = isUser ? appearance.userColor : appearance.companionColor;
  const alpha = isUser ? appearance.userOpacity : appearance.companionOpacity;
  const textColor = isUser ? appearance.userTextColor : appearance.companionTextColor;
  if (color === null && alpha === null) return textColor
    ? { ...base, color: textColor, '--bubble-ink': textColor, '--bubble-custom-ink': textColor } as CSSProperties
    : base;
  const match = String(base.backgroundColor).match(/rgba?\(\s*(\d+),\s*(\d+),\s*(\d+)(?:,\s*([.\d]+))?\)/);
  const rgb = color ? [1, 3, 5].map(offset => parseInt(color.slice(offset, offset + 2), 16)) : match ? match.slice(1, 4).map(Number) : [220, 220, 220];
  const opacity = alpha ?? (match?.[4] ? Number(match[4]) : 1);
  const blended = rgb.map((channel, index) => channel * opacity + [245, 238, 227][index] * (1 - opacity));
  const luminance = blended.reduce((sum, channel, index) => {
    const s = channel / 255, linear = s <= .04045 ? s / 12.92 : ((s + .055) / 1.055) ** 2.4;
    return sum + linear * [.2126, .7152, .0722][index];
  }, 0);
  const ink = textColor || (luminance < .18 ? '#fffaf2' : 'var(--ink)');
  return { ...base, backgroundColor: `rgba(${rgb.join(',')},${opacity})`,
    border: color ? `1px solid rgba(${rgb.join(',')},${Math.max(.35, opacity)})` : base.border,
    color: ink, '--bubble-ink': ink, '--bubble-custom-ink': textColor || undefined,
  } as CSSProperties;
}
