/**
 * 音乐馆的个人偏好：正在播放页的背景、歌词字体与字号，以及「最近播放」。
 * 全部只存在这台手机上。
 */
import { useEffect, useSyncExternalStore } from 'react';
import type { CSSProperties } from 'react';
import { createFontSlot } from './fontSlot';
import type { MusicTrack } from '../types/music';

// ---------------- 歌词字体 ----------------

export type LyricFontId = 'song' | 'xiaowei' | 'system' | 'custom';
export type LyricSizeId = 'sm' | 'md' | 'lg';
export type MusicBgMode = 'cover' | 'custom';
export interface MusicPrefs { font: LyricFontId; size: LyricSizeId; bg: MusicBgMode }

/** 使用者自己上传 / 粘贴的歌词字体，跟聊天、日记分开存 */
export const lyricFontSlot = createFontSlot({
  db: 'luma-music-fonts-v1',
  cssVar: '--music-lyric-custom-font',
  dataKey: 'musicLyricFont',
  aliasPrefix: 'LumaLyricFont',
  fallback: '"Noto Serif SC", "Songti SC", serif',
  sample: '风雨里追赶 雾里分不清影踪 La vie 123',
});

export const LYRIC_FONTS: { id: LyricFontId; label: string; stack: string; css?: string }[] = [
  { id: 'song', label: '宋体', stack: '"Noto Serif SC", "Songti SC", "STSong", serif', css: 'https://fonts.googleapis.com/css2?family=Noto+Serif+SC:wght@400;600&display=swap' },
  { id: 'xiaowei', label: '小薇', stack: '"ZCOOL XiaoWei", "Noto Serif SC", "Songti SC", serif', css: 'https://fonts.googleapis.com/css2?family=ZCOOL+XiaoWei&display=swap' },
  { id: 'system', label: '系统字', stack: '-apple-system, "PingFang SC", "Microsoft YaHei", sans-serif' },
  { id: 'custom', label: '我的字体', stack: 'var(--music-lyric-custom-font, "Noto Serif SC", "Songti SC", serif)', css: 'https://fonts.googleapis.com/css2?family=Noto+Serif+SC:wght@400;600&display=swap' },
];

export const LYRIC_SIZES: { id: LyricSizeId; label: string; px: number }[] = [
  { id: 'sm', label: '小', px: 14 },
  { id: 'md', label: '中', px: 16 },
  { id: 'lg', label: '大', px: 18.5 },
];

const PREFS_KEY = 'luma-music-prefs-v1';
const DEFAULTS: MusicPrefs = { font: 'song', size: 'md', bg: 'cover' };
const listeners = new Set<() => void>();

function readPrefs(): MusicPrefs {
  try {
    const raw = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}');
    return {
      font: LYRIC_FONTS.some((f) => f.id === raw.font) ? raw.font : DEFAULTS.font,
      size: LYRIC_SIZES.some((s) => s.id === raw.size) ? raw.size : DEFAULTS.size,
      bg: raw.bg === 'custom' ? 'custom' : 'cover',
    };
  } catch {
    return DEFAULTS;
  }
}
let prefs = readPrefs();

export function setMusicPrefs(patch: Partial<MusicPrefs>) {
  prefs = { ...prefs, ...patch };
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* 存不下就只在本次生效 */ }
  listeners.forEach((l) => l());
}

function ensureFontCss(href?: string) {
  if (!href || document.querySelector(`link[data-music-font="${href}"]`)) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = href;
  link.dataset.musicFont = href;
  document.head.appendChild(link);
}

export function preloadLyricFonts() {
  LYRIC_FONTS.forEach((f) => ensureFontCss(f.css));
}

export function useMusicPrefs() {
  const current = useSyncExternalStore(
    (l) => { listeners.add(l); return () => { listeners.delete(l); }; },
    () => prefs,
  );
  const font = LYRIC_FONTS.find((f) => f.id === current.font) || LYRIC_FONTS[0];
  const size = LYRIC_SIZES.find((s) => s.id === current.size) || LYRIC_SIZES[1];
  lyricFontSlot.useFont();
  useEffect(() => { ensureFontCss(font.css); }, [font.css]);
  return {
    prefs: current,
    style: { '--lyric-font': font.stack, '--lyric-size': `${size.px}px` } as CSSProperties,
  };
}

// ---------------- 自定义壁纸（IndexedDB，压缩后存） ----------------

const WP_DB = 'luma-music-wallpaper-v1';
let wallpaper: string | null = null;
let wallpaperLoaded = false;
const wpListeners = new Set<() => void>();

function wpStore(op: 'get' | 'put' | 'delete', value?: string): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(WP_DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore('kv');
    req.onerror = () => reject(new Error('无法打开壁纸存储'));
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction('kv', op === 'get' ? 'readonly' : 'readwrite');
      const store = tx.objectStore('kv');
      const r = op === 'get' ? store.get('wallpaper') : op === 'put' ? store.put(value, 'wallpaper') : store.delete('wallpaper');
      tx.oncomplete = () => { db.close(); resolve(op === 'get' ? (r.result as string) || null : null); };
      tx.onabort = () => { db.close(); reject(new Error('壁纸没有存上，可能是手机空间不足')); };
    };
  });
}

function setWallpaperState(v: string | null) {
  wallpaper = v;
  wpListeners.forEach((l) => l());
}

/** 压到最长边 1600px 的 JPEG，手机上看足够清楚，也不会塞爆存储 */
function compress(file: File, max = 1600, quality = 0.84): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('这张图读不出来，换一张试试')); };
    img.onload = () => {
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL('image/jpeg', quality));
    };
    img.src = url;
  });
}

export async function uploadMusicWallpaper(file: File) {
  if (!file.type.startsWith('image/')) throw new Error('请选择一张图片');
  const data = await compress(file);
  await wpStore('put', data);
  setWallpaperState(data);
  setMusicPrefs({ bg: 'custom' });
}

export async function removeMusicWallpaper() {
  await wpStore('delete');
  setWallpaperState(null);
  setMusicPrefs({ bg: 'cover' });
}

export function useMusicWallpaper() {
  const v = useSyncExternalStore(
    (l) => { wpListeners.add(l); return () => { wpListeners.delete(l); }; },
    () => wallpaper,
  );
  useEffect(() => {
    if (wallpaperLoaded) return;
    wallpaperLoaded = true;
    wpStore('get').then(setWallpaperState).catch(() => {});
  }, []);
  return v;
}

// ---------------- 最近播放 ----------------
// 先只记这台手机上的播放（使用者）。家人自己听歌要等电脑小屋那边接上，
// 到时候同一首歌的 listeners 里会多出他们的名字。

export interface HistoryEntry { track: MusicTrack; listeners: string[]; lastPlayedAt: number }

const HISTORY_KEY = 'luma-music-history-v1';
const HISTORY_MAX = 200;
const historyListeners = new Set<() => void>();

function readHistory(): HistoryEntry[] {
  try {
    const raw = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
    return Array.isArray(raw) ? raw.filter((e) => e && e.track && e.track.id) : [];
  } catch {
    return [];
  }
}
let history = readHistory();

export function recordPlay(track: MusicTrack, listener = '使用者') {
  if (!track || track.id.startsWith('presets_')) return;
  const slim: MusicTrack = {
    id: track.id, name: track.name, artists: track.artists, albumName: track.albumName,
    coverUrl: track.coverUrl, duration: track.duration, fee: track.fee,
  };
  const prev = history.find((e) => e.track.id === track.id);
  const listenersOf = prev ? Array.from(new Set([...prev.listeners, listener])) : [listener];
  history = [{ track: slim, listeners: listenersOf, lastPlayedAt: Date.now() }, ...history.filter((e) => e.track.id !== track.id)].slice(0, HISTORY_MAX);
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(history)); } catch { /* ignore */ }
  historyListeners.forEach((l) => l());
}

export function clearHistory() {
  history = [];
  try { localStorage.removeItem(HISTORY_KEY); } catch { /* ignore */ }
  historyListeners.forEach((l) => l());
}

export function useMusicHistory() {
  return useSyncExternalStore(
    (l) => { historyListeners.add(l); return () => { historyListeners.delete(l); }; },
    () => history,
  );
}
