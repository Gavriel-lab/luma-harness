import React, { useEffect, useRef, useState, type CSSProperties } from 'react';
import './homePond.css';

// 首页睡莲池：功能入口漂在水面上，点一下荡开水波再进入。
// 位置用容器单位（cqw/cqh），桌面预览外框和真机都按手机画面排布。

export type PondEntryId = 'chat' | 'diary' | 'music' | 'study' | 'atelier' | 'settings';

interface PondEntry {
  id: PondEntryId;
  src: string;
  french: string;
  label: string;
  ariaLabel: string;
  /** 画面位置与大小（容器百分比） */
  style: CSSProperties;
  /** 漂浮节奏，错开避免整齐划一 */
  drift: { duration: number; delay: number; tilt: number };
  /** 主入口字号更大 */
  hero?: boolean;
}

const asset = (name: string) => `${import.meta.env.BASE_URL}assets/pond/${name}.webp`;

const ENTRIES: PondEntry[] = [
  {
    id: 'diary', src: asset('diary'), french: 'Journal', label: '日记', ariaLabel: '打开日记',
    style: { left: '5cqw', top: '16cqh', width: 'min(40cqw, 21cqh)' },
    drift: { duration: 9.5, delay: -2.1, tilt: -1.6 },
  },
  {
    id: 'music', src: asset('music'), french: 'Musique', label: '音乐', ariaLabel: '打开音乐馆',
    style: { right: '5cqw', top: '23cqh', width: 'min(40cqw, 21cqh)' },
    drift: { duration: 11, delay: -5.4, tilt: 1.4 },
  },
  {
    id: 'chat', src: asset('lily'), french: 'Bavarder', label: '聊天', ariaLabel: '打开聊天',
    style: { left: '50%', top: '38cqh', width: 'min(54cqw, 28cqh)', translate: '-50% 0' },
    drift: { duration: 10, delay: -0.8, tilt: 1 },
    hero: true,
  },
  {
    id: 'study',
    src: `${import.meta.env.BASE_URL}assets/study/study-leaf.png`,
    french: 'Bibliothèque',
    label: '书房',
    ariaLabel: '打开书房',
    style: { left: '4cqw', top: '59cqh', width: 'min(38cqw, 20cqh)' },
    drift: { duration: 10.8, delay: -4.2, tilt: -1.5 },
  },
  {
    id: 'atelier', src: asset('workbox'), french: 'Atelier', label: '工作台', ariaLabel: '打开工作台',
    style: { right: '4cqw', top: '63cqh', width: 'min(38cqw, 20cqh)' },
    drift: { duration: 12, delay: -7.2, tilt: -1.2 },
  },
  {
    id: 'settings', src: asset('palette'), french: 'Réglages', label: '设置', ariaLabel: '打开设置',
    style: { left: '50%', top: '80cqh', width: 'min(26cqw, 14cqh)', translate: '-50% 0' },
    drift: { duration: 10.5, delay: -3.6, tilt: 1.8 },
  },
];

// 纯装饰的空叶片，让水面不显得空
const DECOR_PADS: { style: CSSProperties; duration: number; delay: number }[] = [
  { style: { left: '56cqw', top: '15cqh', width: 'min(17cqw, 9cqh)', opacity: 0.5 }, duration: 14, delay: -4 },
  { style: { left: '7cqw', top: '86cqh', width: 'min(18cqw, 10cqh)', opacity: 0.45, rotate: '160deg' }, duration: 16, delay: -9 },
];

const RIPPLE_MS = 420;

interface HomePondProps {
  isNight: boolean;
  veiled?: boolean;
  onSelect: (id: PondEntryId) => void;
  /** 有歌在放时，留声机旁边的小唱片 */
  nowPlaying?: { cover?: string; playing: boolean; title: string } | null;
  onOpenNowPlaying?: () => void;
}

// 开屏淡出时叶片浮上来的先后：中间的睡莲先，四周依次跟上
const INTRO_ORDER: Record<PondEntryId, number> = {
  chat: 0,
  diary: 1,
  music: 2,
  study: 3,
  atelier: 4,
  settings: 5,
};

export function HomePond({ isNight, veiled = false, onSelect, nowPlaying, onOpenNowPlaying }: HomePondProps) {
  const [pressed, setPressed] = useState<PondEntryId | null>(null);
  const [paused, setPaused] = useState(() => document.visibilityState === 'hidden');
  const timer = useRef<number | null>(null);

  // 切到后台时停掉漂浮动画，省电
  useEffect(() => {
    const sync = () => setPaused(document.visibilityState === 'hidden');
    document.addEventListener('visibilitychange', sync);
    return () => {
      document.removeEventListener('visibilitychange', sync);
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, []);

  const handleTap = (id: PondEntryId) => {
    if (pressed) return; // 水波还没散，忽略连点
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced) {
      onSelect(id);
      return;
    }
    setPressed(id);
    timer.current = window.setTimeout(() => {
      setPressed(null);
      onSelect(id);
    }, RIPPLE_MS);
  };

  return (
    <div className="home-pond" data-night={isNight} data-paused={paused} data-veiled={veiled || undefined}>
      {DECOR_PADS.map((pad, i) => (
        <img
          key={i}
          src={asset('pad')}
          alt=""
          aria-hidden="true"
          draggable={false}
          className="home-pond-decor"
          style={{ ...pad.style, '--drift-duration': `${pad.duration}s`, '--drift-delay': `${pad.delay}s`, '--drift-tilt': '0.8deg' } as CSSProperties}
        />
      ))}

      <nav className="home-pond-nav" aria-label="主要功能">
        {ENTRIES.map((entry) => (
          <button
            key={entry.id}
            type="button"
            className="home-pond-entry"
            data-hero={entry.hero || undefined}
            data-pressed={pressed === entry.id || undefined}
            aria-label={entry.ariaLabel}
            onClick={() => handleTap(entry.id)}
            style={{
              ...entry.style,
              '--drift-duration': `${entry.drift.duration}s`,
              '--drift-delay': `${entry.drift.delay}s`,
              '--drift-tilt': `${entry.drift.tilt}deg`,
              '--intro-delay': `${0.25 + INTRO_ORDER[entry.id] * 0.13}s`,
            } as CSSProperties}
          >
            <span className="home-pond-float">
              <span className="home-pond-shadow" aria-hidden="true" />
              <img src={entry.src} alt="" draggable={false} className="home-pond-art" />
              {pressed === entry.id && (
                <span className="home-pond-ripple" aria-hidden="true">
                  <span /><span />
                </span>
              )}
            </span>
            <span className="home-pond-label" aria-hidden="true">
              <span className="home-pond-french font-calligraphy">{entry.french}</span>
              <span className="home-pond-cn">{entry.label}</span>
            </span>
          </button>
        ))}
      </nav>

      {nowPlaying && (
        <button
          type="button"
          className="home-pond-record"
          data-playing={nowPlaying.playing || undefined}
          onClick={onOpenNowPlaying}
          aria-label={`正在播放：${nowPlaying.title}，点开看歌词`}
        >
          <span className="home-pond-record-disc">
            {nowPlaying.cover && <img src={nowPlaying.cover} alt="" draggable={false} />}
          </span>
        </button>
      )}
    </div>
  );
}
