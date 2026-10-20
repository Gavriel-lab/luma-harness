/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useRef } from 'react';
import { ChatSidebar, SidebarTab } from './ChatSidebar';
import { ChatList } from './ChatList';
import { ChatRoom } from './ChatRoom';
import { ChatContactsView } from './ChatContactsView';
import { ChatMomentsView } from './ChatMomentsView';
import { ChatFavoritesView } from './ChatFavoritesView';
import { ChatProfileView } from './ChatProfileView';
import { ConversationDto } from '../types';
import { BUNDLED_ASSETS } from '../utils/assetManager';
import './chatSalon.css';

interface ChatTabProps {
  onBackToHome: () => void;
  customChatBgUrl: string | null;
  /** 首页日间画作；没设聊天背景时调淡铺在底下 */
  homePainting?: string | null;
  /** 从设置页跳过来调色时直接落在「我的」 */
  initialTab?: SidebarTab;
}

export const ChatTab: React.FC<ChatTabProps> = ({
  onBackToHome,
  customChatBgUrl,
  homePainting,
  initialTab = 'messages',
}) => {
  const [activeTab, setActiveTab] = useState<SidebarTab>(initialTab);
  const [selectedCharacterId, setSelectedCharacterId] = useState<string | null>(null);
  const [selectedGroup, setSelectedGroup] = useState<ConversationDto | undefined>();
  const [isDetailMounted, setIsDetailMounted] = useState<boolean>(false);
  const [isDetailVisible, setIsDetailVisible] = useState<boolean>(false);

  // 手势记录
  const touchStartRef = useRef<{ x: number; y: number } | null>(null);

  const handleSelectTab = (tab: SidebarTab) => {
    setActiveTab(tab);
    if (isDetailMounted) {
      handleCloseDetail();
    }
  };

  const handleOpenDetail = (characterId: string) => {
    setSelectedGroup(undefined);
    setSelectedCharacterId(characterId);
    setIsDetailMounted(true);
    // 下一帧触发 300ms Push 全屏推入动画
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        setIsDetailVisible(true);
      });
    });
  };

  const handleCloseDetail = () => {
    setIsDetailVisible(false);
    // 300ms 滑出动画结束后卸载详情页，返回一级列表
    setTimeout(() => {
      setIsDetailMounted(false);
      setSelectedCharacterId(null);
    }, 300);
  };

  // 右滑返回手势监听（支持 iOS 边缘滑动与页面右滑返回）
  const handleTouchStart = (e: React.TouchEvent) => {
    if (e.touches.length === 1) {
      touchStartRef.current = {
        x: e.touches[0].clientX,
        y: e.touches[0].clientY,
      };
    }
  };

  const handleTouchEnd = (e: React.TouchEvent) => {
    if (!touchStartRef.current || e.changedTouches.length === 0) return;
    const endX = e.changedTouches[0].clientX;
    const endY = e.changedTouches[0].clientY;
    const deltaX = endX - touchStartRef.current.x;
    const deltaY = endY - touchStartRef.current.y;
    const startX = touchStartRef.current.x;
    touchStartRef.current = null;

    // 起点位于屏幕偏左侧（< 180px）且向右滑动大于 65px，且垂直偏移小于 55px（非上下滚动）
    if (startX < 180 && deltaX > 65 && Math.abs(deltaY) < 55) {
      handleCloseDetail();
    }
  };

  const renderTabContent = () => {
    switch (activeTab) {
      case 'messages':
        return (
          <ChatList
            onSelectCharacter={handleOpenDetail}
            onSelectGroup={(group) => { handleOpenDetail('agent_coordinator'); setSelectedGroup(group); }}
            onBackToHome={onBackToHome}
            customChatBgUrl={customChatBgUrl}
          />
        );
      case 'contacts':
        return (
          <ChatContactsView
            onSelectCharacter={handleOpenDetail}
          />
        );
      case 'moments':
        return <ChatMomentsView />;
      case 'favorites':
        return <ChatFavoritesView />;
      case 'profile':
        return <ChatProfileView chatBackground={customChatBgUrl} />;
      default:
        return null;
    }
  };

  return (
    <div className="relative w-full h-full min-w-0 min-h-0 flex overflow-hidden select-none bg-[#f5eee3]">
      {/* 统一诗意莫奈背景 */}
      <div className="absolute inset-0 z-0 overflow-hidden pointer-events-none">
        {customChatBgUrl ? (
          <img
            src={customChatBgUrl}
            alt="Fond de Salon"
            referrerPolicy="no-referrer"
            className="w-full h-full object-cover filter blur-[10px] scale-105 opacity-55"
          />
        ) : (
          <>
            {/* 首页那幅莫奈调淡虚化，从首页进来颜色是接着的 */}
            <img
              src={homePainting || BUNDLED_ASSETS.dayMainPainting}
              alt=""
              aria-hidden="true"
              draggable={false}
              className="salon-backdrop-painting"
            />
            <div className="salon-backdrop-wash" />
          </>
        )}
        <div className="absolute inset-0 linen-texture opacity-35 mix-blend-multiply" />
        {customChatBgUrl && <div className="absolute inset-0 bg-[#f5eee3]/60 backdrop-blur-[2px]" />}
      </div>

      {/* 一级页面左侧边栏 (五枚图标：消息、联系人、朋友圈、收藏、我的，以及底部返回主页) */}
      <ChatSidebar
        activeTab={activeTab}
        onSelectTab={handleSelectTab}
        onBackToHome={onBackToHome}
        className={isDetailVisible ? 'pointer-events-none opacity-0 md:opacity-100 transition-opacity duration-200' : 'transition-opacity duration-200'}
      />

      {/* 一级页面右侧主体内容展示区域 */}
      <main className="flex-1 min-w-0 min-h-0 h-full overflow-hidden relative z-10">
        {renderTabContent()}
      </main>

      {/* 二级页面：聊天详情页以 Push 方式全屏推入（从右滑入 300ms），占满全屏，不显示侧边栏 */}
      {isDetailMounted && selectedCharacterId && (
        <div
          className={`absolute inset-0 z-30 w-full h-full bg-[#f5eee3] shadow-2xl transition-transform duration-300 ease-out ${
            isDetailVisible ? 'translate-x-0' : 'translate-x-full'
          }`}
          onTouchStart={selectedGroup ? undefined : handleTouchStart}
          onTouchEnd={selectedGroup ? undefined : handleTouchEnd}
        >
          <ChatRoom
            initialCharacterId={selectedCharacterId}
            groupConversation={selectedGroup}
            onBackToList={handleCloseDetail}
            onBackToHome={onBackToHome}
            customChatBgUrl={customChatBgUrl}
          />
        </div>
      )}
    </div>
  );
};
