/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * Luma 全局音乐播放器与状态上下文
 * 维持单例 <audio>，页面切至聊天/设置时不销毁、不中断
 */

import React, { createContext, useContext, useState, useEffect, useRef, useCallback } from 'react';
import { MusicTrack, MusicPlaylist, MusicUserProfile, PlayMode, SavedMusicState } from '../types/music';
import { musicApi } from '../utils/musicApi';
import { recordPlay } from '../utils/musicPrefs';

const STORAGE_KEY = 'luma_music_saved_state_v1';

// 初始默认曲目（用于未登录或无网络时的法式精选曲目）
export const DEFAULT_PRESET_TRACKS: MusicTrack[] = [
  {
    id: 'presets_clair_de_lune',
    name: 'Clair de Lune',
    artists: 'Claude Debussy',
    albumName: 'Suite bergamasque',
    duration: 198,
    url: ''
  },
  {
    id: 'presets_gymnopedie',
    name: 'Gymnopédie No. 1',
    artists: 'Erik Satie',
    albumName: 'Trois Gymnopédies',
    duration: 172,
    url: ''
  },
  {
    id: 'presets_lin',
    name: 'La Fille aux Cheveux de Lin',
    artists: 'Claude Debussy',
    albumName: 'Préludes, Livre 1',
    duration: 145,
    url: ''
  },
  {
    id: 'presets_pavane',
    name: 'Pavane pour une Infante',
    artists: 'Maurice Ravel',
    albumName: 'Pavane pour une infante défunte',
    duration: 215,
    url: ''
  }
];

interface MusicContextType {
  // 播放状态
  isPlaying: boolean;
  isLoading: boolean;
  currentTime: number;
  duration: number;
  volume: number;
  isMuted: boolean;
  playMode: PlayMode;
  error: string | null;

  // 队列与曲目
  queue: MusicTrack[];
  currentIndex: number;
  currentTrack: MusicTrack | null;

  // 用户与歌单
  userProfile: MusicUserProfile;
  userPlaylists: MusicPlaylist[];
  isLibraryOpen: boolean;
  isLoginModalOpen: boolean;
  isNowPlayingOpen: boolean;

  // 控制方法
  play: () => Promise<void>;
  pause: () => void;
  togglePlay: () => Promise<void>;
  seek: (seconds: number) => void;
  playTrack: (track: MusicTrack, newQueue?: MusicTrack[]) => Promise<void>;
  playNext: () => Promise<void>;
  playPrev: () => Promise<void>;
  addToQueue: (track: MusicTrack, playNow?: boolean) => Promise<void>;
  removeFromQueue: (trackId: string) => void;
  clearQueue: () => void;
  setVolume: (v: number) => void;
  setMuted: (m: boolean) => void;
  setPlayMode: (mode: PlayMode) => void;
  openLibrary: () => void;
  closeLibrary: () => void;
  openNowPlaying: () => void;
  closeNowPlaying: () => void;
  openLoginModal: () => void;
  closeLoginModal: () => void;
  refreshUserProfile: () => Promise<void>;
  refreshUserPlaylists: () => Promise<void>;
  logout: () => Promise<void>;
}

const MusicContext = createContext<MusicContextType | null>(null);

export const MusicProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // 状态初始化
  const [queue, setQueue] = useState<MusicTrack[]>(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed: SavedMusicState = JSON.parse(raw);
        if (Array.isArray(parsed.queue) && parsed.queue.length > 0) {
          return parsed.queue;
        }
      }
    } catch {
      // ignore
    }
    return DEFAULT_PRESET_TRACKS;
  });

  const [currentIndex, setCurrentIndex] = useState<number>(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed: SavedMusicState = JSON.parse(raw);
        if (typeof parsed.currentIndex === 'number' && parsed.currentIndex >= 0) {
          return parsed.currentIndex;
        }
      }
    } catch {
      // ignore
    }
    return 0;
  });

  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [currentTime, setCurrentTime] = useState<number>(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed: SavedMusicState = JSON.parse(raw);
        if (typeof parsed.currentTime === 'number') return parsed.currentTime;
      }
    } catch {
      // ignore
    }
    return 0;
  });
  const [duration, setDuration] = useState<number>(() => {
    return queue[currentIndex]?.duration || 180;
  });
  const [volume, setVolumeState] = useState<number>(0.85);
  const [isMuted, setIsMutedState] = useState<boolean>(false);
  const [playMode, setPlayModeState] = useState<PlayMode>('sequence');
  const [error, setError] = useState<string | null>(null);

  // 账号和弹窗状态
  const [userProfile, setUserProfile] = useState<MusicUserProfile>({ isLoggedIn: false });
  const [userPlaylists, setUserPlaylists] = useState<MusicPlaylist[]>([]);
  const [isLibraryOpen, setIsLibraryOpen] = useState<boolean>(false);
  const [isLoginModalOpen, setIsLoginModalOpen] = useState<boolean>(false);
  const [isNowPlayingOpen, setIsNowPlayingOpen] = useState<boolean>(false);

  const currentTrack = queue[currentIndex] || null;

  // 节流保存播放位置
  const saveStateTimeoutRef = useRef<number | null>(null);
  const saveStateToStorage = useCallback((curTime: number, playing: boolean) => {
    if (saveStateTimeoutRef.current) {
      window.clearTimeout(saveStateTimeoutRef.current);
    }
    saveStateTimeoutRef.current = window.setTimeout(() => {
      try {
        const stateToSave: SavedMusicState = {
          queue: queue.map(t => ({
            id: t.id,
            name: t.name,
            artists: t.artists,
            albumName: t.albumName,
            coverUrl: t.coverUrl,
            duration: t.duration,
            fee: t.fee,
            level: t.level
          })),
          currentIndex,
          currentTime: curTime,
          isPlaying: playing,
          volume,
          isMuted,
          playMode,
          updatedAt: Date.now()
        };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(stateToSave));
      } catch {
        // ignore
      }
    }, 1000);
  }, [queue, currentIndex, volume, isMuted, playMode]);

  // 更新 Media Session
  useEffect(() => {
    if ('mediaSession' in navigator && currentTrack) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: currentTrack.name,
        artist: currentTrack.artists,
        album: currentTrack.albumName || 'Luma Musique',
        artwork: currentTrack.coverUrl
          ? [{ src: currentTrack.coverUrl, sizes: '512x512', type: 'image/jpeg' }]
          : []
      });

      navigator.mediaSession.setActionHandler('play', () => {
        play();
      });
      navigator.mediaSession.setActionHandler('pause', () => {
        pause();
      });
      navigator.mediaSession.setActionHandler('previoustrack', () => {
        playPrev();
      });
      navigator.mediaSession.setActionHandler('nexttrack', () => {
        playNext();
      });
      navigator.mediaSession.setActionHandler('seekto', (details) => {
        if (details.seekTime !== undefined) {
          seek(details.seekTime);
        }
      });
    }
  }, [currentTrack]);

  // 初始化检查登录态
  const refreshUserProfile = useCallback(async () => {
    try {
      const profile = await musicApi.getUserProfile();
      setUserProfile(profile);
      if (profile.isLoggedIn) {
        refreshUserPlaylists();
      }
    } catch {
      setUserProfile({ isLoggedIn: false });
    }
  }, []);

  const refreshUserPlaylists = useCallback(async () => {
    try {
      const playlists = await musicApi.getUserPlaylists();
      setUserPlaylists(playlists);
    } catch {
      setUserPlaylists([]);
    }
  }, []);

  useEffect(() => {
    refreshUserProfile();
  }, [refreshUserProfile]);

  // 音频播放核心控制
  const fetchAndPlayTrackUrl = async (track: MusicTrack, startTime = 0) => {
    if (!audioRef.current) return;
    setIsLoading(true);
    setError(null);

    try {
      // 如果曲目已有有效且未过期的 URL，直接播
      let playUrl = track.url;
      if (!playUrl || track.id.startsWith('presets_')) {
        // 尝试从网易云获取真实的 URL
        if (!track.id.startsWith('presets_')) {
          const res = await musicApi.getSongUrl(track.id);
          if (!res.playable || !res.url) {
            setError(res.unplayableReason || '该曲目暂无版权或需单独购买');
            setIsLoading(false);
            return;
          }
          playUrl = res.url;
          // 更新 track 上的 URL 及试听信息
          track.url = res.url;
          track.isFreeTrial = res.isFreeTrial;
          track.duration = res.duration || track.duration;
        }
      }

      if (!playUrl) {
        // 预设音源若无链接，显示提示
        setError('请连接网易云或搜索点播真实歌曲');
        setIsLoading(false);
        return;
      }

      const audio = audioRef.current;
      if (audio.src !== playUrl) {
        audio.src = playUrl;
        audio.load();
      }

      if (startTime > 0) {
        audio.currentTime = startTime;
      }

      await audio.play();
      setIsPlaying(true);
      recordPlay(track);
    } catch (err: any) {
      if (err.name === 'NotAllowedError') {
        // 浏览器 autoplay 限制，等待用户明确手势点按
        setError('需点击播放按钮启动声音');
      } else {
        setError(err.message || '播放异常');
      }
      setIsPlaying(false);
    } finally {
      setIsLoading(false);
    }
  };

  const play = async () => {
    if (!audioRef.current || !currentTrack) return;
    if (audioRef.current.src && audioRef.current.src !== window.location.href) {
      try {
        await audioRef.current.play();
        setIsPlaying(true);
        setError(null);
      } catch (err: any) {
        // 若旧 URL 失效或已被清理，重新刷新
        await fetchAndPlayTrackUrl(currentTrack, currentTime);
      }
    } else {
      await fetchAndPlayTrackUrl(currentTrack, currentTime);
    }
  };

  const pause = () => {
    if (audioRef.current) {
      audioRef.current.pause();
      setIsPlaying(false);
      saveStateToStorage(currentTime, false);
    }
  };

  const togglePlay = async () => {
    if (isPlaying) {
      pause();
    } else {
      await play();
    }
  };

  const seek = (seconds: number) => {
    if (audioRef.current) {
      const clamped = Math.max(0, Math.min(seconds, duration || 0));
      audioRef.current.currentTime = clamped;
      setCurrentTime(clamped);
      saveStateToStorage(clamped, isPlaying);
    }
  };

  const playTrack = async (track: MusicTrack, newQueue?: MusicTrack[]) => {
    let nextQueue = queue;
    if (newQueue) {
      nextQueue = newQueue;
      setQueue(newQueue);
    } else {
      // 检查当前队列是否已包含
      const existsIndex = nextQueue.findIndex((t) => t.id === track.id);
      if (existsIndex === -1) {
        nextQueue = [track, ...nextQueue];
        setQueue(nextQueue);
      }
    }

    const targetIdx = nextQueue.findIndex((t) => t.id === track.id);
    const resolvedIdx = targetIdx >= 0 ? targetIdx : 0;
    setCurrentIndex(resolvedIdx);
    setCurrentTime(0);

    await fetchAndPlayTrackUrl(nextQueue[resolvedIdx] || track, 0);
  };

  const playNext = async () => {
    if (queue.length === 0) return;
    let nextIdx = currentIndex + 1;
    if (playMode === 'random') {
      nextIdx = Math.floor(Math.random() * queue.length);
    } else if (nextIdx >= queue.length) {
      nextIdx = 0;
    }
    setCurrentIndex(nextIdx);
    setCurrentTime(0);
    await fetchAndPlayTrackUrl(queue[nextIdx], 0);
  };

  const playPrev = async () => {
    if (queue.length === 0) return;
    let prevIdx = currentIndex - 1;
    if (prevIdx < 0) {
      prevIdx = queue.length - 1;
    }
    setCurrentIndex(prevIdx);
    setCurrentTime(0);
    await fetchAndPlayTrackUrl(queue[prevIdx], 0);
  };

  const addToQueue = async (track: MusicTrack, playNow = false) => {
    const existingIdx = queue.findIndex(t => t.id === track.id);
    let newQueue = [...queue];
    if (existingIdx === -1) {
      newQueue.push(track);
      setQueue(newQueue);
    }
    if (playNow) {
      const targetIndex = existingIdx >= 0 ? existingIdx : newQueue.length - 1;
      setCurrentIndex(targetIndex);
      setCurrentTime(0);
      await fetchAndPlayTrackUrl(newQueue[targetIndex], 0);
    }
  };

  const removeFromQueue = (trackId: string) => {
    const newQueue = queue.filter(t => t.id !== trackId);
    if (newQueue.length === 0) {
      pause();
      setQueue(DEFAULT_PRESET_TRACKS);
      setCurrentIndex(0);
      setCurrentTime(0);
      return;
    }
    let newIdx = currentIndex;
    if (newIdx >= newQueue.length) {
      newIdx = newQueue.length - 1;
    }
    setQueue(newQueue);
    setCurrentIndex(newIdx);
  };

  const clearQueue = () => {
    pause();
    setQueue(DEFAULT_PRESET_TRACKS);
    setCurrentIndex(0);
    setCurrentTime(0);
  };

  const setVolume = (v: number) => {
    const clamped = Math.max(0, Math.min(1, v));
    setVolumeState(clamped);
    if (audioRef.current) {
      audioRef.current.volume = clamped;
    }
  };

  const setMuted = (m: boolean) => {
    setIsMutedState(m);
    if (audioRef.current) {
      audioRef.current.muted = m;
    }
  };

  const setPlayMode = (mode: PlayMode) => {
    setPlayModeState(mode);
  };

  const logout = async () => {
    try {
      await musicApi.logout();
    } finally {
      setUserProfile({ isLoggedIn: false });
      setUserPlaylists([]);
    }
  };

  // 绑定真实音频元素事件
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const onTimeUpdate = () => {
      const cur = audio.currentTime;
      setCurrentTime(cur);
      saveStateToStorage(cur, !audio.paused);
    };

    const onDurationChange = () => {
      if (audio.duration && !isNaN(audio.duration) && isFinite(audio.duration)) {
        setDuration(Math.round(audio.duration));
      }
    };

    const onLoadedMetadata = () => {
      if (audio.duration && !isNaN(audio.duration) && isFinite(audio.duration)) {
        setDuration(Math.round(audio.duration));
      }
    };

    const onEnded = () => {
      if (playMode === 'loop') {
        audio.currentTime = 0;
        audio.play().catch(() => {});
      } else {
        playNext();
      }
    };

    const onError = () => {
      setIsPlaying(false);
      setIsLoading(false);
      setError('音频流连接中断或音源已过期');
    };

    const onWaiting = () => {
      setIsLoading(true);
    };

    const onPlaying = () => {
      setIsLoading(false);
      setIsPlaying(true);
      setError(null);
    };

    const onPause = () => {
      setIsPlaying(false);
    };

    audio.addEventListener('timeupdate', onTimeUpdate);
    audio.addEventListener('durationchange', onDurationChange);
    audio.addEventListener('loadedmetadata', onLoadedMetadata);
    audio.addEventListener('ended', onEnded);
    audio.addEventListener('error', onError);
    audio.addEventListener('waiting', onWaiting);
    audio.addEventListener('playing', onPlaying);
    audio.addEventListener('pause', onPause);

    return () => {
      audio.removeEventListener('timeupdate', onTimeUpdate);
      audio.removeEventListener('durationchange', onDurationChange);
      audio.removeEventListener('loadedmetadata', onLoadedMetadata);
      audio.removeEventListener('ended', onEnded);
      audio.removeEventListener('error', onError);
      audio.removeEventListener('waiting', onWaiting);
      audio.removeEventListener('playing', onPlaying);
      audio.removeEventListener('pause', onPause);
    };
  }, [playMode, playNext, saveStateToStorage]);

  return (
    <MusicContext.Provider
      value={{
        isPlaying,
        isLoading,
        currentTime,
        duration,
        volume,
        isMuted,
        playMode,
        error,
        queue,
        currentIndex,
        currentTrack,
        userProfile,
        userPlaylists,
        isLibraryOpen,
        isLoginModalOpen,
        isNowPlayingOpen,
        play,
        pause,
        togglePlay,
        seek,
        playTrack,
        playNext,
        playPrev,
        addToQueue,
        removeFromQueue,
        clearQueue,
        setVolume,
        setMuted,
        setPlayMode,
        openLibrary: () => setIsLibraryOpen(true),
        closeLibrary: () => setIsLibraryOpen(false),
        openNowPlaying: () => setIsNowPlayingOpen(true),
        closeNowPlaying: () => setIsNowPlayingOpen(false),
        openLoginModal: () => setIsLoginModalOpen(true),
        closeLoginModal: () => setIsLoginModalOpen(false),
        refreshUserProfile,
        refreshUserPlaylists,
        logout
      }}
    >
      {/* 根层唯一真正的 <audio> 节点，跨页面不卸载 */}
      <audio
        ref={audioRef}
        preload="metadata"
        playsInline
        style={{ display: 'none' }}
      />
      {children}
    </MusicContext.Provider>
  );
};

export const useMusic = () => {
  const context = useContext(MusicContext);
  if (!context) {
    throw new Error('useMusic must be used within a MusicProvider');
  }
  return context;
};
