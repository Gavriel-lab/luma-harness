/**
 * 阅读偏好：字体、字号。只存在这台手机上，不需要桌面在线。
 * 日记和书房各存一份，互不影响；中文网络字体走 Google Fonts，按需切片下载。
 */
import { useEffect, useSyncExternalStore } from 'react';
import type { CSSProperties } from 'react';
import { createFontSlot } from './fontSlot';

export type DiaryFontId = 'song' | 'xiaowei' | 'system' | 'custom';
export type DiarySizeId = 'sm' | 'md' | 'lg';
export interface DiaryReadingPrefs { font: DiaryFontId; size: DiarySizeId }

const SONG_CSS = 'https://fonts.googleapis.com/css2?family=Noto+Serif+SC:wght@400;600&display=swap';

function fontsFor(cssVar: string): { id: DiaryFontId; label: string; note: string; stack: string; css?: string }[] {
  return [
    { id: 'song', label: '宋体', note: '端正的书页感', stack: '"Noto Serif SC", "Songti SC", "STSong", serif', css: SONG_CSS },
    {
      id: 'xiaowei',
      label: '小薇',
      note: '清瘦一点，像钢笔字',
      stack: '"ZCOOL XiaoWei", "Noto Serif SC", "Songti SC", serif',
      css: 'https://fonts.googleapis.com/css2?family=ZCOOL+XiaoWei&display=swap',
    },
    { id: 'system', label: '系统字', note: '不用下载，最省流量', stack: '-apple-system, "PingFang SC", "Microsoft YaHei", sans-serif' },
    { id: 'custom', label: '我的字体', note: '自己上传或粘贴的', stack: `var(${cssVar}, "Noto Serif SC", "Songti SC", serif)`, css: SONG_CSS },
  ];
}

export const DIARY_SIZES: { id: DiarySizeId; label: string; px: number }[] = [
  { id: 'sm', label: '小', px: 15 },
  { id: 'md', label: '中', px: 16.5 },
  { id: 'lg', label: '大', px: 18 },
];

/** 网络字体的样式表只插一次 */
function ensureFontCss(href?: string) {
  if (!href || document.querySelector(`link[data-diary-font="${href}"]`)) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = href;
  link.dataset.diaryFont = href;
  document.head.appendChild(link);
}

interface ReadingStoreOptions {
  /** localStorage 键 */
  key: string;
  /** 自定义字体存哪个库、用哪个 CSS 变量 */
  db: string;
  cssVar: string;
  dataKey: string;
  aliasPrefix: string;
  /** 面板里提示「只用在哪里」 */
  scope: string;
}

export function createReadingStore(opts: ReadingStoreOptions) {
  const fontSlot = createFontSlot({
    db: opts.db,
    cssVar: opts.cssVar,
    dataKey: opts.dataKey,
    aliasPrefix: opts.aliasPrefix,
    fallback: '"Noto Serif SC", "Songti SC", serif',
    sample: '今日案头整理完毕，夜色微凉。Bonjour 123',
  });
  const fonts = fontsFor(opts.cssVar);
  const defaults: DiaryReadingPrefs = { font: 'song', size: 'md' };
  const listeners = new Set<() => void>();

  const read = (): DiaryReadingPrefs => {
    try {
      const raw = JSON.parse(localStorage.getItem(opts.key) || '{}');
      return {
        font: fonts.some((f) => f.id === raw.font) ? raw.font : defaults.font,
        size: DIARY_SIZES.some((s) => s.id === raw.size) ? raw.size : defaults.size,
      };
    } catch {
      return defaults;
    }
  };
  let current = read();

  const setPrefs = (patch: Partial<DiaryReadingPrefs>) => {
    current = { ...current, ...patch };
    try { localStorage.setItem(opts.key, JSON.stringify(current)); } catch { /* 存不下就只在本次生效 */ }
    listeners.forEach((l) => l());
  };

  /** 读取偏好，并把对应字体挂上；返回给页面用的 CSS 变量（--diary-font / --diary-size） */
  const useReading = () => {
    const prefs = useSyncExternalStore(
      (l) => { listeners.add(l); return () => { listeners.delete(l); }; },
      () => current,
    );
    const font = fonts.find((f) => f.id === prefs.font) || fonts[0];
    const size = DIARY_SIZES.find((s) => s.id === prefs.size) || DIARY_SIZES[1];
    // 打开页面就把存过的自定义字体恢复出来
    fontSlot.useFont();
    useEffect(() => { ensureFontCss(font.css); }, [font.css]);
    return {
      prefs,
      style: { '--diary-font': font.stack, '--diary-size': `${size.px}px` } as CSSProperties,
    };
  };

  /** 设置面板里预览用：把所有可选字体都挂上 */
  const preload = () => fonts.forEach((f) => ensureFontCss(f.css));

  return { fonts, fontSlot, setPrefs, useReading, preload, scope: opts.scope };
}

export type ReadingStore = ReturnType<typeof createReadingStore>;

/** 日记的阅读偏好（原来的存法不变，之前装的字体照样在） */
export const diaryReading = createReadingStore({
  key: 'luma-diary-reading-v1',
  db: 'luma-diary-fonts-v1',
  cssVar: '--diary-custom-font',
  dataKey: 'diaryFont',
  aliasPrefix: 'LumaDiaryFont',
  scope: '日记',
});

/** 书房的阅读偏好，跟日记分开存 */
export const studyReading = createReadingStore({
  key: 'luma-study-reading-v1',
  db: 'luma-study-fonts-v1',
  cssVar: '--study-custom-font',
  dataKey: 'studyFont',
  aliasPrefix: 'LumaStudyFont',
  scope: '书房',
});

// 旧名字，日记页继续用
export const diaryFontSlot = diaryReading.fontSlot;
export const DIARY_FONTS = diaryReading.fonts;
export const setDiaryReadingPrefs = diaryReading.setPrefs;
export const useDiaryReading = diaryReading.useReading;
export const preloadDiaryFonts = diaryReading.preload;
