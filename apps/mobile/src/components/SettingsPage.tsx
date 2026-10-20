/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { 
  Palette, 
  Sun, 
  Moon, 
  RotateCcw, 
  SlidersHorizontal, 
  ChevronRight, 
  LogOut,
  Trash2,
  CheckCircle2,
  Camera
} from 'lucide-react';
import { CustomAssets, getAllMemberAvatars, setMemberAvatar, compressAvatarImage } from '../utils/assetManager';
import { AutonomyPanel } from './AutonomyPanel';
import { CHARACTERS } from '../data/characters';

interface SettingsPageProps {
  isNight: boolean;
  onToggleNight: () => void;
  onOpenAssetModal: () => void;
  onReplaySplash: () => void;
  onBackToHome?: () => void;
  onOpenChatPalette?: () => void;
  assets: CustomAssets;
}

export const SettingsPage: React.FC<SettingsPageProps> = ({
  isNight,
  onToggleNight,
  onOpenAssetModal,
  onReplaySplash,
  onBackToHome,
  onOpenChatPalette,
  assets,
}) => {
  const [clearedNotice, setClearedNotice] = useState(false);
  const [avatars, setAvatars] = useState<Record<string, string>>(() => getAllMemberAvatars());

  // 退出登录并清除本地展示与个人缓存（严格仅清理本项目缓存）
  const handleClearPersonalCacheAndLogout = async () => {
    try {
      localStorage.clear();
      sessionStorage.clear();

      // 清理 PWA 离线缓存（仅限本项目 luma- 缓存，不删站点其他缓存）
      if ('caches' in window) {
        const keys = await caches.keys();
        await Promise.all(
          keys
            .filter((k) => k.startsWith('luma-'))
            .map((k) => caches.delete(k))
        );
      }

      setClearedNotice(true);
      setTimeout(() => {
        window.location.reload();
      }, 1200);
    } catch (e) {
      console.warn('Clear cache error:', e);
      window.location.reload();
    }
  };

  return (
    <div className="relative w-full h-full flex flex-col overflow-y-auto no-scrollbar bg-[#f5eee3]/85 backdrop-blur-md text-stone-900 select-none pb-28">
      {/* 亚麻细布纹底纹 */}
      <div className="fixed inset-0 linen-texture opacity-30 mix-blend-multiply pointer-events-none" />

      {/* 顶部标题 */}
      <header
        className="relative z-10 px-4 pb-4 border-b border-stone-300/40 bg-white/30 backdrop-blur-md pt-safe-settings-header"
        style={{ paddingTop: 'calc(max(env(safe-area-inset-top, 0px), 18px) + 0.85rem)' }}
      >
        <div className="flex items-center justify-between">
          <button
            onClick={onBackToHome}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl hover:bg-white/40 active:bg-white/60 text-stone-800 transition-colors cursor-pointer"
            title="返回主页"
          >
            <span className="text-base leading-none">‹</span>
            <span className="font-calligraphy text-base text-stone-800 tracking-wider">Accueil</span>
          </button>
          <div className="text-center">
            <h1 className="text-lg font-serif font-bold text-stone-900 tracking-wide">
              设置 · Paramètres
            </h1>
            <p className="text-[10px] font-serif text-stone-600/80">
              法式艺术沙龙与个性化偏好
            </p>
          </div>
          <div className="p-2 rounded-2xl bg-white/40 border border-white/50 text-stone-700 shadow-xs">
            <SlidersHorizontal className="w-4 h-4" />
          </div>
        </div>
      </header>

      {/* 设置内容列表 */}
      <main className="relative z-10 px-5 py-5 space-y-4 max-w-md mx-auto w-full font-serif">
        {/* 分组一：画面与主题 */}
        <div className="space-y-1.5">
          <span className="text-xs text-stone-500 uppercase tracking-widest px-1">
            画作与景致
          </span>

          <div className="bg-white/40 rounded-3xl p-3.5 border border-white/60 shadow-xs space-y-3">
            {/* 日夜切换 */}
            <div className="flex items-center justify-between py-1 px-1">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-xl bg-amber-100/80 text-amber-800">
                  {isNight ? <Moon className="w-4 h-4" /> : <Sun className="w-4 h-4" />}
                </div>
                <div>
                  <div className="text-xs font-semibold text-stone-900">
                    {isNight ? '当前为月夜景致' : '当前为日间暖阳'}
                  </div>
                  <div className="text-[10px] text-stone-500">
                    切换主画晨曦光影与深蓝月夜
                  </div>
                </div>
              </div>
              <button
                onClick={onToggleNight}
                className="px-3 py-1.5 rounded-xl bg-stone-900/10 hover:bg-stone-900/15 text-stone-900 text-xs font-medium transition-colors cursor-pointer"
              >
                {isNight ? '转为日间' : '转为月夜'}
              </button>
            </div>

            <div className="h-px bg-stone-300/30" />

            {/* 自定义画作管理 */}
            <div
              onClick={onOpenAssetModal}
              className="flex items-center justify-between py-1 px-1 cursor-pointer hover:bg-white/30 rounded-xl transition-colors"
            >
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-xl bg-rose-100/80 text-rose-800">
                  <Palette className="w-4 h-4" />
                </div>
                <div>
                  <div className="text-xs font-semibold text-stone-900">
                    专属画作与背景替换
                  </div>
                  <div className="text-[10px] text-stone-500">
                    管理日夜主画、开屏睡莲图与聊天背景
                  </div>
                </div>
              </div>
              <ChevronRight className="w-4 h-4 text-stone-400" />
            </div>

            <div className="h-px bg-stone-300/30" />

            {/* 重播开屏液态雨滴 */}
            <div
              onClick={onReplaySplash}
              className="flex items-center justify-between py-1 px-1 cursor-pointer hover:bg-white/30 rounded-xl transition-colors"
            >
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-xl bg-emerald-100/80 text-emerald-800">
                  <RotateCcw className="w-4 h-4" />
                </div>
                <div>
                  <div className="text-xs font-semibold text-stone-900">
                    重温开屏液态水波
                  </div>
                  <div className="text-[10px] text-stone-500">
                    再次感受晨雨微澜与 Owner&Coordinator
                  </div>
                </div>
              </div>
              <ChevronRight className="w-4 h-4 text-stone-400" />
            </div>
          </div>
        </div>

        {/* 分组二：成员头像与个性化管理 (Avatars & Personnalités) */}
        <details className="space-y-1.5 group">
          <summary className="text-xs text-stone-500 tracking-widest px-1 py-2 cursor-pointer">
            成员头像与个性化 <span className="text-[10px] tracking-normal ml-2">点击展开</span>
          </summary>

          <div className="bg-white/40 rounded-3xl p-3.5 border border-white/60 shadow-xs space-y-3">
            <p className="text-[11px] text-stone-600 px-1 leading-relaxed">
              本地上传头像，在手机端聊天气泡、沙龙列表与名片全局生效：
            </p>

            <div className="space-y-2.5">
              {CHARACTERS.map((char) => {
                const currentAvatar = avatars[char.id];

                return (
                  <div
                    key={char.id}
                    className="p-2.5 rounded-2xl bg-white/50 border border-white/70 flex items-center justify-between gap-2.5"
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      <div className="relative shrink-0">
                        {currentAvatar ? (
                          <img
                            src={currentAvatar}
                            alt={char.name}
                            className="w-10 h-10 rounded-full object-cover border-2 border-white shadow-xs"
                          />
                        ) : (
                          <div
                            className="w-10 h-10 rounded-full flex items-center justify-center font-serif text-sm font-bold text-stone-900 border-2 border-white shadow-xs"
                            style={{ backgroundColor: char.signatureColor }}
                          >
                            {char.name.slice(0, 1)}
                          </div>
                        )}
                      </div>

                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="font-serif font-bold text-xs text-stone-900 truncate">
                            {char.name}
                          </span>
                          {char.kind === 'human' && (
                            <span className="text-[9px] px-1.5 py-0.2 rounded bg-rose-100 text-rose-800 font-mono">
                              本人
                            </span>
                          )}
                        </div>
                        <p className="text-[10px] text-stone-500 truncate font-serif mt-0.5">
                          {char.frenchRole}
                        </p>
                      </div>
                    </div>

                    <div className="flex items-center gap-1.5 shrink-0">
                      <label className="px-2.5 py-1.5 rounded-xl bg-amber-600/90 hover:bg-amber-600 text-amber-50 text-[11px] font-serif transition-colors cursor-pointer shadow-xs flex items-center gap-1">
                        <Camera className="w-3 h-3" />
                        <span>更换</span>
                        <input
                          type="file"
                          accept="image/*"
                          onChange={async (e) => {
                            const file = e.target.files?.[0];
                            if (file) {
                              try {
                                const url = await compressAvatarImage(file, 256, 0.85);
                                setMemberAvatar(char.id, url);
                                setAvatars((prev) => ({ ...prev, [char.id]: url }));
                              } catch (err) {
                                console.warn('Avatar compression error:', err);
                              }
                            }
                          }}
                          className="hidden"
                        />
                      </label>

                      {currentAvatar && (
                        <button
                          onClick={() => {
                            setMemberAvatar(char.id, null);
                            setAvatars((prev) => {
                              const next = { ...prev };
                              delete next[char.id];
                              return next;
                            });
                          }}
                          className="p-1.5 rounded-xl hover:bg-stone-200 text-stone-500 hover:text-stone-800 text-[10px] transition-colors cursor-pointer"
                          title="恢复默认头像"
                        >
                          <RotateCcw className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </details>

        {/* 聊天调色盘搬到了聊天里「我的」，这里留一个入口 */}
        <button
          type="button"
          onClick={onOpenChatPalette}
          className="w-full flex items-center justify-between bg-white/40 rounded-3xl px-4 py-3.5 border border-white/60 shadow-xs text-left cursor-pointer active:scale-[.99] transition-transform"
        >
          <span className="flex items-center gap-3">
            <span className="p-2 rounded-xl bg-amber-100/80 text-amber-900"><Palette className="w-4 h-4" /></span>
            <span>
              <span className="block text-xs font-semibold text-stone-900">聊天调色盘</span>
              <span className="block text-[10px] text-stone-500 mt-0.5">字体、气泡、壁纸浓淡，搬到聊天里「我的」了</span>
            </span>
          </span>
          <span className="text-stone-500 text-base leading-none" aria-hidden="true">›</span>
        </button>

        {/* 分组三：安全与缓存清理 */}
        <div className="space-y-1.5">
          <span className="text-xs text-stone-500 uppercase tracking-widest px-1">
            安全与离线缓存
          </span>

          <div className="bg-white/40 rounded-3xl p-3.5 border border-white/60 shadow-xs space-y-3">
            <div
              onClick={handleClearPersonalCacheAndLogout}
              className="flex items-center justify-between py-1 px-1 cursor-pointer hover:bg-rose-50/50 rounded-xl transition-colors"
            >
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-xl bg-rose-100/80 text-rose-800">
                  <LogOut className="w-4 h-4" />
                </div>
                <div>
                  <div className="text-xs font-semibold text-rose-950">
                    退出登录并清除展示缓存
                  </div>
                  <div className="text-[10px] text-stone-500">
                    清除本地自定义壁纸缓存、静态缓存并重定向登录
                  </div>
                </div>
              </div>
              {clearedNotice ? (
                <CheckCircle2 className="w-4 h-4 text-emerald-600 animate-bounce" />
              ) : (
                <Trash2 className="w-4 h-4 text-stone-400" />
              )}
            </div>
          </div>
        </div>

        <AutonomyPanel />
        {/* 分组三：法式艺术客户端信息 */}
        <div className="space-y-1.5">
          <span className="text-xs text-stone-500 uppercase tracking-widest px-1">
            关于客户端
          </span>

          <div className="bg-white/40 rounded-3xl p-4 border border-white/60 shadow-xs space-y-2.5 text-xs text-stone-700">
            <div className="flex items-center justify-between">
              <span className="text-stone-500">客户端型号</span>
              <span className="font-mono text-stone-800">iPhone 14 Pro Max 竖屏</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-stone-500">真实成员线路</span>
              <span className="font-mono text-stone-800">R2 / Cloudflare 同源网关</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-stone-500">设计语言</span>
              <span>莫奈印象派 · 低饱和度法式沙龙</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-stone-500">技术栈</span>
              <span className="font-mono text-stone-800">React 19 + PWA + Service Worker</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-stone-500">专属副题</span>
              <span className="font-serif italic text-amber-900/80">Owner & Coordinator</span>
            </div>
          </div>
        </div>

        {/* 底部暖心寄语 */}
        <div className="text-center pt-4 pb-2 text-[11px] text-stone-500/80 font-serif italic">
          「把每一天的细碎光影，谱写成画布上的法式诗意。」
        </div>
      </main>
    </div>
  );
};
