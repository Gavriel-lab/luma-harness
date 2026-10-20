/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { Heart } from 'lucide-react';

export const ChatFavoritesView: React.FC = () => {
  const favorites = [
    {
      id: 'f1',
      tag: 'Formule de Couleurs',
      title: 'Vieux Rose & Bleu de Brume',
      desc: 'Rose poudré : #c69390 | Bleu brumeux : #8fa4b2 | Lin écru : #f5eee3. Capturer la nuance la plus tendre des aurores.',
      source: 'Carnet d’atelier de Zhao Zhao',
      time: '5 oct.',
    },
    {
      id: 'f2',
      tag: 'Pensée Poétique',
      title: 'La Sérénité est l’Ultime Esthétique',
      desc: 'Là où l’eau et le ciel s’entremêlent, le flou le plus délicat porte la poésie la plus profonde.',
      source: 'Notes nocturnes de Gao Rui',
      time: '4 oct.',
    },
    {
      id: 'f3',
      tag: 'Poésie Numérique',
      title: 'Ondulations & Reflets d’Eau',
      desc: 'Une goutte d’eau tombe, puis deux à trois cercles d’ondes se dispersent doucement sans altérer l’impressionnisme du tableau.',
      source: 'Atelier de Worker',
      time: '5 oct.',
    },
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
            Trésors & Favoris
          </h1>
          <p className="font-calligraphy text-base sm:text-lg text-stone-700/90 italic -mt-0.5">
            Archives des Souvenirs & Citations
          </p>
        </div>
      </header>

      {/* 收藏卡片列表 */}
      <div className="space-y-3 pt-2">
        {favorites.map((item) => (
          <div
            key={item.id}
            className="fr-chat-glass-card rounded-2xl p-4 space-y-2.5"
          >
            <div className="flex items-center justify-between">
              <span className="font-calligraphy text-sm text-stone-800 bg-white/45 px-2.5 py-0.5 rounded-full border border-white/60">
                {item.tag}
              </span>
              <span className="text-[10px] font-mono text-stone-500">
                {item.time}
              </span>
            </div>

            <h3 className="font-calligraphy text-xl text-stone-900 font-bold">
              {item.title}
            </h3>

            <p className="text-xs font-serif text-stone-700/90 leading-relaxed italic bg-white/20 p-2.5 rounded-xl border border-white/30">
              « {item.desc} »
            </p>

            <div className="flex items-center justify-between pt-1 text-[10px] text-stone-500 font-serif">
              <span className="italic">{item.source}</span>
              <Heart className="w-3.5 h-3.5 text-rose-500 fill-rose-500/20" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};
