/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * 桌面日记阅读偏好（字体、字号、自定义字体）
 * 独立保存在 localStorage 中，即刻生效。
 */
import { useEffect, useSyncExternalStore } from 'react';
import type { CSSProperties } from 'react';

export type DiaryFontId = 'song' | 'xiaowei' | 'system' | 'custom';
export type DiarySizeId = 'sm' | 'md' | 'lg';
export interface DiaryReadingPrefs {
  font: DiaryFontId;
  size: DiarySizeId;
  customFontCss?: string;
  customFontStyle?: string;
}

export const DIARY_FONTS: { id: DiaryFontId; label: string; note: string; stack: string; css?: string }[] = [
  {
    id: 'song',
    label: '思源宋体',
    note: '端正舒缓的书卷质感',
    stack: '"Source Han Serif SC", "Noto Serif SC", "Songti SC", "SimSun", "STSong", Georgia, serif',
    css: 'https://fonts.googleapis.com/css2?family=Noto+Serif+SC:wght@400;600&display=swap',
  },
  {
    id: 'xiaowei',
    label: '小薇',
    note: '清瘦秀丽，如钢笔信笺',
    stack: '"ZCOOL XiaoWei", "Source Han Serif SC", "Noto Serif SC", "Songti SC", serif',
    css: 'https://fonts.googleapis.com/css2?family=ZCOOL+XiaoWei&display=swap',
  },
  {
    id: 'system',
    label: '系统字',
    note: '清晰省心，自然排版',
    stack: 'system-ui, -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif',
  },
  {
    id: 'custom',
    label: '自定义',
    note: '网络字体或自定义 CSS',
    stack: 'var(--diary-custom-font, "Source Han Serif SC", "Noto Serif SC", "Songti SC", serif)',
  },
];

export const DIARY_SIZES: { id: DiarySizeId; label: string; px: number }[] = [
  { id: 'sm', label: '小', px: 15 },
  { id: 'md', label: '中', px: 16.5 },
  { id: 'lg', label: '大', px: 18 },
];

const STORAGE_KEY = 'luma-desktop-diary-reading-v1';
const DEFAULTS: DiaryReadingPrefs = { font: 'song', size: 'md' };
const listeners = new Set<() => void>();

function read(): DiaryReadingPrefs {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    return {
      font: DIARY_FONTS.some((f) => f.id === raw.font) ? raw.font : DEFAULTS.font,
      size: DIARY_SIZES.some((s) => s.id === raw.size) ? raw.size : DEFAULTS.size,
      customFontCss: typeof raw.customFontCss === 'string' ? raw.customFontCss : undefined,
      customFontStyle: typeof raw.customFontStyle === 'string' ? raw.customFontStyle : undefined,
    };
  } catch {
    return DEFAULTS;
  }
}

let current = read();

export function setDiaryReadingPrefs(patch: Partial<DiaryReadingPrefs>) {
  current = { ...current, ...patch };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(current));
  } catch {
    // ignore
  }
  listeners.forEach((l) => l());
}

function ensureFontCss(href?: string) {
  if (!href || typeof document === 'undefined' || document.querySelector(`link[data-diary-font="${href}"]`)) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = href;
  link.dataset.diaryFont = href;
  document.head.appendChild(link);
}

export function useDiaryReading() {
  const prefs = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
    () => current,
  );

  const font = DIARY_FONTS.find((f) => f.id === prefs.font) ?? DIARY_FONTS[0]!;
  const size = DIARY_SIZES.find((s) => s.id === prefs.size) ?? DIARY_SIZES[1]!;

  useEffect(() => {
    if (font.css) ensureFontCss(font.css);
  }, [font.id]);

  useEffect(() => {
    const css = prefs.customFontStyle;
    if (!css) return;
    const element = document.createElement('style');
    element.id = 'xiaowu-diary-custom-font';
    try {
      element.textContent = css;
    } catch {
      return;
    }
    document.head.appendChild(element);
    return () => element.remove();
  }, [prefs.customFontStyle]);

  const style: CSSProperties = {
    fontFamily: font.stack,
    fontSize: `${size.px}px`,
  };

  return { prefs, font, size, style };
}
