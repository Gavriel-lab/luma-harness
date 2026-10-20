import React, { useEffect, useRef, useState } from 'react';
import { Moon, Sun } from 'lucide-react';
import { BUNDLED_ASSETS } from '../utils/assetManager';
import { HomeFireflies } from './HomeFireflies';
import { HomePond, type PondEntryId } from './HomePond';
import { useMusic } from '../contexts/MusicContext';

interface HomePageProps {
  isNight: boolean;
  onToggleNight?: () => void;
  customDayImg?: string | null;
  customNightImg?: string | null;
  onNavigateToGarden?: () => void;
  onNavigateToChat?: () => void;
  onNavigateToDiary?: (agentId?: string) => void;
  onNavigateToStudy?: () => void;
  onNavigateToSettings?: () => void;
  onNavigateToAtelier?: () => void;
  /** 开屏还盖在上面时为 true：叶片、标题、萤火先藏着，开屏淡出时再浮上来 */
  veiled?: boolean;
}

export const HomePage: React.FC<HomePageProps> = ({
  isNight, onToggleNight, customDayImg, customNightImg,
  onNavigateToChat, onNavigateToDiary, onNavigateToStudy, onNavigateToSettings, onNavigateToAtelier, veiled = false,
}) => {
  const { openLibrary, openNowPlaying, currentTrack, isPlaying } = useMusic();
  // 真放过歌（不是默认那几首占位）才在留声机旁边摆唱片
  const nowPlaying = currentTrack && !currentTrack.id.startsWith('presets_')
    ? { cover: currentTrack.coverUrl ? `${currentTrack.coverUrl}?param=120y120` : undefined, playing: isPlaying, title: currentTrack.name }
    : null;
  // 画室页面还没做，先给一句轻提示
  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimer = useRef<number | null>(null);
  useEffect(() => () => { if (noticeTimer.current) window.clearTimeout(noticeTimer.current); }, []);

  const showNotice = (text: string) => {
    setNotice(text);
    if (noticeTimer.current) window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setNotice(null), 2400);
  };

  const handlePond = (id: PondEntryId) => {
    switch (id) {
      case 'chat': onNavigateToChat?.(); break;
      case 'diary': onNavigateToDiary?.(); break;
      case 'music': openLibrary(); break;
      case 'study': onNavigateToStudy?.(); break;
      case 'settings': onNavigateToSettings?.(); break;
      case 'atelier': onNavigateToAtelier?.(); break;
    }
  };

  return (
  <div className="home-root relative isolate w-full h-full overflow-hidden bg-stone-900" data-veiled={veiled || undefined} style={{ height: 'var(--app-height, 100dvh)' }}>
    <img
      src={isNight ? customNightImg || BUNDLED_ASSETS.nightMainPainting : customDayImg || BUNDLED_ASSETS.dayMainPainting}
      alt=""
      aria-hidden="true"
      draggable={false}
      className="absolute inset-0 w-full h-full object-cover pointer-events-none select-none"
    />
    <div className="absolute inset-0 bg-gradient-to-b from-stone-950/20 via-transparent to-stone-950/30 pointer-events-none" aria-hidden="true" />
    <HomeFireflies />
    <header
      className="home-intro absolute left-[25px] right-[25px] z-20 flex items-start justify-between gap-3 text-[#fff9ee]"
      style={{ top: 'calc(max(24px, env(safe-area-inset-top, 0px)) + 12px)', textShadow: '0 2px 8px #253a3370', '--intro-delay': '0.75s' } as React.CSSProperties}
    >
      <button className="text-left cursor-pointer rounded-md focus-visible:outline focus-visible:outline-offset-6 focus-visible:outline-[#fff8d8]" onClick={() => onNavigateToDiary?.()} aria-label="打开日记馆" title="日记馆 · 点击翻阅" style={{ textShadow: 'inherit' }}>
      <div className="font-calligraphy text-[29px] leading-[1.1] tracking-[.01em]">Mardi · Giverny</div>
      <div className="flex items-baseline gap-[7px] mt-1">
        <span className="font-calligraphy text-[24px] leading-[1.1]">{isNight ? 'Nuit Étoilée' : 'Matin Doré'}</span>
        <small className="text-[10px] tracking-[.06em]">{isNight ? '· 月夜静谧' : '· 晨光微熹'}</small>
      </div>
      </button>
      <button
        type="button"
        onClick={onToggleNight}
        aria-label={isNight ? '切换到日间模式' : '切换到夜间模式'}
        aria-pressed={isNight}
        title="切换日间 / 月夜油画景致"
        className="shrink-0 flex items-center gap-1.5 px-3 py-2 rounded-full bg-white/35 hover:bg-white/50 active:scale-95 text-stone-900 text-xs font-serif backdrop-blur-md border border-white/50 shadow-sm transition-colors cursor-pointer focus-visible:outline focus-visible:outline-offset-4 focus-visible:outline-[#fff8d8]"
        style={{ textShadow: 'none' }}
      >
        {isNight ? <Moon className="w-3.5 h-3.5 text-indigo-900" /> : <Sun className="w-3.5 h-3.5 text-amber-700" />}
        <span>{isNight ? '月夜' : '日间'}</span>
      </button>
    </header>
    <HomePond isNight={isNight} veiled={veiled} onSelect={handlePond} nowPlaying={nowPlaying} onOpenNowPlaying={openNowPlaying} />
    <div
      className="absolute inset-x-0 z-30 flex justify-center pointer-events-none"
      style={{ bottom: 'calc(max(env(safe-area-inset-bottom, 0px), 16px) + 12px)' }}
      role="status"
      aria-live="polite"
    >
      {notice && (
        <span className="px-4 py-2 rounded-full bg-[#fbf6ec]/85 backdrop-blur-md border border-white/60 text-stone-800 text-xs font-serif shadow-sm">
          {notice}
        </span>
      )}
    </div>
  </div>
  );
};
