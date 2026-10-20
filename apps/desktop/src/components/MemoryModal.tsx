import { useState, useEffect } from 'react';
import {
  BookOpen,
  Plus,
  Trash2,
  X,
  Search,
  Sparkles,
  CloudOff,
  Cloud,
  Edit2,
  Check,
  RefreshCw,
  AlertTriangle,
  GitMerge,
} from 'lucide-react';
import type { AppStore } from '../ui/useAppStore';
import type { MemoryItem, Conversation, Agent, ContextCheckpoint } from '../types';

interface MemoryModalProps {
  store: AppStore;
  conversationId?: string;
  onClose: () => void;
}

export { extractConversationFacts } from '../store/memoryManager';
import { extractConversationFacts } from '../store/memoryManager';


export function MemoryModal({ store, conversationId: initialConversationId, onClose }: MemoryModalProps) {
  const { data, saveMemory, tombstoneMemory, saveCheckpoint } = store;
  const conversationId = initialConversationId || data.activeConversationId || data.conversations[0]?.id || 'conv_living_room';
  const conversation = data.conversations.find((c: Conversation) => c.id === conversationId);
  const isDirect = conversation?.kind === 'direct';
  const targetAgent = isDirect ? data.agents.find((a: Agent) => a.id === conversation.agentId) : null;

  const [searchQuery, setSearchQuery] = useState('');
  const [isAdding, setIsAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  // 表单状态
  const [editTitle, setEditTitle] = useState('');
  const [editContent, setEditContent] = useState('');

  const [statusMsg, setStatusMsg] = useState<string | null>(null);

  // CloudSync 同步与冲突解决状态
  const [cloudSyncStatus, setCloudSyncStatus] = useState<{
    enabled: boolean;
    status: string;
    lastSyncTime?: number;
    error?: string;
  }>({
    enabled: !!data.cloudSyncConfig?.enabled,
    status: data.cloudSyncConfig?.enabled ? 'idle' : 'disabled',
  });
  const [isManualSyncing, setIsManualSyncing] = useState(false);
  const [resolvingMergeId, setResolvingMergeId] = useState<string | null>(null);
  const [mergeContent, setMergeContent] = useState<string>('');

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  // 监听 CloudSync 同步状态
  useEffect(() => {
    const bridge = typeof window !== 'undefined' ? (window.xiaowu || window.xiaowuDesktop) : undefined;
    if (!bridge?.cloudSync) return;

    bridge.cloudSync.getStatus().then((st: any) => {
      if (st) {
        setCloudSyncStatus({
          enabled: st.enabled ?? false,
          status: st.status ?? 'idle',
          lastSyncTime: st.lastSyncTime,
          error: st.error || st.lastError,
        });
      }
    }).catch(() => {});

    const unlisten = bridge.cloudSync.onSyncState?.((st: any) => {
      if (st) {
        setCloudSyncStatus((prev) => ({
          ...prev,
          enabled: st.enabled ?? prev.enabled,
          status: st.status ?? prev.status,
          lastSyncTime: st.lastSyncTime ?? prev.lastSyncTime,
          error: st.error || st.lastError,
        }));
      }
    });

    return () => {
      if (unlisten) unlisten();
    };
  }, []);

  const [showLoginForm, setShowLoginForm] = useState(false);
  const [loginEmail, setLoginEmail] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [loginHomeId, setLoginHomeId] = useState('home_synth_r3_test');
  const [isLoggingIn, setIsLoggingIn] = useState(false);

  const handleLogin = async () => {
    const bridge = typeof window !== 'undefined' ? (window.xiaowu || window.xiaowuDesktop) : undefined;
    if (!bridge?.cloudSync?.login) {
      setStatusMsg('当前环境不支持登录');
      return;
    }
    if (!loginEmail || !loginPassword) {
      setStatusMsg('请输入邮箱和密码');
      return;
    }
    setIsLoggingIn(true);
    try {
      const res = await bridge.cloudSync.login({
        email: loginEmail,
        password: loginPassword,
        homeId: loginHomeId || 'home_default',
      });
      if (res && res.ok === false) {
        setStatusMsg(`登录失败: ${res.error || '凭据错误'}`);
      } else {
        setStatusMsg('小屋云端已成功连接');
        setShowLoginForm(false);
      }
    } catch (err: any) {
      setStatusMsg(`登录异常: ${err?.message || err}`);
    } finally {
      setIsLoggingIn(false);
      setTimeout(() => setStatusMsg(null), 3000);
    }
  };

  const handleLogout = async () => {
    const bridge = typeof window !== 'undefined' ? (window.xiaowu || window.xiaowuDesktop) : undefined;
    if (!bridge?.cloudSync?.logout) return;
    try {
      await bridge.cloudSync.logout();
      setStatusMsg('已断开云端连接');
      setCloudSyncStatus({ enabled: false, status: 'disconnected' });
    } catch (err: any) {
      setStatusMsg(`断开异常: ${err?.message || err}`);
    } finally {
      setTimeout(() => setStatusMsg(null), 3000);
    }
  };

  const handleManualSync = async () => {
    const bridge = typeof window !== 'undefined' ? (window.xiaowu || window.xiaowuDesktop) : undefined;
    if (!bridge?.cloudSync?.syncNow) {
      setStatusMsg('当前环境不支持云端同步');
      return;
    }
    setIsManualSyncing(true);
    try {
      const res = await bridge.cloudSync.syncNow();
      if (res && res.ok === false) {
        setStatusMsg(`同步失败: ${res.error || '网络或凭据异常'}`);
      } else {
        setStatusMsg('云端同步已完成');
      }
    } catch (err: any) {
      setStatusMsg(`同步异常: ${err?.message || err}`);
    } finally {
      setIsManualSyncing(false);
      setTimeout(() => setStatusMsg(null), 3000);
    }
  };

  const handleResolveConflict = async (
    memoryId: string,
    choice: 'keep_local' | 'keep_remote' | 'merge',
    resolvedContent?: string
  ) => {
    const bridge = typeof window !== 'undefined' ? (window.xiaowu || window.xiaowuDesktop) : undefined;
    if (!bridge?.memory?.resolveConflict) {
      setStatusMsg('当前环境不支持冲突裁决');
      return;
    }
    const mem = (data.memories ?? []).find((m: MemoryItem) => m.id === memoryId);
    const seenRemoteRev = mem?.conflict?.remoteVersion ?? mem?.version ?? 1;

    try {
      const res = await bridge.memory.resolveConflict({
        memoryId,
        choice,
        seenRemoteRevision: seenRemoteRev,
        resolvedContent: choice === 'merge' ? resolvedContent : undefined,
      });
      if (res?.ok) {
        const choiceLabel = choice === 'keep_local' ? '保留本地' : choice === 'keep_remote' ? '采纳云端' : '已合并版本';
        setStatusMsg(`冲突已成功解决 (${choiceLabel})`);
        setResolvingMergeId(null);
        if (choice === 'keep_remote' && mem?.conflict?.remoteContent) {
          saveMemory({
            ...mem,
            content: mem.conflict.remoteContent,
            conflict: undefined,
          });
        } else if (choice === 'merge' && resolvedContent && mem) {
          saveMemory({
            ...mem,
            content: resolvedContent,
            conflict: undefined,
          });
        } else if (choice === 'keep_local' && mem) {
          saveMemory({
            ...mem,
            conflict: undefined,
          });
        }
      } else {
        setStatusMsg(`裁决失败: ${res?.error || '未知错误'}`);
      }
    } catch (err: any) {
      setStatusMsg(`裁决异常: ${err?.message || err}`);
    } finally {
      setTimeout(() => setStatusMsg(null), 3000);
    }
  };

  // 授权记忆筛选
  const memories = (data.memories ?? []).filter((m: MemoryItem) => {
    if (m.tombstoned) return false;
    if (isDirect) {
      return m.scope.type === 'direct' && m.scope.id === targetAgent?.id;
    } else {
      return m.scope.type === 'living-room';
    }
  });

  const filteredMemories = memories.filter((m: MemoryItem) => {
    if (!searchQuery.trim()) return true;
    const q = searchQuery.toLowerCase();
    return (m.title?.toLowerCase().includes(q) || false) || m.content.toLowerCase().includes(q);
  });

  // 保存新增或编辑的记忆
  const handleSaveMemory = () => {
    if (!editContent.trim()) {
      setStatusMsg('请填写记忆具体内容');
      return;
    }

    const now = Date.now();
    if (editingId) {
      const existing = memories.find((m: MemoryItem) => m.id === editingId);
      if (existing) {
        saveMemory({
          ...existing,
          title: editTitle.trim() || undefined,
          content: editContent.trim(),
          updatedAt: now,
        });
        setStatusMsg('记忆条目已更新');
      }
      setEditingId(null);
    } else {
      const item: MemoryItem = {
        id: `mem_${now.toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
        scope: isDirect && targetAgent ? { type: 'direct', id: targetAgent.id } : { type: 'living-room' },
        authorAgentId: 'agent_owner',
        title: editTitle.trim() || undefined,
        content: editContent.trim(),
        createdAt: now,
        updatedAt: now,
        pinned: false,
      };
      saveMemory(item);
      setStatusMsg('新记忆已保存并纳入上下文检索');
    }

    setEditTitle('');
    setEditContent('');
    setIsAdding(false);
    setTimeout(() => setStatusMsg(null), 3000);
  };

  const startEdit = (m: MemoryItem) => {
    setEditingId(m.id);
    setEditTitle(m.title || '');
    setEditContent(m.content);
    setIsAdding(false);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setIsAdding(false);
    setEditTitle('');
    setEditContent('');
  };

  // 生成当前会话真实结构化检查点
  const handleCreateCheckpoint = () => {
    const messages = data.messages.filter((m) => m.conversationId === conversationId && m.status === 'sent');
    if (messages.length < 2) {
      setStatusMsg('当前会话消息较少，无需折叠检查点');
      return;
    }

    const lastMsg = messages[messages.length - 1];
    if (!lastMsg) return;

    const summary = extractConversationFacts(messages, targetAgent?.name || '编辑助手', isDirect);

    saveCheckpoint({
      id: `cp_${Date.now().toString(36)}`,
      conversationId,
      createdBeforeMessageId: lastMsg.id,
      summary,
      createdAt: Date.now(),
    });

    setStatusMsg('已生成真实结构化检查点（包含双方事实与区间，旧原话按摘要高效承接）');
    setTimeout(() => setStatusMsg(null), 3000);
  };

  // 会话检查点
  const checkpoints = (data.checkpoints ?? []).filter((c: ContextCheckpoint) => c.conversationId === conversationId);
  const latestCheckpoint = checkpoints.length > 0 ? checkpoints[checkpoints.length - 1] : null;

  return (
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <div
        className="modal modal--settings"
        style={{
          maxWidth: 640,
          width: '92vw',
          maxHeight: '88vh',
          overflowY: 'auto',
          color: 'var(--ink)',
        }}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-labelledby="memory-modal-title"
        aria-modal="true"
      >
        <div className="modal__head">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <BookOpen size={18} style={{ color: 'var(--accent)' }} aria-hidden />
            <h2 id="memory-modal-title" className="modal__title" style={{ color: 'var(--ink)' }}>
              {isDirect ? `${targetAgent?.name ?? '成员'} · 长时记忆与检查点` : '客厅 · 共享记忆与检查点'}
            </h2>
          </div>
          <button className="btn btn--icon" onClick={onClose} aria-label="关闭">
            <X size={16} aria-hidden />
          </button>
        </div>

        <div style={{ padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 16 }}>
          {/* 状态与隔离提示 */}
          <div
            style={{
              background: 'var(--panel-sub-bg, rgba(0,0,0,0.04))',
              border: '1px solid var(--line)',
              padding: '10px 14px',
              borderRadius: 8,
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              fontSize: 12,
              color: 'var(--ink-2)',
            }}
          >
            <div>
              <strong style={{ color: 'var(--ink)' }}>当前授权范围：</strong>
              {isDirect ? `私聊专属 (${targetAgent?.name}) · 授权空间隔离` : '客厅共享 · 私聊记忆不入'}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 4, color: 'var(--ink-3)' }}>
              {data.memoryGatewayConfig?.enabled ? (
                <span style={{ display: 'flex', alignItems: 'center', gap: 4, color: 'var(--accent)' }}>
                  <Cloud size={13} />
                  <span>MemoryGateway 已启用（受限本地验证）</span>
                </span>
              ) : (
                <span style={{ display: 'flex', alignItems: 'center', gap: 4, color: 'var(--ink-3)' }}>
                  <CloudOff size={13} />
                  <span>本地记忆模式（MemoryGateway 云端未连接）</span>
                </span>
              )}
            </div>
          </div>

          {/* CloudSync 云端同步状态、登录与手动同步 */}
          <div
            style={{
              background: 'var(--panel-sub-bg, rgba(0,0,0,0.03))',
              border: '1px solid var(--line)',
              padding: '10px 14px',
              borderRadius: 8,
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
              fontSize: 12,
            }}
          >
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                flexWrap: 'wrap',
                gap: 8,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                <Cloud
                  size={14}
                  style={{
                    color:
                      cloudSyncStatus.enabled && (cloudSyncStatus.status === 'synced' || cloudSyncStatus.status === 'idle')
                        ? 'var(--accent)'
                        : 'var(--ink-3)',
                  }}
                />
                <span style={{ fontWeight: 600, color: 'var(--ink)' }}>CloudSync 云端同步：</span>
                <span
                  style={{
                    color: !cloudSyncStatus.enabled
                      ? 'var(--ink-3)'
                      : cloudSyncStatus.status === 'syncing' || isManualSyncing
                      ? '#2563eb'
                      : cloudSyncStatus.status === 'error'
                      ? '#dc2626'
                      : cloudSyncStatus.status === 'offline'
                      ? '#6b7280'
                      : cloudSyncStatus.status === 'conflict'
                      ? '#d97706'
                      : '#16a34a',
                  }}
                >
                  {cloudSyncStatus.status === 'syncing' || isManualSyncing
                    ? '正在同步...'
                    : !cloudSyncStatus.enabled
                    ? '未连接'
                    : cloudSyncStatus.status === 'error'
                    ? `同步失败: ${cloudSyncStatus.error || '异常'}`
                    : cloudSyncStatus.status === 'offline'
                    ? `离线模式: ${cloudSyncStatus.error || '网络不可用'}`
                    : cloudSyncStatus.status === 'conflict'
                    ? '存在版本冲突待裁决'
                    : cloudSyncStatus.status === 'synced' || cloudSyncStatus.status === 'idle'
                    ? '已连接 (已同步)'
                    : '就绪'}
                </span>
                {cloudSyncStatus.enabled && cloudSyncStatus.lastSyncTime && (
                  <span style={{ color: 'var(--ink-3)', fontSize: 11 }}>
                    (上次: {new Date(cloudSyncStatus.lastSyncTime).toLocaleTimeString()})
                  </span>
                )}
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                {!cloudSyncStatus.enabled ? (
                  <button
                    className="btn btn--secondary"
                    style={{ fontSize: 12, padding: '2px 10px', height: 26 }}
                    onClick={() => setShowLoginForm((prev) => !prev)}
                  >
                    {showLoginForm ? '取消' : '连接云端'}
                  </button>
                ) : (
                  <>
                    <button
                      className="btn btn--ghost"
                      style={{
                        fontSize: 12,
                        padding: '2px 10px',
                        height: 26,
                        display: 'flex',
                        alignItems: 'center',
                        gap: 4,
                        color: 'var(--ink)',
                      }}
                      disabled={isManualSyncing}
                      onClick={handleManualSync}
                      title="立即向 CloudSync 同步"
                    >
                      <RefreshCw size={12} className={isManualSyncing ? 'spin' : ''} />
                      <span>{isManualSyncing ? '同步中...' : '立即同步'}</span>
                    </button>
                    <button
                      className="btn btn--ghost"
                      style={{
                        fontSize: 12,
                        padding: '2px 8px',
                        height: 26,
                        color: 'var(--ink-3)',
                      }}
                      onClick={handleLogout}
                      title="断开云端连接"
                    >
                      断开
                    </button>
                  </>
                )}
              </div>
            </div>

            {/* 失败与离线提示横幅 */}
            {cloudSyncStatus.status === 'error' && cloudSyncStatus.error && (
              <div
                style={{
                  background: 'rgba(239, 68, 68, 0.08)',
                  border: '1px solid rgba(239, 68, 68, 0.3)',
                  borderRadius: 6,
                  padding: '6px 10px',
                  color: '#b91c1c',
                  fontSize: 12,
                }}
              >
                <strong>失败原因：</strong>{cloudSyncStatus.error}
              </div>
            )}
            {cloudSyncStatus.status === 'offline' && (
              <div
                style={{
                  background: 'rgba(107, 114, 128, 0.08)',
                  border: '1px solid rgba(107, 114, 128, 0.3)',
                  borderRadius: 6,
                  padding: '6px 10px',
                  color: '#4b5563',
                  fontSize: 12,
                }}
              >
                <strong>离线说明：</strong>{cloudSyncStatus.error || '当前网络断开，变更已保存在本地队列，恢复后自动同步'}
              </div>
            )}

            {/* 未连接时的登录表单 */}
            {!cloudSyncStatus.enabled && showLoginForm && (
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 8,
                  paddingTop: 8,
                  borderTop: '1px dashed var(--line)',
                }}
              >
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <input
                    type="email"
                    placeholder="账号邮箱"
                    className="input"
                    value={loginEmail}
                    onChange={(e) => setLoginEmail(e.target.value)}
                    style={{ flex: 1, minWidth: 160, fontSize: 12, height: 28, padding: '0 8px' }}
                  />
                  <input
                    type="password"
                    placeholder="密码"
                    className="input"
                    value={loginPassword}
                    onChange={(e) => setLoginPassword(e.target.value)}
                    style={{ flex: 1, minWidth: 140, fontSize: 12, height: 28, padding: '0 8px' }}
                  />
                  <input
                    type="text"
                    placeholder="家庭/小屋ID"
                    className="input"
                    value={loginHomeId}
                    onChange={(e) => setLoginHomeId(e.target.value)}
                    style={{ width: 140, fontSize: 12, height: 28, padding: '0 8px' }}
                  />
                </div>
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                  <button
                    className="btn btn--primary"
                    style={{ fontSize: 12, padding: '3px 14px', height: 28 }}
                    disabled={isLoggingIn}
                    onClick={handleLogin}
                  >
                    {isLoggingIn ? '登录中...' : '登录并绑定'}
                  </button>
                </div>
              </div>
            )}
          </div>

          {statusMsg && (
            <div
              style={{
                padding: '8px 12px',
                background: 'var(--accent-glow, rgba(160,120,90,0.15))',
                borderRadius: 6,
                fontSize: 13,
                color: 'var(--ink)',
                border: '1px solid var(--accent)',
              }}
            >
              {statusMsg}
            </div>
          )}

          {/* 检查点展示与折叠 */}
          <div
            style={{
              border: '1px solid var(--line)',
              borderRadius: 8,
              padding: '12px 14px',
              background: 'var(--panel-sub-bg, rgba(0,0,0,0.03))',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink)' }}>上下文检查点 (Checkpoint)</span>
              <button
                className="btn btn--ghost"
                style={{ fontSize: 12, padding: '2px 8px', minHeight: 26, color: 'var(--ink)' }}
                onClick={handleCreateCheckpoint}
              >
                <Sparkles size={12} style={{ marginRight: 4, color: 'var(--accent)' }} />
                从当前事实提炼检查点
              </button>
            </div>
            <div style={{ margin: 0, fontSize: 12, color: 'var(--ink-2)', whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>
              {latestCheckpoint ? latestCheckpoint.summary : '暂无检查点。生成检查点后，旧消息将折叠为事实摘要承接上下文，原始原话全量保留。'}
            </div>
          </div>

          {/* 记忆检索与列表 */}
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, maxWidth: 320 }}>
                <div style={{ position: 'relative', width: '100%' }}>
                  <Search size={14} style={{ position: 'absolute', left: 10, top: 10, color: 'var(--ink-3)' }} />
                  <input
                    className="input"
                    style={{ paddingLeft: 30, height: 32, fontSize: 13, color: 'var(--ink)' }}
                    placeholder="搜索相关长时记忆..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                  />
                </div>
              </div>
              {!isAdding && !editingId && (
                <button
                  className="btn btn--primary"
                  style={{ fontSize: 13, height: 32, padding: '0 12px' }}
                  onClick={() => {
                    setIsAdding(true);
                    setEditTitle('');
                    setEditContent('');
                  }}
                >
                  <Plus size={14} style={{ marginRight: 4 }} />
                  记录一件事
                </button>
              )}
            </div>

            {/* 新增或编辑表单 */}
            {(isAdding || editingId) && (
              <div
                style={{
                  border: '1px solid var(--accent)',
                  borderRadius: 8,
                  padding: 12,
                  marginBottom: 12,
                  background: 'var(--panel-sub-bg, rgba(0,0,0,0.03))',
                }}
              >
                <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--ink)', marginBottom: 8 }}>
                  {editingId ? '编辑长时记忆' : '新增长时记忆'}
                </div>
                <input
                  className="input"
                  style={{ marginBottom: 8, color: 'var(--ink)' }}
                  placeholder="记忆标签或简要标题（可选）"
                  value={editTitle}
                  onChange={(e) => setEditTitle(e.target.value)}
                />
                <textarea
                  className="textarea"
                  style={{ minHeight: 64, marginBottom: 8, color: 'var(--ink)' }}
                  placeholder="具体希望长久记住的内容事实..."
                  value={editContent}
                  onChange={(e) => setEditContent(e.target.value)}
                />
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                  <button className="btn btn--ghost" style={{ color: 'var(--ink-2)' }} onClick={cancelEdit}>
                    取消
                  </button>
                  <button className="btn btn--primary" onClick={handleSaveMemory}>
                    <Check size={14} style={{ marginRight: 4 }} />
                    {editingId ? '更新记忆' : '保存记忆'}
                  </button>
                </div>
              </div>
            )}

            {/* 记忆条目列表 */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {filteredMemories.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '24px 0', color: 'var(--ink-3)', fontSize: 13 }}>
                  暂无匹配的长时记忆条目
                </div>
              ) : (
                filteredMemories.map((m: MemoryItem) => (
                  <div
                    key={m.id}
                    style={{
                      border: '1px solid var(--line)',
                      borderRadius: 6,
                      padding: '10px 12px',
                      background: 'var(--panel, rgba(0,0,0,0.02))',
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'flex-start',
                      gap: 12,
                    }}
                  >
                    <div style={{ flex: 1 }}>
                      {m.title && <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink)', marginBottom: 4 }}>{m.title}</div>}
                      <div style={{ fontSize: 13, color: 'var(--ink)', whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>
                        {m.content}
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--ink-3)', marginTop: 6 }}>
                        记录于 {new Date(m.createdAt).toLocaleDateString()} {m.updatedAt && m.updatedAt !== m.createdAt ? ' (已编辑)' : ''}
                      </div>

                      {/* 冲突裁决控制面板 */}
                      {m.conflict && (
                        <div
                          style={{
                            marginTop: 8,
                            padding: 10,
                            background: 'rgba(234, 179, 8, 0.08)',
                            border: '1px solid rgba(234, 179, 8, 0.4)',
                            borderRadius: 6,
                            fontSize: 12,
                          }}
                        >
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#b45309', fontWeight: 600, marginBottom: 6 }}>
                            <AlertTriangle size={14} />
                            <span>检测到云端与本地版本冲突（远端版本: v{m.conflict.remoteVersion ?? 1}）</span>
                          </div>
                          {m.conflict.remoteContent && (
                            <div style={{ marginBottom: 8, background: 'var(--panel-sub-bg, rgba(255,255,255,0.7))', padding: '6px 8px', borderRadius: 4, color: 'var(--ink)' }}>
                              <div style={{ fontSize: 11, color: 'var(--ink-3)', marginBottom: 2 }}>云端版本内容：</div>
                              <div style={{ whiteSpace: 'pre-wrap' }}>{m.conflict.remoteContent}</div>
                            </div>
                          )}
                          {resolvingMergeId === m.id ? (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 6 }}>
                              <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--ink)' }}>编辑合并内容：</div>
                              <textarea
                                className="textarea"
                                style={{ minHeight: 60, fontSize: 12, color: 'var(--ink)' }}
                                value={mergeContent}
                                onChange={(e) => setMergeContent(e.target.value)}
                                placeholder="编辑合并后的最终内容..."
                              />
                              <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                                <button className="btn btn--ghost" style={{ fontSize: 12, padding: '2px 8px' }} onClick={() => setResolvingMergeId(null)}>
                                  取消
                                </button>
                                <button className="btn btn--primary" style={{ fontSize: 12, padding: '2px 8px' }} onClick={() => handleResolveConflict(m.id, 'merge', mergeContent)}>
                                  确认合并
                                </button>
                              </div>
                            </div>
                          ) : (
                            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
                              <button
                                className="btn btn--secondary"
                                style={{ fontSize: 11, padding: '2px 8px', height: 26 }}
                                onClick={() => handleResolveConflict(m.id, 'keep_local')}
                              >
                                保留本地
                              </button>
                              <button
                                className="btn btn--secondary"
                                style={{ fontSize: 11, padding: '2px 8px', height: 26 }}
                                onClick={() => handleResolveConflict(m.id, 'keep_remote')}
                              >
                                采纳云端
                              </button>
                              <button
                                className="btn btn--secondary"
                                style={{ fontSize: 11, padding: '2px 8px', height: 26 }}
                                onClick={() => {
                                  setResolvingMergeId(m.id);
                                  setMergeContent(`${m.content}\n\n${m.conflict?.remoteContent || ''}`.trim());
                                }}
                              >
                                <GitMerge size={12} style={{ marginRight: 3 }} />
                                合并版本
                              </button>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                      <button
                        className="btn btn--icon btn--ghost"
                        style={{ color: 'var(--ink-2)', padding: 4 }}
                        onClick={() => startEdit(m)}
                        title="编辑此记忆"
                        aria-label="编辑此记忆"
                      >
                        <Edit2 size={14} />
                      </button>
                      <button
                        className="btn btn--icon btn--ghost"
                        style={{ color: 'var(--ink-3)', padding: 4 }}
                        onClick={() => tombstoneMemory(m.id)}
                        title="删除此记忆"
                        aria-label="删除此记忆"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
