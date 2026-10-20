/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';

interface ChatGroupsViewProps {
  onSelectGroupChat: (groupId: string) => void;
}

export const ChatGroupsView: React.FC<ChatGroupsViewProps> = ({
  onSelectGroupChat,
}) => {
  const groups = [
    {
      id: 'group_garden',
      frenchName: 'Le Thé au Jardin',
      chineseTitle: '花园茶话会',
      members: 4,
      desc: '« Autour de la table en bois, le thé fume doucement et les pinceaux reposent au soleil. »',
      lastTime: 'Hier',
      avatars: ['Z', 'L', 'G', 'R']
    },
    {
      id: 'group_plein_air',
      frenchName: 'Atelier Plein Air',
      chineseTitle: '莫奈写生社',
      members: 6,
      desc: '« Capter l’éphémère reflet de l’aube et les nuances changeantes de l’étang. »',
      lastTime: '3 j',
      avatars: ['M', 'Z', 'R', 'G']
    },
    {
      id: 'group_botanique',
      frenchName: 'Cercle Botanique',
      chineseTitle: '睡莲植物研习会',
      members: 12,
      desc: '« Étude des nénuphars blancs et des glycines suspendues de Giverny. »',
      lastTime: '5 j',
      avatars: ['B', 'L', 'Z', 'W']
    }
  ];

  return (
    <div className="relative w-full h-full flex flex-col overflow-y-auto no-scrollbar select-none pb-28 text-stone-900 px-3">
      {/* 顶部标题：法文手写体 */}
      <header
        className="relative z-10 pb-2 pt-safe-salon-header"
        style={{ paddingTop: 'calc(max(env(safe-area-inset-top, 0px), 16px) + 1rem)' }}
      >
        <div>
          <h1 className="font-calligraphy text-3xl sm:text-4xl text-stone-900 script-shadow tracking-wide leading-tight">
            Groupes du Jardin
          </h1>
          <p className="font-calligraphy text-base sm:text-lg text-stone-700/90 italic -mt-0.5">
            Cercles d'Art & Ateliers Partagés
          </p>
        </div>
      </header>

      {/* 群组列表 */}
      <div className="space-y-3 pt-2">
        {groups.map((g) => (
          <div
            key={g.id}
            onClick={() => onSelectGroupChat(g.id)}
            className="fr-chat-glass-card rounded-2xl p-3.5 flex flex-col gap-2.5 cursor-pointer group"
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                {/* 四宫格头像 */}
                <div className="w-11 h-11 rounded-2xl bg-white/45 border border-white/70 p-1 grid grid-cols-2 gap-0.5 shadow-sm shrink-0">
                  {g.avatars.map((av, i) => (
                    <div
                      key={i}
                      className="rounded-md bg-stone-200/80 flex items-center justify-center text-[10px] font-serif font-bold text-stone-800"
                    >
                      {av}
                    </div>
                  ))}
                </div>

                <div>
                  <div className="flex items-baseline gap-1.5">
                    <span className="font-calligraphy text-lg text-stone-900 font-bold">
                      {g.frenchName}
                    </span>
                    <span className="text-[10px] font-serif text-stone-500">
                      ({g.chineseTitle})
                    </span>
                  </div>
                  <span className="text-[10px] font-mono text-stone-500 bg-white/40 px-1.5 py-0.2 rounded-full border border-white/60 inline-block mt-0.5">
                    {g.members} membres
                  </span>
                </div>
              </div>

              <span className="text-[10px] text-stone-400 font-mono">
                {g.lastTime}
              </span>
            </div>

            <p className="text-xs text-stone-700/90 font-serif italic leading-relaxed bg-white/20 p-2.5 rounded-xl border border-white/35">
              {g.desc}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
};
