/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * Luma 网易云音乐 API 客户端
 */

import { MusicTrack, MusicPlaylist, MusicUserProfile } from '../types/music';

const API_BASE = '/api/music';

async function fetchJson<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...options,
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      ...(options?.headers || {})
    }
  });

  if (!res.ok) {
    let errMessage = `HTTP ${res.status}`;
    try {
      const errObj = await res.json();
      if (errObj && (errObj.message || errObj.error)) {
        errMessage = typeof errObj.message === 'string' ? errObj.message : JSON.stringify(errObj.error || errObj);
      }
    } catch {
      // ignore json parse error
    }
    throw new Error(errMessage);
  }

  return res.json() as Promise<T>;
}

export const musicApi = {
  /**
   * 1. 获取二维码 key
   */
  async getQrKey(): Promise<string> {
    const data = await fetchJson<{ ok: boolean; unikey: string }>(`${API_BASE}/login/qr/key?t=${Date.now()}`);
    return data.unikey;
  },

  /**
   * 2. 生成二维码 Data URL
   */
  async getQrImage(key: string): Promise<string> {
    const data = await fetchJson<{ ok: boolean; qrimg: string; qrurl: string }>(
      `${API_BASE}/login/qr/create?key=${encodeURIComponent(key)}&qrimg=true&t=${Date.now()}`
    );
    return data.qrimg;
  },

  /**
   * 3. 轮询二维码扫码状态
   * 800: 二维码不存在或已过期
   * 801: 等待扫码
   * 802: 待确认
   * 803: 授权登录成功
   */
  async checkQrStatus(key: string): Promise<{ code: number; message: string }> {
    const data = await fetchJson<{ code: number; message: string }>(
      `${API_BASE}/login/qr/check?key=${encodeURIComponent(key)}&t=${Date.now()}`
    );
    return data;
  },

  /**
   * 4. 获取登录用户信息
   */
  async getUserProfile(): Promise<MusicUserProfile> {
    const data = await fetchJson<{ ok: boolean; profile: MusicUserProfile }>(`${API_BASE}/user/status?t=${Date.now()}`);
    return data.profile;
  },

  /**
   * 5. 退出登录
   */
  async logout(): Promise<void> {
    await fetchJson<{ ok: boolean }>(`${API_BASE}/logout`, { method: 'POST' });
  },

  /**
   * 6. 获取用户歌单
   */
  async getUserPlaylists(): Promise<MusicPlaylist[]> {
    const data = await fetchJson<{ ok: boolean; playlists: MusicPlaylist[] }>(`${API_BASE}/user/playlists?t=${Date.now()}`);
    return data.playlists;
  },

  /**
   * 7. 获取歌单内曲目
   */
  async getPlaylistTracks(playlistId: string, limit = 100, offset = 0): Promise<MusicTrack[]> {
    const data = await fetchJson<{ ok: boolean; tracks: MusicTrack[] }>(
      `${API_BASE}/playlist/tracks?id=${encodeURIComponent(playlistId)}&limit=${limit}&offset=${offset}&t=${Date.now()}`
    );
    return data.tracks;
  },

  /**
   * 8. 搜索歌曲
   */
  async searchSongs(keywords: string, limit = 30, offset = 0): Promise<MusicTrack[]> {
    const data = await fetchJson<{ ok: boolean; tracks: MusicTrack[] }>(
      `${API_BASE}/search?keywords=${encodeURIComponent(keywords)}&limit=${limit}&offset=${offset}&t=${Date.now()}`
    );
    return data.tracks;
  },

  /**
   * 9. 获取歌曲播放直链与试听判定
   */
  async getSongUrl(songId: string): Promise<{
    url: string;
    duration: number;
    level: string;
    playable: boolean;
    isFreeTrial: boolean;
    trialStart?: number;
    trialEnd?: number;
    unplayableReason?: string;
  }> {
    const data = await fetchJson<{
      ok: boolean;
      url: string;
      duration: number;
      level: string;
      playable: boolean;
      isFreeTrial: boolean;
      trialStart?: number;
      trialEnd?: number;
      unplayableReason?: string;
    }>(`${API_BASE}/song/url?id=${encodeURIComponent(songId)}&t=${Date.now()}`);
    return data;
  },

  /**
   * 10. 每日推荐歌曲（需要登录，未登录返回空）
   */
  async getDailySongs(): Promise<MusicTrack[]> {
    const data = await fetchJson<{ ok: boolean; tracks: MusicTrack[] }>(`${API_BASE}/recommend/songs?t=${Date.now()}`);
    return data.tracks || [];
  },

  /**
   * 11. 推荐歌单（登录后为个人推荐，否则为大众推荐）
   */
  async getRecommendPlaylists(): Promise<MusicPlaylist[]> {
    const data = await fetchJson<{ ok: boolean; playlists: MusicPlaylist[] }>(`${API_BASE}/recommend/playlists?t=${Date.now()}`);
    return data.playlists || [];
  },

  /**
   * 12. 排行榜（榜单即歌单，曲目用 getPlaylistTracks 取）
   */
  async getToplists(): Promise<MusicPlaylist[]> {
    const data = await fetchJson<{ ok: boolean; playlists: MusicPlaylist[] }>(`${API_BASE}/toplists?t=${Date.now()}`);
    return data.playlists || [];
  },

  /**
   * 13. 歌词：lrc 原文、tlyric 翻译
   */
  async getLyric(songId: string): Promise<{ lrc: string; tlyric: string; pureMusic: boolean }> {
    const data = await fetchJson<{ ok: boolean; lrc: string; tlyric: string; pureMusic: boolean }>(
      `${API_BASE}/lyric?id=${encodeURIComponent(songId)}`
    );
    return { lrc: data.lrc || '', tlyric: data.tlyric || '', pureMusic: !!data.pureMusic };
  }
};
