/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from 'react';
import { CHARACTERS,updateCharacters } from '../data/characters';
import { Character, MemberDto, ConversationDto } from '../types';
import { fetchMembers, fetchConversations } from '../utils/apiClient';
import { getAllMemberAvatars } from '../utils/assetManager';
import { WifiOff } from 'lucide-react';
import './chatSalon.css';

const SALON_ASSET = (name: string) => `${import.meta.env.BASE_URL}assets/${name}.webp`;
const SEAL_MASK = `url(${SALON_ASSET('salon/seal-ivory')})`;

interface ChatListProps {
  onSelectCharacter: (characterId: string) => void;
  onSelectGroup: (conversation: ConversationDto) => void;
  onBackToHome?: () => void;
  customChatBgUrl?: string | null;
}

function formatConversationTime(isoString?: string): string {
  if (!isoString) return '';
  try {
    const date = new Date(isoString);
    if (isNaN(date.getTime())) return '';
    const now = new Date();
    const isToday =
      date.getFullYear() === now.getFullYear() &&
      date.getMonth() === now.getMonth() &&
      date.getDate() === now.getDate();

    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');

    if (isToday) {
      return `${hours}:${minutes}`;
    }
    const month = date.getMonth() + 1;
    const day = date.getDate();
    return `${month}/${day} ${hours}:${minutes}`;
  } catch {
    return '';
  }
}

export const ChatList: React.FC<ChatListProps> = ({
  onSelectCharacter,
  onSelectGroup,
  onBackToHome,
}) => {
  const [searchQuery] = useState('');
  const [characters, setCharacters] = useState<Character[]>(CHARACTERS);
  const [isGatewayConnected, setIsGatewayConnected] = useState<boolean | null>(null);
  const [gatewayMessage, setGatewayMessage] = useState<string>('');
  const [groups, setGroups] = useState<ConversationDto[]>([]);
  const [memberCount, setMemberCount] = useState(0);
  const [groupMembers, setGroupMembers] = useState<MemberDto[]>([]);
  const [avatarMap, setAvatarMap] = useState<Record<string, string>>(() => getAllMemberAvatars());

  useEffect(() => {
    const handleAvatarUpdate = () => {
      setAvatarMap(getAllMemberAvatars());
    };
    window.addEventListener('luma_avatar_updated', handleAvatarUpdate);
    return () => window.removeEventListener('luma_avatar_updated', handleAvatarUpdate);
  }, []);

  const [refreshTrigger, setRefreshTrigger] = useState(0);

  useEffect(() => {
    let isMounted = true;
    const controller = new AbortController();

    async function loadLiveSalonData() {
      try {
        const [liveMembers, liveConversations]: [MemberDto[], ConversationDto[]] = await Promise.all([
          fetchMembers(controller.signal),
          fetchConversations(controller.signal),
        ]);

        if (!isMounted) return;

        setIsGatewayConnected(true);
        setGatewayMessage('真实成员通道已接通');
        setGroups(liveConversations.filter(c => c.kind === 'group'));
        setMemberCount(liveMembers.length);
        setGroupMembers(liveMembers);
        updateCharacters(liveMembers);

        // 真实融合：状态来自 /api/members，消息预览与时间来自 /api/conversations
        setCharacters((prev) =>
          CHARACTERS.map((c) => {
            const member = liveMembers.find((m) => m.agentId === c.id);
            const conv = liveConversations.find(
              (item) => item.kind === 'direct' && item.agentId === c.id
            );

            const isHuman = c.kind === 'human';
            const available = isHuman ? true : (member?.available ?? false);
            const statusNote = isHuman
              ? '创作者 / 本人'
              : (member?.status || (available ? '在线' : '离线'));

            const lastMessage = conv?.lastMessage || (conv ? '暂无消息' : '暂无历史会话');
            const lastTime = formatConversationTime(conv?.updatedAt);

            return {
              ...c,
              available,
              statusNote,
              lastMessage,
              lastTime,
            };
          })
        );
      } catch (err: unknown) {
        if (!isMounted) return;
        setIsGatewayConnected(false);
        const errMsg = err instanceof Error ? err.message : String(err);
        setGatewayMessage(errMsg || '等待桌面连接，点击重试');

        // 失败时不回退虚假数据，诚实显示离线/未连通
        setCharacters((prev) =>
          prev.map((c) => ({
            ...c,
            available: c.kind === 'human',
            statusNote: c.kind === 'human' ? '创作者 / 本人' : '通道未连通',
            lastMessage: '会话记录未同步',
            lastTime: '',
          }))
        );
      }
    }

    loadLiveSalonData();

    // 唤醒或重新连接网络时自动重新探测网关
    const handleResume = () => {
      if (document.visibilityState === 'visible') {
        loadLiveSalonData();
      }
    };
    document.addEventListener('visibilitychange', handleResume);
    window.addEventListener('online', loadLiveSalonData);

    return () => {
      isMounted = false;
      controller.abort();
      document.removeEventListener('visibilitychange', handleResume);
      window.removeEventListener('online', loadLiveSalonData);
    };
  }, [refreshTrigger]);

  // 严格过滤：删除使用者本人选项（不能给自己发消息），只保留 已配置 AI 成员
  const privateList = characters.filter(
    (c) =>
      c.kind !== 'human' &&
      (c.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        c.frenchRole.toLowerCase().includes(searchQuery.toLowerCase()) ||
        c.role.toLowerCase().includes(searchQuery.toLowerCase()))
  );

  const renderMemberCard = (char: Character) => {
    const isHuman = char.kind === 'human';
    const presence = isHuman ? 'human' : char.available ? 'online' : 'offline';
    // 接线状态（configured / native 等）不再显示在卡片上，留在悬停提示里方便排查
    const presenceTitle = [char.available ? '在线' : '离线', char.statusNote].filter(Boolean).join(' · ');

    return (
      <button
        key={char.id}
        type="button"
        onClick={() => onSelectCharacter(char.id)}
        className="salon-letter p-3 pl-3.5 flex items-center gap-3 cursor-pointer"
      >
        {/* 椭圆肖像小相框 */}
        <div className="relative shrink-0">
          {avatarMap[char.id] ? (
            <img src={avatarMap[char.id]} alt="" className="salon-cameo" />
          ) : (
            <div className="salon-cameo salon-cameo--initial" style={{ backgroundColor: char.signatureColor }} aria-hidden="true">
              {char.name.slice(0, 1)}
            </div>
          )}
          <span className="salon-presence" data-state={presence} title={presenceTitle} aria-label={presenceTitle} />
        </div>

        {/* 聊天内容与预览：完全由真实会话决定 */}
        <div className="relative flex-1 min-w-0">
          <div className="flex items-baseline justify-between gap-2">
            <div className="flex items-baseline gap-1.5 min-w-0">
              <span className="font-serif font-bold text-sm text-stone-900 tracking-wide shrink-0">
                {char.name}
              </span>
              <span className="font-calligraphy text-xs text-stone-600/85 truncate">
                {char.frenchRole}
              </span>
            </div>
            {char.lastTime ? (
              <span className="text-[10.5px] text-stone-500 font-serif italic shrink-0">
                {char.lastTime}
              </span>
            ) : null}
          </div>

          <div className="flex items-center justify-between gap-2 mt-1">
            <p className="text-xs text-stone-700/90 font-serif italic truncate flex-1">
              {char.lastMessage || '暂无历史会话'}
            </p>
            {/* 未读：一枚染成成员专属色的火漆印 */}
            {char.unreadCount && char.unreadCount > 0 ? (
              <span
                className="salon-seal"
                style={{ '--seal-color': char.signatureColor, '--seal-mask': SEAL_MASK } as React.CSSProperties}
                aria-label={`${char.unreadCount} 条未读`}
              >
                <span className="salon-seal-tint" aria-hidden="true" />
                <img src={SALON_ASSET('salon/seal-ivory')} alt="" className="salon-seal-art" aria-hidden="true" />
                <span className="salon-seal-count" aria-hidden="true">{char.unreadCount > 99 ? '99' : char.unreadCount}</span>
              </span>
            ) : null}
          </div>
        </div>
      </button>
    );
  };

  return (
    <div className="relative w-full h-full flex flex-col overflow-y-auto no-scrollbar select-none pb-28 text-stone-900 px-3">
      {/* 顶部标题：纯法语手写体 (Luma · 细语沙龙) */}
      <header
        className="relative z-10 pb-2 pt-safe-salon-header"
        style={{ paddingTop: 'calc(max(env(safe-area-inset-top, 0px), 16px) + 1rem)' }}
      >
        <div className="flex items-center justify-between">
          <div>
            <h1 className="font-calligraphy text-3xl sm:text-4xl text-stone-900 script-shadow tracking-wide leading-tight">
              Luma
            </h1>
            <p className="font-calligraphy text-base sm:text-lg text-stone-700/90 italic -mt-0.5">
              聊天与协作
            </p>
          </div>
          {onBackToHome && (
            <button
              onClick={onBackToHome}
              className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-[#fdf9f1]/80 active:scale-95 transition-transform text-stone-800 text-xs font-serif border border-[#c9a96a]/45 cursor-pointer shadow-xs"
              title="返回庭院主页"
            >
              <span>‹</span>
              <span className="font-calligraphy text-xs">返回</span>
            </button>
          )}
        </div>

        {/* 连接状态：平时不打扰，只在断开时出现，点一下重新探测 */}
        {isGatewayConnected === false && (
          <button
            type="button"
            onClick={() => setRefreshTrigger(n => n + 1)}
            className="mt-2.5 w-full px-3 py-1.5 rounded-lg bg-[#fdf9f1]/80 border border-[#c9a96a]/40 flex items-center justify-between gap-2 text-[11px] font-serif cursor-pointer active:scale-[.98] transition-transform"
            title="点击重新探测桌面连通状态"
            role="status"
          >
            <span className="flex items-center gap-1.5 text-amber-900">
              <WifiOff className="w-3.5 h-3.5 text-amber-700" aria-hidden="true" />
              桌面暂时没连上，点这里重试
            </span>
            <span className="text-[10px] text-stone-500 italic truncate max-w-[130px]">
              {gatewayMessage}
            </span>
          </button>
        )}
      </header>

      {/* 消息分区一：置顶群聊 (Le 群聊 · 6人群聊占位) */}
      <section className="relative z-10 pt-2">
        <div className="flex items-center justify-between mb-2 pl-0.5">
          <span className="font-calligraphy text-xl text-stone-850 script-shadow">
            Le 群聊
          </span>
          <span className="font-calligraphy text-xs text-amber-800/80 italic">
            置顶群聊 · {memberCount ? `${memberCount}人` : '等待连接'}
          </span>
        </div>

        {groups.map(group => <button
          key={group.conversationId}
          type="button"
          disabled={isGatewayConnected !== true}
          onClick={() => onSelectGroup(group)}
          className="salon-letter salon-letter--salon p-3.5 pl-3.5 flex items-center gap-3 cursor-pointer"
        >
          {/* 角上探出的睡莲 */}
          <img src={SALON_ASSET('pond/lily')} alt="" aria-hidden="true" draggable={false} className="salon-letter-lily" />

          {/* 四人组合群头像 */}
          <div className="relative shrink-0">
            <div className="w-12 h-12 rounded-[14px] bg-[#f7efe2] p-1 grid grid-cols-2 gap-0.5 items-center justify-items-center" style={{ boxShadow: '0 0 0 1.5px #fffaf0, 0 0 0 3px #c9a96a, 0 3px 8px -2px #5a463059' }}>
              {groupMembers.slice(0,4).map(member => <span key={member.agentId} title={member.displayName} className="w-[18px] h-[18px] rounded-full bg-stone-200 text-[8px] font-bold text-stone-900 flex items-center justify-center overflow-hidden">{avatarMap[member.agentId] || member.avatarDataUrl ? <img src={avatarMap[member.agentId] || member.avatarDataUrl} alt={member.displayName} className="w-full h-full object-cover" /> : member.displayName.slice(0,1)}</span>)}
            </div>
          </div>

          {/* 群聊描述 */}
          <div className="relative flex-1 min-w-0 pr-8">
            <div className="flex items-baseline gap-1.5 min-w-0">
              <span className="font-serif font-bold text-[15px] text-stone-900 tracking-wide shrink-0">
                {group.title}
              </span>
              <span className="font-calligraphy text-xs text-stone-600/85 truncate">
                群聊
              </span>
            </div>
            <p className="mt-1 text-xs text-amber-950/75 font-serif italic truncate">
              {group.lastMessage || '大家都在同一个客厅，来聊聊吧'}
            </p>
            <span className="block mt-1 text-[10.5px] text-amber-800/70 font-serif italic">
              置顶 · {formatConversationTime(group.updatedAt) || '客厅'}
            </span>
          </div>
        </button>)}
        {!groups.length && <p className="p-3 text-xs text-stone-600" role="status">{isGatewayConnected === true ? '桌面尚未提供客厅会话，请在桌面打开客厅后重试。' : '等待桌面连接后载入小屋客厅…'}</p>}
      </section>

      {/* 消息分区二：私聊全都放到下层 (私聊 · 私聊信笺) */}
      <section className="relative z-10 pt-4">
        <div className="flex items-center justify-between mb-2 pl-0.5">
          <span className="font-calligraphy text-xl text-stone-850 script-shadow">
            私聊
          </span>
          <span className="font-calligraphy text-xs text-stone-600/80 italic">
            私聊 · {privateList.length} 位成员
          </span>
        </div>

        <div className="space-y-2.5">
          {privateList.map(renderMemberCard)}
        </div>
        <img src={SALON_ASSET('pond/pad')} alt="" aria-hidden="true" draggable={false} className="salon-list-pad" />
      </section>
    </div>
  );
};
