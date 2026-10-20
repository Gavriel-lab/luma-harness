/**
 * 正在播放：照莫奈壁纸的排法——整屏虚化的画，中间挂一幅封面，下面是歌名和歌词。
 * 背景跟着封面走，也可以换成使用者自己的壁纸；歌词字体、字号可调。
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronDown, Type, SkipBack, SkipForward, Play, Pause, Repeat, Repeat1, Shuffle,
  ListMusic, Loader2, Upload, X,
} from 'lucide-react';
import { useMusic } from '../../contexts/MusicContext';
import { musicApi } from '../../utils/musicApi';
import { parseLyrics, activeLineIndex, type LyricLine } from '../../utils/lyrics';
import {
  LYRIC_FONTS, LYRIC_SIZES, lyricFontSlot, preloadLyricFonts, setMusicPrefs, useMusicPrefs,
  useMusicWallpaper, uploadMusicWallpaper, removeMusicWallpaper,
} from '../../utils/musicPrefs';
import type { PlayMode } from '../../types/music';
import './music.css';

const FALLBACK_BG = `${import.meta.env.BASE_URL}assets/luma-day.webp`;
const lyricCache = new Map<string, LyricLine[] | null>();

const fmt = (sec: number) => {
  const s = Math.max(0, Math.floor(sec || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

const MODE_NEXT: Record<PlayMode, PlayMode> = { sequence: 'loop', loop: 'random', random: 'sequence' };
const MODE_LABEL: Record<PlayMode, string> = { sequence: '顺序播放', loop: '单曲循环', random: '随机播放' };

export const NowPlaying: React.FC = () => {
  const {
    isNowPlayingOpen, closeNowPlaying, openLibrary, currentTrack, isPlaying, isLoading,
    currentTime, duration, togglePlay, playNext, playPrev, seek, playMode, setPlayMode, error,
  } = useMusic();
  const { prefs, style } = useMusicPrefs();
  const wallpaper = useMusicWallpaper();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [lyrics, setLyrics] = useState<LyricLine[] | null | undefined>(undefined);
  const [dragTime, setDragTime] = useState<number | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const reduced = useMemo(() => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches, []);

  // 歌词：换歌就取一次，取过的记住
  const trackId = currentTrack?.id;
  useEffect(() => {
    if (!isNowPlayingOpen || !trackId) return;
    if (trackId.startsWith('presets_')) { setLyrics(null); return; }
    if (lyricCache.has(trackId)) { setLyrics(lyricCache.get(trackId)); return; }
    let alive = true;
    setLyrics(undefined);
    musicApi.getLyric(trackId)
      .then((r) => {
        const lines = r.pureMusic ? null : parseLyrics(r.lrc, r.tlyric);
        const value = lines && lines.length ? lines : null;
        lyricCache.set(trackId, value);
        if (alive) setLyrics(value);
      })
      .catch(() => { if (alive) setLyrics(null); });
    return () => { alive = false; };
  }, [trackId, isNowPlayingOpen]);

  const active = lyrics ? activeLineIndex(lyrics, currentTime) : -1;

  // 当前那句滚到歌词区中间
  useEffect(() => {
    const box = listRef.current;
    if (!box || active < 0) return;
    const el = box.querySelector<HTMLElement>(`[data-line="${active}"]`);
    if (!el) return;
    box.scrollTo({ top: el.offsetTop - box.clientHeight / 2 + el.clientHeight / 2, behavior: reduced ? 'auto' : 'smooth' });
  }, [active, reduced]);

  // 关掉时顺手收起设置
  useEffect(() => { if (!isNowPlayingOpen) setSettingsOpen(false); }, [isNowPlayingOpen]);

  if (!isNowPlayingOpen) return null;

  const cover = currentTrack?.coverUrl ? `${currentTrack.coverUrl}?param=600y600` : '';
  const bg = prefs.bg === 'custom' && wallpaper ? wallpaper : cover || FALLBACK_BG;
  const usingCustom = prefs.bg === 'custom' && !!wallpaper;
  const total = duration || currentTrack?.duration || 0;
  const shown = dragTime ?? currentTime;
  const pct = total ? Math.min(100, (shown / total) * 100) : 0;
  const ModeIcon = playMode === 'loop' ? Repeat1 : playMode === 'random' ? Shuffle : Repeat;

  return (
    <div className="np-root" role="dialog" aria-modal="true" aria-label="正在播放" style={style}>
      <div className="np-bg" data-custom={usingCustom || undefined} style={{ backgroundImage: `url("${bg}")` }} aria-hidden="true" />
      <div className="np-veil" data-custom={usingCustom || undefined} aria-hidden="true" />

      <header className="np-top">
        <button type="button" className="np-icon" onClick={closeNowPlaying} aria-label="收起正在播放">
          <ChevronDown className="w-5 h-5" />
        </button>
        <span className="np-brand font-calligraphy">Salon Musical</span>
        <button type="button" className="np-icon" onClick={() => setSettingsOpen(true)} aria-label="背景与歌词字体">
          <Type className="w-[18px] h-[18px]" />
        </button>
      </header>

      <div className="np-body">
        <figure className="np-frame">
          <div className="np-mat">
            {cover ? <img src={cover} alt={currentTrack?.albumName || currentTrack?.name || '封面'} className="np-cover" />
              : <div className="np-cover np-cover-empty font-calligraphy">Musique</div>}
          </div>
        </figure>

        <div className="np-meta">
          <h2 className="np-title">{currentTrack?.name || '还没有在放的歌'}</h2>
          <p className="np-artist">{currentTrack ? `${currentTrack.artists}${currentTrack.albumName ? ` · ${currentTrack.albumName}` : ''}` : '去音乐馆挑一首吧'}</p>
        </div>

        <div className="np-lyrics" ref={listRef} aria-live="off">
          {lyrics === undefined ? (
            <p className="np-lyric-empty"><Loader2 className="w-4 h-4 animate-spin inline" aria-hidden="true" /> 正在翻歌词…</p>
          ) : lyrics === null ? (
            <p className="np-lyric-empty font-calligraphy">Musique sans paroles</p>
          ) : (
            <div className="np-lyric-list">
              {lyrics.map((l, i) => (
                <button
                  type="button"
                  key={`${l.time}-${i}`}
                  data-line={i}
                  data-active={i === active || undefined}
                  className="np-line"
                  onClick={() => seek(l.time)}
                  aria-label={`从这句开始：${l.text}`}
                >
                  <span>{l.text}</span>
                  {l.translation && <small>{l.translation}</small>}
                </button>
              ))}
            </div>
          )}
        </div>

        {error && <p className="np-error" role="status">{error}</p>}

        <div className="np-progress">
          <div className="np-track" aria-hidden="true">
            <div className="np-fill" style={{ width: `${pct}%` }} />
            <div className="np-pearl" style={{ left: `${pct}%` }} />
          </div>
          <input
            type="range"
            min={0}
            max={Math.max(1, Math.round(total))}
            step={1}
            value={Math.round(shown)}
            aria-label="播放进度"
            aria-valuetext={`${fmt(shown)} / ${fmt(total)}`}
            onChange={(e) => setDragTime(Number(e.target.value))}
            onPointerUp={() => { if (dragTime !== null) { seek(dragTime); setDragTime(null); } }}
            onKeyUp={() => { if (dragTime !== null) { seek(dragTime); setDragTime(null); } }}
            onTouchEnd={() => { if (dragTime !== null) { seek(dragTime); setDragTime(null); } }}
            className="np-range"
          />
          <div className="np-times"><span>{fmt(shown)}</span><span>{fmt(total)}</span></div>
        </div>

        <div className="np-controls">
          <button type="button" className="np-ctl np-ctl-sm" onClick={() => setPlayMode(MODE_NEXT[playMode])} aria-label={`播放方式：${MODE_LABEL[playMode]}，点一下切换`}>
            <ModeIcon className="w-[18px] h-[18px]" />
          </button>
          <button type="button" className="np-ctl" onClick={playPrev} aria-label="上一首"><SkipBack className="w-6 h-6" /></button>
          <button type="button" className="np-play" onClick={togglePlay} aria-label={isPlaying ? '暂停' : '播放'}>
            {isLoading ? <Loader2 className="w-7 h-7 animate-spin" /> : isPlaying ? <Pause className="w-7 h-7" /> : <Play className="w-7 h-7 translate-x-[2px]" />}
          </button>
          <button type="button" className="np-ctl" onClick={playNext} aria-label="下一首"><SkipForward className="w-6 h-6" /></button>
          <button type="button" className="np-ctl np-ctl-sm" onClick={() => { closeNowPlaying(); openLibrary(); }} aria-label="打开音乐馆">
            <ListMusic className="w-[18px] h-[18px]" />
          </button>
        </div>
      </div>

      {settingsOpen && <NowPlayingSettings onClose={() => setSettingsOpen(false)} />}
    </div>
  );
};

const CSS_EXAMPLE = '@import url("https://fontsapi.zeoseven.com/256/main/result.css");\n\nbody {\n  font-family: "Huiwen-mincho";\n}';

/** Aa：背景、歌词字体、字号、自定义字体 */
const NowPlayingSettings: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const { prefs } = useMusicPrefs();
  const wallpaper = useMusicWallpaper();
  const custom = lyricFontSlot.useFont();
  const [customOpen, setCustomOpen] = useState(false);
  const [tab, setTab] = useState<'local' | 'css'>('local');
  const [css, setCss] = useState('');
  const [wpBusy, setWpBusy] = useState(false);
  const [wpError, setWpError] = useState('');
  const wpInput = useRef<HTMLInputElement>(null);
  const fontInput = useRef<HTMLInputElement>(null);

  useEffect(() => { preloadLyricFonts(); }, []);
  useEffect(() => { if (custom.record?.kind === 'css') { setCss(custom.record.css); setTab('css'); } }, [custom.record]);
  const fonts = LYRIC_FONTS.filter((f) => f.id !== 'custom' || custom.record);
  const afterApply = (ok: boolean) => { if (ok) setMusicPrefs({ font: 'custom' }); };

  return (
    <div className="np-sheet-wrap" onClick={onClose}>
      <div className="np-sheet" role="dialog" aria-modal="true" aria-label="背景与歌词" onClick={(e) => e.stopPropagation()}>
        <div className="np-sheet-head">
          <span className="font-calligraphy np-sheet-title">Réglages</span>
          <button type="button" className="np-sheet-close" onClick={onClose} aria-label="关闭"><X className="w-4 h-4" /></button>
        </div>

        <section className="np-sec">
          <h3>背景</h3>
          <div className="np-seg" role="radiogroup" aria-label="背景">
            <button type="button" role="radio" aria-checked={prefs.bg === 'cover'} data-active={prefs.bg === 'cover' || undefined} onClick={() => setMusicPrefs({ bg: 'cover' })}>跟着封面</button>
            <button
              type="button"
              role="radio"
              aria-checked={prefs.bg === 'custom'}
              data-active={prefs.bg === 'custom' || undefined}
              onClick={() => (wallpaper ? setMusicPrefs({ bg: 'custom' }) : wpInput.current?.click())}
            >
              我的壁纸
            </button>
          </div>
          <input
            ref={wpInput}
            type="file"
            accept="image/*"
            className="sr-only"
            aria-label="上传播放页壁纸"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (!file) return;
              setWpBusy(true); setWpError('');
              try { await uploadMusicWallpaper(file); } catch (err) { setWpError((err as Error).message); }
              finally { setWpBusy(false); }
            }}
          />
          <div className="np-row">
            {wallpaper && <img src={wallpaper} alt="" className="np-wp-thumb" />}
            <button type="button" className="np-btn" disabled={wpBusy} onClick={() => wpInput.current?.click()}>
              {wpBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}
              {wallpaper ? '换一张' : '上传壁纸'}
            </button>
            {wallpaper && <button type="button" className="np-btn np-btn-quiet" onClick={() => removeMusicWallpaper()}>移除</button>}
          </div>
          {wpError && <p className="np-hint" data-error>{wpError}</p>}
        </section>

        <section className="np-sec">
          <h3>歌词字体</h3>
          <div className="np-font-grid" role="radiogroup" aria-label="歌词字体">
            {fonts.map((f) => (
              <button key={f.id} type="button" role="radio" aria-checked={prefs.font === f.id} data-active={prefs.font === f.id || undefined} onClick={() => setMusicPrefs({ font: f.id })}>
                <span style={{ fontFamily: f.stack }}>雾里看花</span>
                <small>{f.id === 'custom' && custom.family ? custom.family : f.label}</small>
              </button>
            ))}
          </div>
          <div className="np-row np-row-between">
            <span className="np-label">字号</span>
            <div className="np-seg np-seg-sm" role="radiogroup" aria-label="歌词字号">
              {LYRIC_SIZES.map((s) => (
                <button key={s.id} type="button" role="radio" aria-checked={prefs.size === s.id} data-active={prefs.size === s.id || undefined} onClick={() => setMusicPrefs({ size: s.id })}>{s.label}</button>
              ))}
            </div>
          </div>

          <button type="button" className="np-toggle" aria-expanded={customOpen} onClick={() => setCustomOpen(!customOpen)}>
            <span>自定义字体</span>
            <span className="np-hint">{custom.record ? '已装上一款' : '上传或粘贴 CSS'} {customOpen ? '▴' : '▾'}</span>
          </button>
          {customOpen && (
            <div className="np-custom">
              <div className="np-seg np-seg-sm">
                {(['local', 'css'] as const).map((id) => (
                  <button key={id} type="button" aria-pressed={tab === id} data-active={tab === id || undefined} onClick={() => setTab(id)}>{id === 'local' ? '本地字体' : 'CSS 字体'}</button>
                ))}
              </div>
              {tab === 'local' ? (
                <>
                  <input
                    ref={fontInput}
                    type="file"
                    accept=".ttf,.otf,.woff,.woff2"
                    className="sr-only"
                    aria-label="上传本地字体文件"
                    disabled={custom.busy}
                    onChange={async (e) => {
                      const file = e.target.files?.[0];
                      e.target.value = '';
                      if (file) afterApply(await lyricFontSlot.upload(file));
                    }}
                  />
                  <button type="button" className="np-btn" disabled={custom.busy} onClick={() => fontInput.current?.click()}>
                    <Upload className="w-3.5 h-3.5" />上传字体文件
                  </button>
                  <p className="np-hint">支持 TTF、OTF、WOFF、WOFF2，最大 30 MB。</p>
                </>
              ) : (
                <>
                  <textarea
                    aria-label="字体 CSS 代码"
                    value={css}
                    onChange={(e) => setCss(e.target.value)}
                    placeholder={CSS_EXAMPLE}
                    rows={4}
                    maxLength={20000}
                    spellCheck={false}
                    className="np-css"
                  />
                  <button type="button" className="np-btn" disabled={custom.busy || !css.trim()} onClick={async () => afterApply(await lyricFontSlot.applyCss(css))}>应用字体</button>
                </>
              )}
              <p className="np-hint" role="status" data-error={custom.error ? true : undefined}>
                {custom.busy ? '正在加载字体…' : custom.error || (custom.record ? `已装上：${custom.family}。只用在歌词上。` : '只用在歌词上，聊天和日记的字体不受影响。')}
              </p>
              {custom.record && (
                <button type="button" className="np-btn np-btn-quiet" disabled={custom.busy} onClick={async () => { if (await lyricFontSlot.reset()) setMusicPrefs({ font: 'song' }); }}>
                  移除这款字体
                </button>
              )}
            </div>
          )}
        </section>
      </div>
    </div>
  );
};
