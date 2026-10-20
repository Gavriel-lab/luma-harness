/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from 'react';
import { User } from 'lucide-react';
import { getAllMemberAvatars } from '../utils/assetManager';
import './chatSalon.css';

export type SidebarTab = 'messages' | 'contacts' | 'moments' | 'favorites' | 'profile';

interface ChatSidebarProps {
  activeTab: SidebarTab;
  onSelectTab: (tab: SidebarTab) => void;
  onBackToHome?: () => void;
  className?: string;
}

interface SidebarItem {
  id: SidebarTab;
  ariaLabel: string;
  /** 水彩图标；「我的」用本人头像，没有头像时退回线条图标 */
  icon?: string;
}

const salonIcon = (name: string) => `${import.meta.env.BASE_URL}assets/salon/icon-${name}.webp`;

const SIDEBAR_ITEMS: SidebarItem[] = [
  { id: 'messages', ariaLabel: 'Messages (消息)', icon: salonIcon('messages') },
  { id: 'contacts', ariaLabel: 'Contacts (联系人名录)', icon: salonIcon('contacts') },
  { id: 'moments', ariaLabel: 'Moments (朋友圈)', icon: salonIcon('moments') },
  { id: 'favorites', ariaLabel: 'Favoris (收藏)', icon: salonIcon('favorites') },
  { id: 'profile', ariaLabel: 'Profil (我的 · 聊天调色盘)' },
];

export const ChatSidebar: React.FC<ChatSidebarProps> = ({
  activeTab,
  onSelectTab,
  onBackToHome,
  className = '',
}) => {
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
    <aside
      className={`w-1/6 min-w-[58px] max-w-[72px] h-full salon-sidebar flex flex-col items-center justify-between z-20 select-none shrink-0 pointer-events-auto py-safe-sidebar ${className}`}
      style={{
        paddingTop: 'calc(max(env(safe-area-inset-top, 0px), 16px) + 0.5rem)',
        paddingBottom: 'calc(max(env(safe-area-inset-bottom, 0px), 16px) + 0.5rem)'
      }}
      aria-label="Navigation latérale"
    >
      <div className="flex flex-col items-center gap-3 h-full max-h-[560px] w-full py-1">
        {/* 返回莫奈庭院主页 */}
        {onBackToHome && (
          <button
            type="button"
            onClick={onBackToHome}
            aria-label="Accueil (返回庭院主页)"
            title="返回庭院主页"
            className="salon-side-btn h-[54px] mb-0.5"
          >
            <img src={salonIcon('home')} alt="" draggable={false} className="salon-side-icon" style={{ opacity: 0.9 }} />
            <span className="salon-side-label font-calligraphy">Jardin</span>
          </button>
        )}

        <div className="w-6 h-px bg-[#c9a96a]/35 mb-0.5" aria-hidden="true" />

        {SIDEBAR_ITEMS.map((item) => {
          const isActive = activeTab === item.id;
          const isProfile = item.id === 'profile';

          return (
            <button
              key={item.id}
              type="button"
              onClick={() => onSelectTab(item.id)}
              aria-label={item.ariaLabel}
              aria-current={isActive ? 'page' : undefined}
              title={item.ariaLabel}
              data-active={isActive || undefined}
              className="salon-side-btn"
            >
              {isProfile ? (
                userAvatar ? (
                  <img src={userAvatar} alt="" className="salon-side-avatar" />
                ) : (
                  <User className="relative w-5 h-5 text-stone-700" aria-hidden="true" />
                )
              ) : (
                <img src={item.icon} alt="" draggable={false} className="salon-side-icon" />
              )}
            </button>
          );
        })}
      </div>
    </aside>
  );
};
