/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from 'react';
import { CHARACTERS } from '../data/characters';
import { getAllMemberAvatars } from '../utils/assetManager';
import { MessageSquareHeart, Sparkles, Feather } from 'lucide-react';

interface ChatContactsViewProps {
  onSelectCharacter: (characterId: string) => void;
}

export const ChatContactsView: React.FC<ChatContactsViewProps> = ({
  onSelectCharacter,
}) => {
  const [avatarMap, setAvatarMap] = useState<Record<string, string>>(() => getAllMemberAvatars());

  useEffect(() => {
    const handleAvatarUpdate = () => {
      setAvatarMap(getAllMemberAvatars());
    };
    window.addEventListener('luma_avatar_updated', handleAvatarUpdate);
    return () => window.removeEventListener('luma_avatar_updated', handleAvatarUpdate);
  }, []);

  // 过滤出 已配置 AI 成员
  const aiMembers = CHARACTERS.filter((c) => c.kind !== 'human');
  const humanMember = CHARACTERS.find((c) => c.kind === 'human');

  return (
    <div className="relative w-full h-full flex flex-col overflow-y-auto no-scrollbar select-none pb-28 text-stone-900 px-3">
      {/* 顶部标题：法文手写体 */}
      <header
        className="relative z-10 pb-2 pt-safe-salon-header"
        style={{ paddingTop: 'calc(max(env(safe-area-inset-top, 0px), 16px) + 1rem)' }}
      >
        <div>
          <h1 className="font-calligraphy text-3xl sm:text-4xl text-stone-900 script-shadow tracking-wide leading-tight">
            Carnet du Salon
          </h1>
          <p className="font-calligraphy text-base sm:text-lg text-stone-700/90 italic -mt-0.5">
            Compagnons & Personnalités · 联系人名录
          </p>
        </div>
      </header>

      <div className="space-y-4 pt-1">
        {/* 画室主人（使用者本人名片） */}
        {humanMember && (
          <section className="space-y-2">
            <div className="flex items-center justify-between px-1">
              <span className="font-calligraphy text-lg text-stone-850 script-shadow">
                Artiste Résidente
              </span>
              <span className="font-calligraphy text-xs text-rose-700/80 italic">
                画室主人 · 本人
              </span>
            </div>

            <div className="fr-chat-glass-card rounded-3xl p-4 space-y-3 bg-gradient-to-br from-rose-50/40 via-white/30 to-amber-50/30 border border-rose-200/60 shadow-sm">
              <div className="flex items-center gap-3">
                {avatarMap[humanMember.id] || avatarMap['user'] ? (
                  <img
                    src={avatarMap[humanMember.id] || avatarMap['user']}
                    alt={humanMember.name}
                    className="w-12 h-12 rounded-full object-cover border-2 border-white shadow-sm shrink-0"
                  />
                ) : (
                  <div
                    className="w-12 h-12 rounded-full flex items-center justify-center font-serif text-base font-bold text-stone-900 border-2 border-white shadow-sm shrink-0"
                    style={{ backgroundColor: humanMember.signatureColor }}
                  >
                    U
                  </div>
                )}
                <div className="flex-1 min-w-0">
                  <div className="flex items-baseline gap-2">
                    <span className="font-serif font-bold text-base text-stone-900">
                      {humanMember.name}
                    </span>
                    <span className="font-calligraphy text-xs text-stone-600">
                      {humanMember.frenchRole}
                    </span>
                  </div>
                  <p className="text-[11px] font-serif text-stone-600 mt-0.5">
                    {humanMember.role}
                  </p>
                </div>
                <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-rose-100/80 text-rose-800 border border-rose-200 shrink-0">
                  本人
                </span>
              </div>

              {/* 使用者个人卡片介绍 */}
              <div className="p-3 rounded-2xl bg-white/40 border border-white/60 text-xs font-serif text-stone-700 space-y-1">
                <div className="flex items-center gap-1.5 text-stone-800 font-semibold text-[11px]">
                  <Feather className="w-3 h-3 text-rose-600" />
                  <span>画室写生手记</span>
                </div>
                <p className="italic text-[11px] leading-relaxed text-stone-600">
                  「把晨光微熹与睡莲的旧粉揉进画布。负责为所有小屋伙伴描摹光影，是庭院的中心与灵魂。」
                </p>
              </div>
            </div>
          </section>
        )}

        {/* 小屋正式伙伴名片列表 */}
        <section className="space-y-3 pt-2">
          <div className="flex items-center justify-between px-1">
            <span className="font-calligraphy text-lg text-stone-850 script-shadow">
              Compagnons Fidèles
            </span>
            <span className="font-calligraphy text-xs text-stone-600/80 italic">
              小屋成员 · 5人
            </span>
          </div>

          <div className="space-y-3">
            {aiMembers.map((member) => (
              <div
                key={member.id}
                className="fr-chat-glass-card rounded-3xl p-4 space-y-3 transition-transform hover:-translate-y-0.5"
              >
                {/* 顶部成员基本信息与发起私聊按钮 */}
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="relative shrink-0">
                      {avatarMap[member.id] ? (
                        <img
                          src={avatarMap[member.id]}
                          alt={member.name}
                          className="w-11 h-11 rounded-full object-cover border border-white/80 shadow-sm"
                        />
                      ) : (
                        <div
                          className="w-11 h-11 rounded-full flex items-center justify-center font-serif text-sm font-bold text-stone-900 border border-white/80 shadow-sm"
                          style={{ backgroundColor: member.signatureColor }}
                        >
                          {member.name.slice(0, 1)}
                        </div>
                      )}
                      <span className="absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full bg-emerald-500 border-2 border-white shadow-xs" />
                    </div>

                    <div>
                      <div className="flex items-baseline gap-2">
                        <span className="font-serif font-bold text-sm text-stone-900">
                          {member.name}
                        </span>
                        <span className="font-calligraphy text-xs text-stone-600">
                          {member.frenchRole}
                        </span>
                      </div>
                      <p className="text-[11px] font-serif text-stone-600 mt-0.5">
                        {member.role}
                      </p>
                    </div>
                  </div>

                  {/* 快捷发起私聊 */}
                  <button
                    onClick={() => onSelectCharacter(member.id)}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-2xl bg-amber-600/90 hover:bg-amber-600 active:scale-95 text-amber-50 text-xs font-serif shadow-xs transition-all cursor-pointer shrink-0"
                    title={`与 ${member.name} 发起私聊`}
                  >
                    <MessageSquareHeart className="w-3.5 h-3.5" />
                    <span>信笺私聊</span>
                  </button>
                </div>

                {/* 个人卡片介绍区域（预留待使用者填入） */}
                <div className="p-3 rounded-2xl bg-white/35 border border-white/50 text-xs font-serif text-stone-700 space-y-1.5">
                  <div className="flex items-center justify-between text-[11px] text-stone-800 font-semibold border-b border-stone-200/60 pb-1">
                    <div className="flex items-center gap-1.5">
                      <Sparkles className="w-3 h-3 text-amber-700" />
                      <span>个人卡片介绍</span>
                    </div>
                    <span className="text-[10px] font-mono text-stone-500 italic">
                      待使用者定制
                    </span>
                  </div>

                  <p className="text-[11px] leading-relaxed text-stone-600 italic">
                    {member.greeting || '「在莫奈的花园里守护着微风与石阶，随时等候使用者的呼唤与分享。」'}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
};
