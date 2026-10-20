/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * Luma 网易云音乐类型定义
 */

export interface MusicArtist {
  id: number | string;
  name: string;
}

export interface MusicAlbum {
  id: number | string;
  name: string;
  picUrl?: string;
}

export interface MusicTrack {
  id: string;
  name: string;
  artists: string;
  artistsList?: MusicArtist[];
  albumName?: string;
  coverUrl?: string;
  duration: number; // 秒
  fee?: number; // 0: 免费, 1: VIP, 4: 购买专辑, 8: 非VIP低品质
  url?: string; // 播放直链
  level?: string; // 音质
  isVip?: boolean;
  isFreeTrial?: boolean;
  trialStart?: number;
  trialEnd?: number;
  playable?: boolean;
  unplayableReason?: string;
}

export interface MusicPlaylist {
  id: string;
  name: string;
  coverImgUrl: string;
  trackCount: number;
  playCount?: number;
  description?: string;
}

export interface MusicUserProfile {
  isLoggedIn: boolean;
  userId?: number | string;
  nickname?: string;
  avatarUrl?: string;
  vipType?: number;
}

export type PlayMode = 'sequence' | 'loop' | 'random';

export interface SavedMusicState {
  queue: MusicTrack[];
  currentIndex: number;
  currentTime: number;
  isPlaying: boolean;
  volume: number;
  isMuted: boolean;
  playMode: PlayMode;
  updatedAt: number;
}
