import { useState } from 'react';
import { Hash, MessageSquare, Plus, Trash2, UserPlus, X, Sliders, BookOpen } from 'lucide-react';
import type { Store } from '../ui/useAppStore';
import type { ConfirmRequest } from './Overlays';
import { Avatar } from './Avatar';

export function SideNav({
  store,
  onRequestDelete,
  onOpenSettings,
  onOpenDiary,
  onOpenStudy,
  embedded = false,
}: {
  store: Store;
  onRequestDelete: (req: ConfirmRequest) => void;
  onOpenSettings?: (agentId?: string) => void;
  onOpenDiary?: () => void;
  onOpenStudy?: () => void;
  embedded?: boolean;
}) {
  const { data, dispatch } = store;
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');

  const living = data.conversations.filter((c) => c.kind === 'living-room');
  const direct = data.conversations.filter((c) => c.kind === 'direct' && !data.agents.find(a => a.id === c.agentId)?.removed);
  const agentsById = new Map(data.agents.map((a) => [a.id, a]));

  const countFor = (conversationId: string) => data.messages.filter((m) => m.conversationId === conversationId).length;

  const submitAgent = () => {
    if (!name.trim()) return;
    dispatch({ type: 'addAgent', name });
    setName('');
    setAdding(false);
  };

  return (
    <nav className={`panel nav ${embedded ? 'nav--embedded' : ''}`} aria-label="空间导航">
      <div className="nav__section">
        <p className="nav__label">空间</p>
        {living.map((c) => (
          <NavItem
            key={c.id}
            active={data.activeConversationId === c.id}
            icon={<Hash size={15} aria-hidden />}
            title={c.title}
            meta={`${countFor(c.id)} 条`}
            onClick={() => dispatch({ type: 'selectConversation', conversationId: c.id })}
          />
        ))}
        {onOpenDiary && (
          <NavItem
            active={false}
            icon={<BookOpen size={15} aria-hidden />}
            title="日记馆"
            meta="手记"
            onClick={onOpenDiary}
          />
        )}
        {onOpenStudy && (
          <NavItem
            active={false}
            icon={<BookOpen size={15} aria-hidden />}
            title="书房"
            meta="接力"
            onClick={onOpenStudy}
          />
        )}
      </div>

      <div className="nav__section">
        <p className="nav__label">私聊 · {direct.length}</p>
        {direct.map((c) => {
          const agent = c.agentId ? agentsById.get(c.agentId) : undefined;
          return (
            <div key={c.id} style={{ display: 'flex', alignItems: 'stretch', gap: 2 }}>
              <NavItem
                active={data.activeConversationId === c.id}
                icon={<Avatar agent={agent} />}
                title={c.title}
                meta={`${countFor(c.id)} 条`}
                statusDot={agent?.mode === 'real' ? (agent.connected ? 'live' : 'demo') : 'demo'}
                onClick={() => dispatch({ type: 'selectConversation', conversationId: c.id })}
              />
              {onOpenSettings && agent?.kind === 'ai' && (
                <button
                  className="btn btn--icon btn--ghost"
                  style={{ minHeight: 38 }}
                  title={`配置「${c.title}」接口与人格`}
                  aria-label={`配置「${c.title}」接口与人格`}
                  onClick={() => onOpenSettings(agent.id)}
                >
                  <Sliders size={13} aria-hidden />
                </button>
              )}
              <button
                className="btn btn--icon btn--ghost btn--danger desktop-only"
                style={{ minHeight: 38 }}
                title={`移除成员「${c.title}」`}
                aria-label={`移除成员「${c.title}」`}
                disabled={!store.ready || (!!store.streamingMessageId || data.messages.some(m => m.status === 'streaming')) || agent?.kind !== 'ai'}
                onClick={() =>
                  onRequestDelete({
                    title: `移除成员「${c.title}」？`,
                    body: '仅从小屋成员列表与私聊入口移除，聊天、草稿、记忆、头像和接口配置都保留在本地，可在成员设置中恢复。',
                    confirmLabel: '移除成员',
                    danger: true,
                    onConfirm: () => agent && dispatch({ type: 'setAgentRemoved', agentId: agent.id, removed: true }),
                  })
                }
              >
                <Trash2 size={14} aria-hidden />
              </button>
            </div>
          );
        })}
        {onOpenSettings && (
          <button className="nav__item" onClick={() => onOpenSettings()} title="打开接口与连接设置">
            <Sliders size={15} aria-hidden />
            <span className="nav__text">成员与接口连接设置</span>
          </button>
        )}
        <button className="nav__item" onClick={() => setAdding((v) => !v)} aria-expanded={adding}>
          <UserPlus size={15} aria-hidden />
          <span className="nav__text">新增 AI 成员</span>
        </button>
        {adding && (
          <div style={{ display: 'flex', gap: 6, padding: '6px 4px' }}>
            <input
              className="input"
              value={name}
              autoFocus
              placeholder="成员名字"
              maxLength={16}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submitAgent();
                if (e.key === 'Escape') setAdding(false);
              }}
            />
            <button className="btn btn--icon" onClick={submitAgent} aria-label="添加成员" disabled={!name.trim()}>
              <Plus size={15} aria-hidden />
            </button>
            <button className="btn btn--icon" onClick={() => setAdding(false)} aria-label="取消">
              <X size={15} aria-hidden />
            </button>
          </div>
        )}
      </div>

      <div className="nav__section" style={{ marginTop: 'auto' }}>
        <p className="nav__label">接入状态</p>
        <div className="demo-banner" style={{ margin: '4px 8px' }}>
          {(() => {
            const aiAgents = data.agents.filter((a) => a.kind === 'ai' && !a.removed);
            const liveCount = aiAgents.filter((a) => a.mode === 'real' && a.connected).length;
            const realCount = aiAgents.filter((a) => a.mode === 'real').length;
            if (liveCount > 0) {
              return `已连接 ${liveCount} 位成员服务（共 ${aiAgents.length} 位）`;
            }
            if (realCount > 0) {
              return `已配置 ${realCount} 位成员接口 · 待连接客户端（私聊可正常使用）`;
            }
            return `当前为本地模式：${aiAgents.length} 位 AI 成员可正常私聊与交流。`;
          })()}
        </div>
      </div>
    </nav>
  );
}

function NavItem({
  active,
  icon,
  title,
  meta,
  onClick,
  statusDot,
}: {
  active: boolean;
  icon: React.ReactNode;
  title: string;
  meta?: string;
  onClick: () => void;
  statusDot?: 'demo' | 'live';
}) {
  return (
    <button className="nav__item" aria-current={active} onClick={onClick} title={title}>
      {icon}
      <span className="nav__text">{title}</span>
      {statusDot && <span className={`dot dot--${statusDot}`} title={statusDot === 'live' ? '已连接' : '未连接（演示）'} />}
      {meta && <span className="nav__meta">{meta}</span>}
    </button>
  );
}

export function ConversationIcon() {
  return <MessageSquare size={15} aria-hidden />;
}
