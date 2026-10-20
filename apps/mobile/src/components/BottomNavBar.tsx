/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { Home, BookOpen, MessageSquareHeart, Settings } from 'lucide-react';
import { PageId } from '../types';

interface BottomNavBarProps {
  currentPage: PageId;
  onSelectTab: (tab: PageId) => void;
}

interface NavItem {
  id: PageId;
  label: string;
  frenchLabel: string;
  icon: React.ComponentType<{ className?: string }>;
}

const NAV_ITEMS: NavItem[] = [
  {
    id: 'home',
    label: '主页',
    frenchLabel: 'Accueil',
    icon: Home,
  },
  {
    id: 'diary',
    label: '日记',
    frenchLabel: 'Carnets',
    icon: BookOpen,
  },
  {
    id: 'chat',
    label: '聊天',
    frenchLabel: 'Salon',
    icon: MessageSquareHeart,
  },
  {
    id: 'settings',
    label: '设置',
    frenchLabel: 'Options',
    icon: Settings,
  },
];

export const BottomNavBar: React.FC<BottomNavBarProps> = ({
  currentPage,
  onSelectTab,
}) => {
  return (
    <div
      className="absolute inset-x-0 z-40 px-4 pointer-events-none flex justify-center bottom-safe-nav"
      style={{
        bottom: 'calc(max(env(safe-area-inset-bottom, 0px), 12px) + 0.35rem)'
      }}
    >
      <nav
        className="pointer-events-auto w-full max-w-[360px] px-3.5 py-1.5 rounded-full bg-white/25 backdrop-blur-2xl border border-white/50 text-stone-900 select-none flex items-center justify-between transition-all duration-300"
        style={{
          boxShadow: '0 16px 40px -10px rgba(60, 50, 40, 0.18), inset 0 1px 2px rgba(255, 255, 255, 0.7)'
        }}
      >
        {NAV_ITEMS.map((item) => {
          const isActive = currentPage === item.id;
          const IconComponent = item.icon;

          return (
            <button
              key={item.id}
              onClick={() => onSelectTab(item.id)}
              className={`flex flex-col items-center justify-center py-1 px-3 rounded-2xl transition-all duration-300 cursor-pointer ${
                isActive
                  ? 'text-stone-950 scale-105 font-bold'
                  : 'text-stone-700/75 hover:text-stone-900 hover:bg-white/20'
              }`}
            >
              <div
                className={`p-1.5 rounded-xl transition-all ${
                  isActive
                    ? 'bg-stone-900/12 shadow-inner text-stone-950'
                    : 'text-stone-700/80'
                }`}
              >
                <IconComponent
                  className={`w-5 h-5 transition-transform ${
                    isActive ? 'stroke-[2.3]' : 'stroke-[1.8]'
                  }`}
                />
              </div>

              <span className="text-[11px] font-serif tracking-wider mt-0.5">
                {item.label}
              </span>
            </button>
          );
        })}
      </nav>
    </div>
  );
};
