/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Luma 音乐馆抽屉：推荐 / 我的歌单 / 搜索 / 最近播放 / 播放队列，外加扫码登录。
 * 米白纸 + 金线，歌单封面套小画框；底部小唱片点开「正在播放」。
 */

import React, { useEffect, useState } from 'react';
import {
  X, Search, Disc3, User, QrCode, Play, Pause, Plus, Trash2,
  CheckCircle2, AlertCircle, RefreshCw, LogOut, Music2, Loader2,
} from 'lucide-react';
import { useMusic } from '../contexts/MusicContext';
import { MusicTrack, MusicPlaylist } from '../types/music';
import { musicApi } from '../utils/musicApi';
import { useMusicHistory, clearHistory } from '../utils/musicPrefs';
import './Music/music.css';

type Tab = 'discover' | 'playlists' | 'search' | 'recent' | 'queue';
const TABS: { id: Tab; label: string }[] = [
  { id: 'discover', label: '推荐' },
  { id: 'playlists', label: '我的歌单' },
  { id: 'search', label: '搜索' },
  { id: 'recent', label: '最近播放' },
  { id: 'queue', label: '播放队列' },
];

const formatDuration = (sec: number) => {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
};

const thumb = (url?: string, size = 120) => (url ? `${url}?param=${size}y${size}` : '');

/** 一行曲目 */
const TrackRow: React.FC<{
  track: MusicTrack;
  index?: number;
  current: boolean;
  onPlay: () => void;
  action?: React.ReactNode;
  extra?: React.ReactNode;
}> = ({ track, index, current, onPlay, action, extra }) => (
  <div className="md-row" data-current={current || undefined}>
    <button type="button" onClick={onPlay} className="flex items-center gap-2.5 min-w-0 flex-1 text-left" aria-label={`播放 ${track.name}`}>
      {index !== undefined ? (
        <span className="md-row-index">{index + 1}</span>
      ) : track.coverUrl ? (
        <img src={thumb(track.coverUrl, 80)} alt="" className="md-row-thumb" loading="lazy" />
      ) : (
        <span className="md-row-thumb grid place-items-center"><Music2 className="w-4 h-4 text-stone-400" /></span>
      )}
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="md-row-name">{track.name}</span>
          {track.fee === 1 && <span className="md-vip">VIP</span>}
        </span>
        <span className="md-row-sub block">{track.artists}{track.albumName ? ` · ${track.albumName}` : ''}</span>
        {extra}
      </span>
    </button>
    <span className="md-row-time">{formatDuration(track.duration)}</span>
    {action}
  </div>
);

/** 一张歌单卡片 */
const PlaylistCard: React.FC<{ playlist: MusicPlaylist; onOpen: () => void; meta?: string }> = ({ playlist, onOpen, meta }) => (
  <button type="button" onClick={onOpen} className="md-card" aria-label={`打开歌单 ${playlist.name}`}>
    <div className="md-card-frame">
      <div className="md-card-mat">
        {playlist.coverImgUrl ? <img src={thumb(playlist.coverImgUrl, 300)} alt="" loading="lazy" /> : <div className="w-full h-full bg-stone-200" />}
      </div>
    </div>
    <div className="md-card-name">{playlist.name}</div>
    <div className="md-card-meta">{meta ?? `${playlist.trackCount} 首`}</div>
  </button>
);

export const MusicDrawer: React.FC = () => {
  const {
    isLibraryOpen, closeLibrary, userProfile, userPlaylists, queue, currentTrack, isPlaying,
    playTrack, addToQueue, removeFromQueue, clearQueue, refreshUserProfile, refreshUserPlaylists,
    logout, togglePlay, openNowPlaying,
  } = useMusic();
  const history = useMusicHistory();

  const [activeTab, setActiveTab] = useState<Tab>('discover');

  // 歌单 / 榜单详情（各栏共用）
  const [selectedPlaylist, setSelectedPlaylist] = useState<MusicPlaylist | null>(null);
  const [playlistTracks, setPlaylistTracks] = useState<MusicTrack[]>([]);
  const [isLoadingTracks, setIsLoadingTracks] = useState(false);

  // 推荐
  const [daily, setDaily] = useState<MusicTrack[]>([]);
  const [recPlaylists, setRecPlaylists] = useState<MusicPlaylist[]>([]);
  const [toplists, setToplists] = useState<MusicPlaylist[]>([]);
  const [discoverState, setDiscoverState] = useState<'idle' | 'loading' | 'done' | 'error'>('idle');
  const [showAllDaily, setShowAllDaily] = useState(false);

  // 搜索
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<MusicTrack[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  // 扫码
  const [isLoginModalOpen, setIsLoginModalOpen] = useState(false);
  const [qrKey, setQrKey] = useState('');
  const [qrImg, setQrImg] = useState('');
  const [qrStatusText, setQrStatusText] = useState('正在准备二维码...');
  const [qrStatusCode, setQrStatusCode] = useState(0);
  const [isQrLoading, setIsQrLoading] = useState(false);

  const loadDiscover = async () => {
    setDiscoverState('loading');
    const [d, r, t] = await Promise.allSettled([
      musicApi.getDailySongs(), musicApi.getRecommendPlaylists(), musicApi.getToplists(),
    ]);
    if (d.status === 'fulfilled') setDaily(d.value);
    if (r.status === 'fulfilled') setRecPlaylists(r.value);
    if (t.status === 'fulfilled') setToplists(t.value);
    setDiscoverState([d, r, t].every((x) => x.status === 'rejected') ? 'error' : 'done');
  };

  // 打开抽屉时才拉推荐；登录状态变了重拉（每日推荐要登录）
  useEffect(() => {
    if (isLibraryOpen && activeTab === 'discover' && discoverState === 'idle') loadDiscover();
  }, [isLibraryOpen, activeTab, discoverState]);
  useEffect(() => { setDiscoverState('idle'); }, [userProfile.isLoggedIn]);

  const fetchNewQrCode = async () => {
    setIsQrLoading(true);
    setQrStatusText('正在获取扫码密钥...');
    try {
      const key = await musicApi.getQrKey();
      setQrKey(key);
      setQrImg(await musicApi.getQrImage(key));
      setQrStatusText('请使用网易云音乐 App 扫码登录');
      setQrStatusCode(801);
    } catch (err: any) {
      setQrStatusText('获取二维码失败: ' + err.message);
    } finally {
      setIsQrLoading(false);
    }
  };

  useEffect(() => {
    let timer: number | null = null;
    if (isLoginModalOpen && qrKey && qrStatusCode !== 803) {
      timer = window.setInterval(async () => {
        try {
          const res = await musicApi.checkQrStatus(qrKey);
          setQrStatusCode(res.code);
          if (res.code === 800) setQrStatusText('二维码已过期，点击刷新');
          else if (res.code === 801) setQrStatusText('等待网易云 App 扫码...');
          else if (res.code === 802) setQrStatusText('扫码成功，请在手机端点击【确认登录】');
          else if (res.code === 803) {
            setQrStatusText('授权成功！已同步网易云账号');
            await refreshUserProfile();
            setTimeout(() => setIsLoginModalOpen(false), 1200);
          }
        } catch {
          // 网络抖一下不管
        }
      }, 2000);
    }
    return () => { if (timer) clearInterval(timer); };
  }, [isLoginModalOpen, qrKey, qrStatusCode, refreshUserProfile]);

  const openPlaylist = async (playlist: MusicPlaylist) => {
    setSelectedPlaylist(playlist);
    setIsLoadingTracks(true);
    try {
      setPlaylistTracks(await musicApi.getPlaylistTracks(playlist.id, 100));
    } catch {
      setPlaylistTracks([]);
    } finally {
      setIsLoadingTracks(false);
    }
  };

  const handleSearch = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!searchQuery.trim()) return;
    setIsSearching(true);
    setSearchError(null);
    try {
      const results = await musicApi.searchSongs(searchQuery.trim(), 30);
      setSearchResults(results);
      if (results.length === 0) setSearchError('没有找到这首歌');
    } catch (err: any) {
      setSearchError(err.message || '搜索失败');
    } finally {
      setIsSearching(false);
    }
  };

  const startLogin = () => { setIsLoginModalOpen(true); fetchNewQrCode(); };
  const switchTab = (tab: Tab) => { setSelectedPlaylist(null); setActiveTab(tab); };
  const addBtn = (t: MusicTrack) => (
    <button type="button" onClick={() => addToQueue(t)} className="md-iconbtn" aria-label={`把 ${t.name} 加进播放队列`}>
      <Plus className="w-4 h-4" />
    </button>
  );

  if (!isLibraryOpen) return null;

  const loginPrompt = (
    <div className="md-empty">
      <Disc3 className="w-9 h-9 mx-auto mb-3 text-stone-300" />
      <p className="mb-1 text-stone-700">连接网易云，就能看到你的歌单和每日推荐</p>
      <button type="button" onClick={startLogin} className="md-btn mt-3"><QrCode className="w-3.5 h-3.5" />扫码连接</button>
    </div>
  );

  return (
    <div onClick={closeLibrary} className="fixed inset-0 z-50 bg-stone-950/50 backdrop-blur-sm flex flex-col justify-end animate-fadeIn select-none">
      <div
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="音乐馆"
        className="md-sheet w-full max-w-lg mx-auto rounded-t-[30px] flex flex-col max-h-[88vh] h-[680px] text-stone-900 overflow-hidden"
      >
        {/* 头部 */}
        <div className="pt-3 px-5 pb-2">
          <div className="w-10 h-1 bg-stone-400/40 rounded-full mx-auto mb-3" />
          <div className="flex items-start justify-between">
            <div>
              <h2 className="md-title font-calligraphy">Salon Musical</h2>
              <p className="md-sub">音乐馆 · 使用者的留声机</p>
            </div>
            <button type="button" onClick={closeLibrary} className="md-iconbtn" aria-label="关闭音乐馆"><X className="w-5 h-5" /></button>
          </div>

          {/* 账号 */}
          <div className="md-account mt-2.5 p-2 px-3 flex items-center justify-between gap-2">
            {userProfile.isLoggedIn ? (
              <div className="flex items-center gap-2.5 min-w-0">
                <img src={userProfile.avatarUrl || ''} alt="" className="w-7 h-7 rounded-full object-cover" style={{ boxShadow: '0 0 0 1px rgba(190,160,110,.7)' }} />
                <div className="min-w-0">
                  <span className="text-xs text-stone-800 truncate block">{userProfile.nickname || '网易云账号'}</span>
                  <span className="text-[10.5px] italic text-stone-500 flex items-center gap-1"><CheckCircle2 className="w-3 h-3 text-[#8fa38a]" />已连接</span>
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-2 min-w-0">
                <span className="w-7 h-7 rounded-full bg-stone-200 grid place-items-center text-stone-500"><User className="w-4 h-4" /></span>
                <span className="text-xs text-stone-700">还没连接网易云</span>
              </div>
            )}
            {userProfile.isLoggedIn ? (
              <button type="button" onClick={logout} className="text-[11px] text-stone-500 flex items-center gap-1 px-2 py-1"><LogOut className="w-3 h-3" />退出</button>
            ) : (
              <button type="button" onClick={startLogin} className="md-btn !py-1.5 !px-3"><QrCode className="w-3.5 h-3.5" />扫码</button>
            )}
          </div>

          {/* 栏目 */}
          <div className="md-tabs mt-3" role="tablist" aria-label="音乐馆栏目">
            {TABS.map((t) => (
              <button key={t.id} type="button" role="tab" aria-selected={activeTab === t.id} data-active={activeTab === t.id || undefined} onClick={() => switchTab(t.id)} className="md-tab">
                {t.id === 'queue' ? `${t.label} ${queue.length}` : t.label}
              </button>
            ))}
          </div>
        </div>

        <div className="h-px mx-5" style={{ background: 'linear-gradient(90deg, transparent, rgba(190,160,110,.6), transparent)' }} />

        {/* 内容 */}
        <div className="flex-1 overflow-y-auto px-4 py-3">
          {selectedPlaylist ? (
            <div>
              <div className="flex items-center justify-between pb-2 mb-1">
                <button type="button" onClick={() => setSelectedPlaylist(null)} className="text-xs text-[#6f5f7a]">← 返回</button>
                <span className="text-xs text-stone-700 truncate max-w-[60%]">{selectedPlaylist.name}</span>
              </div>
              {isLoadingTracks ? (
                <div className="md-empty"><Loader2 className="w-5 h-5 mx-auto animate-spin text-[#8c7f9e]" /></div>
              ) : playlistTracks.length === 0 ? (
                <div className="md-empty">这里面还没有歌</div>
              ) : (
                <div>
                  <button type="button" onClick={() => playTrack(playlistTracks[0], playlistTracks)} className="md-btn mb-2"><Play className="w-3.5 h-3.5" />从头放</button>
                  {playlistTracks.map((t, i) => (
                    <TrackRow key={t.id} track={t} index={i} current={currentTrack?.id === t.id} onPlay={() => playTrack(t, playlistTracks)} action={addBtn(t)} />
                  ))}
                </div>
              )}
            </div>
          ) : activeTab === 'discover' ? (
            discoverState === 'loading' || discoverState === 'idle' ? (
              <div className="md-empty"><Loader2 className="w-5 h-5 mx-auto animate-spin text-[#8c7f9e]" /></div>
            ) : discoverState === 'error' ? (
              <div className="md-empty">
                <p>推荐没取到，可能是网络不好</p>
                <button type="button" onClick={loadDiscover} className="md-btn md-btn-ghost mt-3"><RefreshCw className="w-3.5 h-3.5" />再试一次</button>
              </div>
            ) : (
              <div className="space-y-5">
                <section>
                  <h3 className="md-section-title"><span className="font-calligraphy">Chansons du jour</span>每日推荐</h3>
                  {!userProfile.isLoggedIn ? (
                    <p className="text-xs text-stone-500 px-2">扫码连接网易云以后，这里每天会有一份给你的歌。</p>
                  ) : daily.length === 0 ? (
                    <p className="text-xs text-stone-500 px-2">今天的推荐还没出来，晚点再看看。</p>
                  ) : (
                    <>
                      <button type="button" onClick={() => playTrack(daily[0], daily)} className="md-btn mb-1.5"><Play className="w-3.5 h-3.5" />全部播放 · {daily.length} 首</button>
                      {(showAllDaily ? daily : daily.slice(0, 6)).map((t) => (
                        <TrackRow key={t.id} track={t} current={currentTrack?.id === t.id} onPlay={() => playTrack(t, daily)} action={addBtn(t)} />
                      ))}
                      {daily.length > 6 && (
                        <button type="button" onClick={() => setShowAllDaily(!showAllDaily)} className="text-xs text-[#6f5f7a] px-2 py-1">
                          {showAllDaily ? '收起' : `展开全部 ${daily.length} 首`}
                        </button>
                      )}
                    </>
                  )}
                </section>

                {recPlaylists.length > 0 && (
                  <section>
                    <h3 className="md-section-title"><span className="font-calligraphy">Pour toi</span>推荐歌单</h3>
                    <div className="grid grid-cols-3 gap-3">
                      {recPlaylists.slice(0, 9).map((p) => <PlaylistCard key={p.id} playlist={p} onOpen={() => openPlaylist(p)} meta={p.description || `${p.trackCount} 首`} />)}
                    </div>
                  </section>
                )}

                {toplists.length > 0 && (
                  <section>
                    <h3 className="md-section-title"><span className="font-calligraphy">Classements</span>排行榜</h3>
                    <div className="grid grid-cols-3 gap-3">
                      {toplists.slice(0, 12).map((p) => <PlaylistCard key={p.id} playlist={p} onOpen={() => openPlaylist(p)} meta={p.description || ''} />)}
                    </div>
                  </section>
                )}
              </div>
            )
          ) : activeTab === 'playlists' ? (
            !userProfile.isLoggedIn ? loginPrompt : userPlaylists.length === 0 ? (
              <div className="md-empty">
                <p>歌单没取到</p>
                <button type="button" onClick={refreshUserPlaylists} className="md-btn md-btn-ghost mt-3"><RefreshCw className="w-3.5 h-3.5" />刷新</button>
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-3.5">
                {userPlaylists.map((p) => <PlaylistCard key={p.id} playlist={p} onOpen={() => openPlaylist(p)} />)}
              </div>
            )
          ) : activeTab === 'search' ? (
            <div className="space-y-3">
              <form onSubmit={handleSearch} className="flex gap-2" role="search">
                <div className="relative flex-1 flex">
                  <input
                    type="search"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="歌名、歌手..."
                    aria-label="搜索歌曲"
                    className="md-search"
                  />
                  <Search className="w-4 h-4 text-stone-400 absolute left-3 top-1/2 -translate-y-1/2" aria-hidden="true" />
                </div>
                <button type="submit" disabled={isSearching} className="md-btn">{isSearching ? '找…' : '搜索'}</button>
              </form>
              {searchError && (
                <p className="text-xs text-[#a2504a] flex items-center gap-1.5 px-1" role="status"><AlertCircle className="w-3.5 h-3.5" />{searchError}</p>
              )}
              <div>
                {searchResults.map((t) => (
                  <TrackRow key={t.id} track={t} current={currentTrack?.id === t.id} onPlay={() => playTrack(t)} action={addBtn(t)} />
                ))}
              </div>
            </div>
          ) : activeTab === 'recent' ? (
            history.length === 0 ? (
              <div className="md-empty">还没有听过的歌。放一首，就会记在这里。</div>
            ) : (
              <div>
                <div className="flex items-center justify-between px-1 pb-2">
                  <span className="text-[11px] italic text-stone-500">大家听过的歌都在这里</span>
                  <button type="button" onClick={clearHistory} className="text-[11px] text-stone-500 flex items-center gap-1"><Trash2 className="w-3 h-3" />清空</button>
                </div>
                {history.map((e) => (
                  <TrackRow
                    key={e.track.id}
                    track={e.track}
                    current={currentTrack?.id === e.track.id}
                    onPlay={() => playTrack(e.track, history.map((h) => h.track))}
                    action={addBtn(e.track)}
                    extra={<span className="md-listeners block">{e.listeners.join(' · ')} 听过</span>}
                  />
                ))}
              </div>
            )
          ) : (
            <div>
              <div className="flex items-center justify-between px-1 pb-2">
                <span className="text-[11px] italic text-stone-500">共 {queue.length} 首</span>
                <button type="button" onClick={clearQueue} className="text-[11px] text-stone-500 flex items-center gap-1"><Trash2 className="w-3 h-3" />清空</button>
              </div>
              {queue.map((t, i) => (
                <TrackRow
                  key={`${t.id}-${i}`}
                  track={t}
                  index={i}
                  current={currentTrack?.id === t.id}
                  onPlay={() => playTrack(t)}
                  action={
                    <button type="button" onClick={() => removeFromQueue(t.id)} className="md-iconbtn" aria-label={`把 ${t.name} 移出队列`}>
                      <X className="w-3.5 h-3.5" />
                    </button>
                  }
                />
              ))}
            </div>
          )}
        </div>

        {/* 底部小唱片：点开正在播放 */}
        {currentTrack && (
          <div className="md-mini">
            <button type="button" className="md-mini-open" onClick={() => { closeLibrary(); openNowPlaying(); }} aria-label="打开正在播放">
              <span className="md-disc" data-playing={isPlaying || undefined}>
                {currentTrack.coverUrl && <img src={thumb(currentTrack.coverUrl, 80)} alt="" />}
              </span>
              <span className="min-w-0">
                <span className="md-row-name block">{currentTrack.name}</span>
                <span className="md-row-sub block">{currentTrack.artists}</span>
              </span>
            </button>
            <button type="button" className="md-mini-play" onClick={togglePlay} aria-label={isPlaying ? '暂停' : '播放'}>
              {isPlaying ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4 translate-x-[1px]" />}
            </button>
          </div>
        )}
      </div>

      {/* 扫码登录 */}
      {isLoginModalOpen && (
        <div onClick={(e) => e.stopPropagation()} className="fixed inset-0 z-60 bg-stone-950/60 backdrop-blur-sm flex items-center justify-center p-4 animate-fadeIn">
          <div className="md-sheet w-full max-w-xs rounded-3xl p-6 flex flex-col items-center text-center text-stone-900" role="dialog" aria-modal="true" aria-label="连接网易云音乐">
            <h3 className="font-calligraphy text-[26px] text-[#6f5f7a] leading-none mb-1">Connexion</h3>
            <p className="text-[11px] text-stone-500 mb-4">打开网易云音乐 App 扫一扫</p>
            <div className="w-48 h-48 bg-white rounded-2xl p-2.5 flex items-center justify-center relative overflow-hidden" style={{ boxShadow: '0 0 0 1px rgba(190,160,110,.6)' }}>
              {isQrLoading ? <RefreshCw className="w-8 h-8 animate-spin text-[#8c7f9e]" />
                : qrImg ? <img src={qrImg} alt="网易云登录二维码" className="w-full h-full object-contain" />
                  : <span className="text-xs text-stone-400">暂无二维码</span>}
              {qrStatusCode === 800 && (
                <button type="button" onClick={fetchNewQrCode} className="absolute inset-0 bg-stone-900/75 flex flex-col items-center justify-center text-white">
                  <RefreshCw className="w-6 h-6 mb-1" /><span className="text-xs">已过期，点一下刷新</span>
                </button>
              )}
            </div>
            <p className="mt-4 text-xs text-stone-700" role="status">{qrStatusText}</p>
            <div className="mt-5 flex gap-2 w-full">
              <button type="button" onClick={fetchNewQrCode} className="md-btn md-btn-ghost flex-1">刷新</button>
              <button type="button" onClick={() => setIsLoginModalOpen(false)} className="md-btn flex-1">关闭</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
