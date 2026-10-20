/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from 'react';
import { MapPin } from 'lucide-react';
import { getAllMemberAvatars } from '../utils/assetManager';
import { ChatAppearancePanel } from './ChatAppearancePanel';

export const ChatProfileView: React.FC<{ chatBackground: string | null }> = ({ chatBackground }) => {
  const [avatarMap, setAvatarMap] = useState<Record<string, string>>(() => getAllMemberAvatars());

  useEffect(() => {
    const handleAvatarUpdate = () => {
      setAvatarMap(getAllMemberAvatars());
    };
    window.addEventListener('luma_avatar_updated', handleAvatarUpdate);
    return () => window.removeEventListener('luma_avatar_updated', handleAvatarUpdate);
  }, []);

  const userAvatar = avatarMap['agent_owner'] || avatarMap['user'] || null;

  return (
    <div className="relative w-full h-full flex flex-col overflow-y-auto no-scrollbar select-none pb-28 text-stone-900 px-3">
      {/* 顶部标题：法文手写体 */}
      <header
        className="relative z-10 pb-2 pt-safe-salon-header"
        style={{ paddingTop: 'calc(max(env(safe-area-inset-top, 0px), 16px) + 1rem)' }}
      >
        <div>
          <h1 className="font-calligraphy text-3xl sm:text-4xl text-stone-900 script-shadow tracking-wide leading-tight">
            Mon Profil d'Artiste
          </h1>
          <p className="font-calligraphy text-base sm:text-lg text-stone-700/90 italic -mt-0.5">
            Portrait de Zhao Zhao · Giverny
          </p>
        </div>
      </header>

      {/* 个人主卡片 */}
      <div className="space-y-3.5 pt-1">
        <div className="fr-chat-glass-card rounded-3xl p-5 flex flex-col items-center text-center space-y-3">
          {/* 大头像 */}
          <div className="w-18 h-18 rounded-full bg-gradient-to-tr from-rose-300 via-amber-200 to-emerald-200 p-0.5 shadow-md">
            {userAvatar ? (
              <img
                src={userAvatar}
                alt="使用者"
                className="w-full h-full rounded-full object-cover shadow-inner"
              />
            ) : (
              <div className="w-full h-full rounded-full bg-[#f6eee2] flex items-center justify-center text-2xl font-serif font-bold text-stone-900 shadow-inner">
                U
              </div>
            )}
          </div>

          <div>
            <h2 className="font-serif font-bold text-base text-stone-900">
              使用者 · Zhao Zhao
            </h2>
            <div className="flex items-center justify-center gap-1.5 text-xs text-stone-600 font-serif mt-0.5">
              <MapPin className="w-3 h-3 text-rose-600" />
              <span className="font-calligraphy text-sm">Jardin de Giverny</span>
            </div>
          </div>

          <p className="text-xs font-serif text-stone-700 leading-relaxed italic bg-white/20 p-3 rounded-2xl border border-white/35 max-w-xs">
            « Cueillir la clarté de l’aube et le vieux rose des nénuphars pour en faire un poème éternel. »
          </p>
        </div>

        {/* 聊天调色盘：从设置页挪过来，调完回消息页就能看到效果 */}
        <div id="chat-palette">
          <ChatAppearancePanel background={chatBackground} />
        </div>
      </div>
    </div>
  );
};
