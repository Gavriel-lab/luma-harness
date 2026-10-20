/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * Luma 法式音乐播放器
 * 保留经典的极简法式黑胶卡片视觉与排版
 * 音频核心升级为全局唯一的网易云真实录音驱动
 */

import React from 'react';
import {
  Play, Pause, SkipBack, SkipForward, Volume2, VolumeX,
  Disc3, ListMusic, RefreshCw, AlertCircle
} from 'lucide-react';
import { useMusic } from '../contexts/MusicContext';

export const FrenchMusicPlayer: React.FC = () => {
  const {
    isPlaying,
    isLoading,
    currentTime,
    duration,
    isMuted,
    error,
    currentTrack,
    userProfile,
    togglePlay,
    playNext,
    playPrev,
    seek,
    setMuted,
    openLibrary
  } = useMusic();

  // 格式化时间 00:00
  const formatTime = (secs: number) => {
    if (isNaN(secs) || secs < 0) return '00:00';
    const m = Math.floor(secs / 60);
    const s = Math.floor(secs % 60);
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  };

  const progressPercent = duration > 0 ? Math.min(100, Math.max(0, (currentTime / duration) * 100)) : 0;

  return (
    <div
      onClick={(e) => e.stopPropagation()}
      className="w-full max-w-sm mx-auto rounded-3xl p-4 sm:p-4.5 bg-white/20 backdrop-blur-xl border border-white/40 shadow-xl shadow-stone-900/10 text-stone-900 select-none transition-all duration-300 hover:bg-white/25 hover:border-white/50"
      style={{
        boxShadow: '0 12px 36px -8px rgba(70, 60, 50, 0.12), inset 0 1px 2px rgba(255, 255, 255, 0.6)'
      }}
    >
      {/* 顶部极简法式小标与曲库入口 */}
      <div className="flex items-center justify-between pb-2.5 border-b border-stone-800/10">
        <button
          onClick={openLibrary}
          className="flex items-center gap-1.5 group cursor-pointer text-left"
          title="点击打开网易云音乐馆与歌单"
        >
          <span className={`w-1.5 h-1.5 rounded-full ${isPlaying ? 'bg-amber-600 animate-pulse' : 'bg-stone-400'}`} />
          <span className="text-[10px] tracking-widest uppercase font-serif text-stone-700/90 font-medium group-hover:text-amber-900 transition-colors flex items-center gap-1">
            Musique du Salon · 法式沙龙
            <span className="text-[9px] lowercase opacity-60">▾</span>
          </span>
        </button>

        <div className="flex items-center gap-1">
          {/* 打开歌单抽屉按钮 */}
          <button
            onClick={openLibrary}
            className="text-stone-600 hover:text-stone-900 transition-colors p-1 rounded-full hover:bg-white/30 cursor-pointer"
            title="查看曲库与歌单"
          >
            <ListMusic className="w-3.5 h-3.5" />
          </button>

          {/* 静音控制按钮 */}
          <button
            onClick={() => setMuted(!isMuted)}
            className="text-stone-600 hover:text-stone-900 transition-colors p-1 rounded-full hover:bg-white/30 cursor-pointer"
            title={isMuted ? '取消静音' : '静音'}
          >
            {isMuted ? <VolumeX className="w-3.5 h-3.5 text-rose-700" /> : <Volume2 className="w-3.5 h-3.5" />}
          </button>
        </div>
      </div>

      {/* 主体播放区：旋转黑胶唱片 + 法式衬线标题 + 控制条 */}
      <div className="flex items-center gap-3.5 pt-3">
        {/* 极简旋转黑胶微缩唱片 */}
        <div
          onClick={openLibrary}
          className="relative shrink-0 cursor-pointer group"
          title="点击查看曲库"
        >
          <div
            className={`w-14 h-14 rounded-full bg-stone-900 p-1 flex items-center justify-center shadow-md border border-stone-700/40 relative overflow-hidden ${
              isPlaying ? 'animate-[spin_10s_linear_infinite]' : ''
            }`}
          >
            {/* 唱片沟槽同心圆 */}
            <div className="w-full h-full rounded-full border border-stone-800/80 flex items-center justify-center relative overflow-hidden">
              {currentTrack?.coverUrl ? (
                <img
                  src={currentTrack.coverUrl}
                  alt="cover"
                  className="w-8 h-8 rounded-full object-cover shadow-inner border border-amber-900/30"
                />
              ) : (
                <div className="w-8 h-8 rounded-full border border-stone-700/60 flex items-center justify-center bg-gradient-to-tr from-amber-200/50 via-rose-200/40 to-stone-300/30">
                  <div className="w-3 h-3 rounded-full bg-stone-900 border border-amber-300/60 flex items-center justify-center">
                    <div className="w-1 h-1 rounded-full bg-amber-100" />
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* 正在播放的微光指示 */}
          {isPlaying && (
            <div className="absolute -top-1 -right-1 w-3 h-3 rounded-full bg-amber-500/80 flex items-center justify-center animate-ping pointer-events-none" />
          )}
        </div>

        {/* 曲目信息与法式排版 */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between">
            <h3
              onClick={openLibrary}
              className="font-serif text-sm sm:text-base font-semibold text-stone-900 truncate tracking-wide cursor-pointer hover:text-amber-950 transition-colors"
            >
              {currentTrack?.name || 'Clair de Lune'}
            </h3>
            {isPlaying && (
              <div className="flex items-end gap-0.5 h-3 shrink-0 ml-1">
                <span className="w-0.5 bg-amber-800/70 rounded-full animate-[pulse_0.6s_ease-in-out_infinite] h-2" />
                <span className="w-0.5 bg-amber-800/70 rounded-full animate-[pulse_0.9s_ease-in-out_infinite] h-3" />
                <span className="w-0.5 bg-amber-800/70 rounded-full animate-[pulse_0.7s_ease-in-out_infinite] h-1.5" />
              </div>
            )}
          </div>
          <div className="flex items-center gap-1.5 mt-0.5">
            <p className="text-xs text-stone-600/90 font-serif italic truncate flex-1">
              {currentTrack?.artists || 'Claude Debussy'}
            </p>
            {currentTrack?.isFreeTrial && (
              <span className="px-1 py-0.2 rounded text-[9px] font-mono bg-amber-700/20 text-amber-900 border border-amber-700/30 shrink-0">
                试听
              </span>
            )}
            {currentTrack?.fee === 1 && !currentTrack?.isFreeTrial && (
              <span className="px-1 py-0.2 rounded text-[9px] font-mono bg-amber-800/20 text-amber-900 border border-amber-800/30 shrink-0">
                VIP完整
              </span>
            )}
          </div>
        </div>
      </div>

      {/* 错误或状态轻提示 */}
      {error && (
        <div className="mt-2 px-2.5 py-1 rounded-xl bg-amber-900/10 border border-amber-900/20 text-amber-950 text-[10px] font-serif flex items-center gap-1">
          <AlertCircle className="w-3 h-3 text-amber-800 shrink-0" />
          <span className="truncate">{error}</span>
        </div>
      )}

      {/* 极简进度条 */}
      <div className="mt-3 space-y-1">
        <div
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            const clickPos = (e.clientX - rect.left) / rect.width;
            seek(Math.floor(clickPos * duration));
          }}
          className="w-full h-1.5 rounded-full bg-stone-900/10 hover:bg-stone-900/15 transition-colors cursor-pointer relative overflow-hidden"
        >
          <div
            className="h-full rounded-full bg-gradient-to-r from-stone-700/80 to-amber-800/80 transition-all duration-200"
            style={{ width: `${progressPercent}%` }}
          />
        </div>
        <div className="flex items-center justify-between text-[10px] text-stone-500/90 font-mono tracking-tight">
          <span>{formatTime(currentTime)}</span>
          <span>{formatTime(duration)}</span>
        </div>
      </div>

      {/* 极简播放控制器 (上一曲、播放/暂停、下一曲) */}
      <div className="flex items-center justify-center gap-6 pt-1">
        <button
          onClick={(e) => {
            e.stopPropagation();
            playPrev();
          }}
          className="p-1.5 rounded-full hover:bg-white/40 active:scale-95 text-stone-700 transition-all cursor-pointer"
          title="上一曲"
        >
          <SkipBack className="w-4 h-4" />
        </button>

        <button
          onClick={(e) => {
            e.stopPropagation();
            togglePlay();
          }}
          disabled={isLoading}
          className="w-10 h-10 rounded-full bg-stone-900/85 hover:bg-stone-900 active:scale-95 text-[#fbf7ee] flex items-center justify-center shadow-md transition-all cursor-pointer border border-white/30 disabled:opacity-50"
          title={isPlaying ? '暂停' : '播放'}
        >
          {isLoading ? (
            <RefreshCw className="w-4 h-4 animate-spin" />
          ) : isPlaying ? (
            <Pause className="w-4 h-4 fill-current" />
          ) : (
            <Play className="w-4 h-4 fill-current ml-0.5" />
          )}
        </button>

        <button
          onClick={(e) => {
            e.stopPropagation();
            playNext();
          }}
          className="p-1.5 rounded-full hover:bg-white/40 active:scale-95 text-stone-700 transition-all cursor-pointer"
          title="下一曲"
        >
          <SkipForward className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
};
