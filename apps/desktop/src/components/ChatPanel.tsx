import React, { useState, useEffect, useLayoutEffect, useRef } from 'react';
import { Avatar } from './Avatar';
import { AttachmentCards } from './AttachmentCards';
import { ATTACHMENT_ACCEPT, importAttachment } from '../utils/attachments';
import { livingRoomResponder, isAvailableAI } from '../utils/activeAgents';
import {
  CornerDownLeft,
  Square,
  Send,
  RotateCcw,
  Info,
  BookOpen,
  Copy,
  Check,
  CheckSquare,
  Trash2,
  EyeOff,
  Eye,
  X,
  AlertTriangle,
  Paperclip,
} from 'lucide-react';
import type { Store } from '../ui/useAppStore';
import type { BridgeSnapshot } from './BridgeControls';
import { DEFAULT_READING_PREFERENCES, type Message } from '../types';
import { getBeijingTime } from '../utils/timeBeijing';
import { FONT_STACK_MAP } from './ReadingSettingsPanel';
import channelRules from '../../electron/chatChannels.cjs';
import replyRules from '../../electron/chatReplies.cjs';

export function ChatPanel({
  store,
  onOpenMemory,
}: {
  store: Store;
  onOpenMemory?: () => void;
}) {
  const { data, dispatch, send, stop } = store;
  const [awayAgentId,setAwayAgentId]=useState<string|null>(null);
  useEffect(()=>{
    const api=window.xiaowuDesktop?.autonomy;if(!api)return;let live=true;
    const update=()=>api.presence().then(p=>{if(live)setAwayAgentId(p.running);}).catch(()=>{});
    void update();const timer=setInterval(update,5000);return()=>{live=false;clearInterval(timer);};
  },[]);
  const [clientRoutes, setClientRoutes] = useState<BridgeSnapshot['registrations']>([]);
  useEffect(() => {
    const bridge = window.xiaowuDesktop?.bridge;
    if (!bridge || !store.ready) return;
    let active = true;
    const receive = (snapshot: BridgeSnapshot) => { if (active) setClientRoutes(snapshot.registrations); };
    void bridge.snapshot().then(receive).catch(() => {});
    const unbind = bridge.onChanged(receive);
    return () => { active = false; unbind(); };
  }, [store.ready]);
  const conversationId = data.activeConversationId;
  const conversation = data.conversations.find((c) => c.id === conversationId);
  const [channel, setChannel] = useState<'luma'|'xiaodu'>('luma');
  const hasChannels=conversation?.kind==='direct'&&conversation.agentId==='agent_coordinator';

  // 消息分流：可见消息 vs 窗口已隐藏消息
  const conversationMessages = data.messages.filter((m) => m.conversationId === conversationId);
  const replyModes = replyRules.replyModes(conversationMessages);
  const channelMap=channelRules.classify(conversationMessages);
  const allMessages = conversationMessages.filter(m=>!hasChannels||channelMap.get(m.id)?.channel===channel);
  const messages = allMessages.filter((m) => !m.hiddenFromWindow&&!(m.agentId===awayAgentId&&m.status==='streaming'&&!m.text));
  const hiddenMessages = allMessages.filter((m) => m.hiddenFromWindow);

  const draft = data.drafts[conversationId] ?? '';
  const attachmentDrafts = data.attachmentDrafts?.[conversationId] ?? [];
  const fileInputRef = useRef<HTMLInputElement>(null);
  const importBusyRef = useRef(false);
  const [addingAttachments, setAddingAttachments] = useState(false);
  const [attachmentErrors, setAttachmentErrors] = useState<Record<string, string>>({});
  const addFiles = async (files: File[]) => {
    if (importBusyRef.current) return;
    const destination = conversationId;
    let count = attachmentDrafts.length;
    importBusyRef.current = true; setAddingAttachments(true);
    setAttachmentErrors(prev => ({ ...prev, [destination]: '' }));
    try {
      for (const file of files) {
        if (count >= 4) throw Error('每条消息最多添加 4 个附件');
        const attachment = await importAttachment(file);
        dispatch({ type: 'addAttachmentDraft', conversationId: destination, attachment }); count++;
      }
    } catch (error) {
      setAttachmentErrors(prev => ({ ...prev, [destination]: error instanceof Error ? error.message : '附件保存失败' }));
    } finally { importBusyRef.current = false; setAddingAttachments(false); }
  };
  const roundHere = store.allReplyRound?.conversationId === conversationId ? store.allReplyRound : null;
  const allSelected = conversation?.kind === 'living-room' && store.livingRoomAll;
  const isStreamingHere = store.streamingConversationId === conversationId || !!roundHere;
  const streamingId = store.streamingMessageId;

  const logRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const composingRef = useRef(false);

  // 多选与删除状态
  const [isSelecting, setIsSelecting] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [showHiddenModal, setShowHiddenModal] = useState(false);
  const [confirmPurge, setConfirmPurge] = useState<{ ids: string[]; count: number } | null>(null);
  const [purgePending, setPurgePending] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // 阅读设置计算
  const reading = data.preferences.reading || DEFAULT_READING_PREFERENCES;
  const fontStack = FONT_STACK_MAP[reading.fontFamily]?.stack || FONT_STACK_MAP.system.stack;
  const logStyle = {
    '--chat-font-family': fontStack,
    '--chat-font-size': `${reading.fontSize}px`,
    '--chat-line-height': reading.lineHeight,
    '--chat-message-spacing': `${reading.messageSpacing}px`,
  } as React.CSSProperties;

  // 切换会话时清空选择与滚动重置
  useEffect(() => {
    setIsSelecting(false);
    setSelectedIds(new Set());
    stickRef.current = true;
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [conversationId]);
  useEffect(()=>{setChannel('luma');},[conversationId]);
  useEffect(()=>{setIsSelecting(false);setSelectedIds(new Set());setShowHiddenModal(false);stickRef.current=true;},[channel]);

  // 只在用户本就贴着底部时自动滚动，避免打断向上翻阅
  useLayoutEffect(() => {
    const el = logRef.current;
    if (!el || !stickRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [messages.length, conversationId, channel, messages[messages.length - 1]?.text]);

  if (!conversation) return null;

  const targetAgent = conversation.agentId ? data.agents.find((a) => a.id === conversation.agentId) : undefined;

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (importBusyRef.current) return;
    if (e.key !== 'Enter' || e.shiftKey) return;
    // 中文输入法组合输入期间绝不发送
    if (composingRef.current || (e.nativeEvent as any).isComposing || e.keyCode === 229) return;
    e.preventDefault();
    send(conversationId);
  };

  const autoGrow = (el: HTMLTextAreaElement) => {
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 148)}px`;
  };

  const handleCopy = (id: string, text: string) => {
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      navigator.clipboard.writeText(text);
      setCopiedId(id);
      setTimeout(() => setCopiedId((cur) => (cur === id ? null : cur)), 1500);
    }
  };

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAll = () => {
    setSelectedIds(new Set(messages.map((m) => m.id)));
  };

  const cancelSelect = () => {
    setSelectedIds(new Set());
    setIsSelecting(false);
  };

  const handleHideSelected = () => {
    if (selectedIds.size === 0) return;
    store.hideMessages(Array.from(selectedIds));
    setSelectedIds(new Set());
    setIsSelecting(false);
  };

  const handleOpenPurgeSelected = () => {
    if (selectedIds.size === 0) return;
    setConfirmPurge({ ids: Array.from(selectedIds), count: selectedIds.size });
  };

  const executePurge = async () => {
    if (!confirmPurge) return;
    setPurgePending(true);
    try {
      const ok = await store.purgeMessages(confirmPurge.ids);
      if (ok) {
        setSelectedIds(new Set());
        setIsSelecting(false);
        setConfirmPurge(null);
      }
    } finally {
      setPurgePending(false);
    }
  };

  return (
    <section className="panel chat" aria-label={conversation.title}>
      {(() => {
        const activeResponderId =
          conversation.kind === 'direct'
            ? conversation.agentId
            : livingRoomResponder(store.data);
        const activeResponder = store.data.agents.find((a) => a.id === activeResponderId);
        const profile = activeResponder?.profileId
          ? store.data.chatProfiles?.find((p) => p.id === activeResponder.profileId)
          : undefined;
        const isReal = activeResponder?.mode === 'real';
        const clientRoute = clientRoutes.find(r => r.agentId === activeResponderId && r.chatEnabled);
        const clientName = clientRoute?.executorId === 'kiro' ? 'Kiro' : clientRoute?.executorId === 'zcode' ? 'Zcode' : clientRoute?.executorId === 'opencode' ? 'OpenCode' : '反重力';
        const isCodex = profile?.providerType === 'codex-app-server';
        const effectiveModel = isCodex
          ? (profile?.codexModel || profile?.model || 'gpt-6.1-sol')
          : (profile?.model || '待配置');

        return (
          <>
            <div className="chat__head">
              <h2 className="chat__title">{conversation.title}</h2>
              <span className="chat__sub">
                {conversation.kind === 'living-room'
                  ? `客厅群聊 · 本轮回答: ${allSelected ? '全部成员' : activeResponder?.name ?? '成员'}`
                  : `与 ${targetAgent?.name ?? '成员'} 的私聊`}
              </span>
              {awayAgentId===activeResponderId&&<span role="status" className="chat__sub" style={{fontSize:11}}>{activeResponder?.name}出门了，暂时不在家 · 可以留言</span>}
              {hasChannels&&<div className="chat__channels" role="group" aria-label="协调者聊天通道">
                <button type="button" aria-pressed={channel==='luma'} className={channel==='luma'?'is-active':''} onClick={()=>setChannel('luma')}>Luma 私聊</button>
                <button type="button" aria-pressed={channel==='xiaodu'} className={channel==='xiaodu'?'is-active':''} onClick={()=>setChannel('xiaodu')}>小度陪伴</button>
              </div>}
              <div className="topbar__spacer" />

              {/* 隐藏消息查看入口 */}
              {hiddenMessages.length > 0 && (
                <button
                  type="button"
                  className="btn btn--ghost"
                  style={{ fontSize: 12, padding: '3px 8px', minHeight: 28, marginRight: 6 }}
                  onClick={() => setShowHiddenModal(true)}
                  title="查看与恢复从窗口删除的消息"
                  data-testid="btn-view-hidden-messages"
                >
                  <EyeOff size={13} style={{ marginRight: 4 }} />
                  已隐藏 ({hiddenMessages.length})
                </button>
              )}

              {/* 多选按钮 */}
              <button
                type="button"
                className={`btn ${isSelecting ? 'btn--primary' : 'btn--ghost'}`}
                style={{ fontSize: 12, padding: '3px 8px', minHeight: 28, marginRight: 6 }}
                onClick={() => {
                  if (isSelecting) cancelSelect();
                  else setIsSelecting(true);
                }}
                title={isSelecting ? '退出多选' : '选择消息批量管理'}
                data-testid="btn-toggle-select"
              >
                <CheckSquare size={13} style={{ marginRight: 4 }} />
                {isSelecting ? '退出选择' : '选择'}
              </button>

              <button
                className="btn btn--ghost"
                style={{ fontSize: 12, padding: '3px 8px', minHeight: 28, marginRight: 6 }}
                onClick={() => onOpenMemory?.()}
                title="查看与管理长时记忆与检查点"
                data-testid="btn-open-memory"
              >
                <BookOpen size={13} style={{ marginRight: 4 }} />
                长时记忆
              </button>
              <span className={`dot dot--${isReal ? ((clientRoute ? clientRoute.connected : activeResponder?.connected) ? 'live' : 'warn') : 'demo'}`} aria-hidden />
              <span className="chat__sub">
                {isReal
                  ? (clientRoute ? `本机 ${clientName} · ${clientRoute.executorId === 'opencode' ? 'Space Bunny Free' : '模型由客户端选择'}` : isCodex
                      ? `本机 Codex CLI · ${effectiveModel}${conversation.codexThreadId ? ' (专属Thread)' : ''}`
                      : `真实接口 · ${effectiveModel}`)
                  : '演示模式 · 未连接真实服务'}
              </span>
            </div>

            {/* 批量操作工具条 */}
            {isSelecting && (
              <div className="chat__batch-bar" data-testid="chat-batch-bar">
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <span style={{ fontWeight: 600 }}>
                    已选 <span style={{ color: 'var(--accent)' }}>{selectedIds.size}</span> / {messages.length} 条消息
                  </span>
                  <button type="button" className="btn btn--ghost" style={{ minHeight: 26, padding: '2px 8px', fontSize: 12 }} onClick={selectAll}>
                    全选当前会话
                  </button>
                  <button type="button" className="btn btn--ghost" style={{ minHeight: 26, padding: '2px 8px', fontSize: 12 }} onClick={cancelSelect}>
                    取消
                  </button>
                </div>
                <div className="chat__batch-actions">
                  <button
                    type="button"
                    className="btn btn--ghost"
                    style={{ minHeight: 28, padding: '3px 10px', fontSize: 12 }}
                    disabled={selectedIds.size === 0}
                    onClick={handleHideSelected}
                    title="隐藏选中的气泡，原话仍参与上下文记忆"
                    data-testid="btn-hide-selected"
                  >
                    <EyeOff size={13} style={{ marginRight: 4 }} />
                    从窗口删除 (保留记忆)
                  </button>
                  <button
                    type="button"
                    className="btn btn--danger"
                    style={{ minHeight: 28, padding: '3px 10px', fontSize: 12 }}
                    disabled={selectedIds.size === 0}
                    onClick={handleOpenPurgeSelected}
                    title="从当前小屋数据与后续可召回内容中彻底清理选中的原话及派生记录"
                    data-testid="btn-purge-selected"
                  >
                    <Trash2 size={13} style={{ marginRight: 4 }} />
                    永久删除 (清理记忆)
                  </button>
                </div>
              </div>
            )}

            <div
              className="chat__log"
              ref={logRef}
              style={logStyle}
              onScroll={(e) => {
                const el = e.currentTarget;
                stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
              }}
            >
              {messages.length === 0 ? (
                <div className="chat__empty">
                  <h2>这里还很安静</h2>
                  <p>
                    {conversation.kind === 'living-room'
                      ? '客厅里还没有消息。说点什么，或者先把工单讨论挪到这里。'
                      : `还没有和${targetAgent?.name ?? '该成员'}的对话。`}
                  </p>
                </div>
              ) : (
                channelRules.timeline(messages.map(m=>channelMap.get(m.id)?.deviceEvent?{...m,eventKind:'device-event'}:m)).map((row) => {
                  const render=(m:Message)=>(
                  <MessageRow
                    key={m.id}
                    message={m}
                    workReply={replyModes.get(m.id) || false}
                    store={store}
                    conversationId={conversationId}
                    streaming={isStreamingHere && m.id === streamingId}
                    isSelecting={isSelecting}
                    isSelected={selectedIds.has(m.id)}
                    isCopied={copiedId === m.id}
                    onToggleSelect={() => toggleSelect(m.id)}
                    onCopy={() => handleCopy(m.id, m.text)}
                    onHideOne={() => store.hideMessages([m.id])}
                    onPurgeOne={() => setConfirmPurge({ ids: [m.id], count: 1 })}
                  />
                  );
                  return row.kind==='message'?render(row.message):<details key={'events-'+row.messages[0]?.id} className="chat__device-events">
                    <summary>设备唤醒记录 · {row.count} 次</summary>
                    <div>{row.messages.map(render)}</div>
                  </details>;
                })
              )}
            </div>

            {hasChannels&&channel==='xiaodu'?<div className="chat__channel-note">在小度上和我说话，交谈会同步到这里。<span>两边共用协调者的记忆。</span></div>:<div className="composer">
              {attachmentDrafts.length > 0 && <AttachmentCards attachments={attachmentDrafts} onRemove={id => dispatch({ type: 'removeAttachmentDraft', conversationId, attachmentId: id })} />}
              {addingAttachments && <div className="attachment-hint" role="status">正在保存附件…</div>}
              {attachmentErrors[conversationId] && <div className="attachment-hint attachment-hint--error" role="alert">{attachmentErrors[conversationId]}</div>}
              {conversation.kind === 'living-room' && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 8px 8px', fontSize: 12, flexWrap: 'wrap' }}>
                  <span style={{ color: 'var(--text-sub)' }}>本轮由谁回答：</span>
                  <button
                    type="button"
                    data-testid="mention-all"
                    aria-pressed={!!allSelected}
                    className={`btn ${allSelected ? 'btn--primary' : 'btn--ghost'}`}
                    style={{ minHeight: 24, padding: '1px 10px', fontSize: 11, borderRadius: 12 }}
                    disabled={!store.ready || !!roundHere || !data.agents.some((a) => a.kind === 'ai' && !a.removed)}
                    title="每位成员依次回应一次，后回应者可参考前面的公开消息"
                    onClick={() => { store.setLivingRoomAll(); document.getElementById('composer-input')?.focus(); }}
                  >
                    @全部
                  </button>
                  {data.agents
                    .filter((a) => a.kind === 'ai' && !a.removed)
                    .map((ag) => (
                      <button
                        key={ag.id}
                        type="button"
                        className={`btn ${!allSelected && activeResponderId === ag.id ? 'btn--primary' : 'btn--ghost'}`}
                        style={{ minHeight: 24, padding: '1px 8px', fontSize: 11, borderRadius: 12 }}
                        onClick={() => store.setLivingRoomSpeaker(ag.id)}
                        disabled={!!roundHere}
                      >
                        <Avatar agent={ag} className="avatar--xs" style={{ marginRight: 4, width: 14, height: 14, fontSize: 9 }} />
                        {ag.name}
                        {ag.mode === 'real' && <span style={{ marginLeft: 3, opacity: 0.8 }}>(真实)</span>}
                      </button>
                    ))}
                </div>
              )}

              {roundHere && <div className="composer__hint" role="status" data-testid="all-reply-progress">
                正在请 {data.agents.find((a) => a.id === roundHere.currentAgentId)?.name ?? '成员'} 回应 · {roundHere.index + 1}/{roundHere.total}
              </div>}

              <div className="composer__row">
                <input ref={fileInputRef} type="file" accept={ATTACHMENT_ACCEPT} multiple hidden data-testid="attachment-file-input" onChange={e => { const files = Array.from(e.target.files ?? []); e.target.value = ''; void addFiles(files); }} />
                <button className="btn btn--icon btn--ghost composer__attach" data-testid="add-attachment" aria-label="添加照片或文件" title="添加照片或文字文件（最多 4 个）" disabled={!store.ready || !window.xiaowuDesktop?.attachments || addingAttachments || attachmentDrafts.length >= 4 || !isAvailableAI(data, activeResponderId)} onClick={() => fileInputRef.current?.click()}><Paperclip size={19} /></button>
                <label className="sr-only" htmlFor="composer-input">
                  输入消息
                </label>
                <textarea
                  id="composer-input"
                  className="composer__input"
                  value={draft}
                  disabled={!store.ready || !isAvailableAI(data, activeResponderId)}
                  placeholder={
                    !store.ready
                      ? '正在读取本地数据…'
                      : !isAvailableAI(data, activeResponderId) ? '先添加或恢复一位 AI 成员，再开始聊天…' : conversation.kind === 'living-room'
                        ? allSelected ? '@全部，想和大家说些什么…' : `在客厅发给 ${activeResponder?.name ?? '成员'}…`
                        : `发给 ${targetAgent?.name ?? '该成员'}…`
                  }
                  rows={1}
                  onChange={(e) => {
                    dispatch({ type: 'setDraft', conversationId, text: e.target.value });
                    autoGrow(e.target);
                  }}
                  onCompositionStart={() => {
                    composingRef.current = true;
                  }}
                  onCompositionEnd={() => {
                    composingRef.current = false;
                  }}
                  onKeyDown={onKeyDown}
                  onPaste={e => { const files = Array.from(e.clipboardData.files); if (files.length) { e.preventDefault(); void addFiles(files); } }}
                />
                {isStreamingHere ? (
                  <button className="btn composer__stop btn--danger" onClick={stop} title="停止生成">
                    <Square size={15} aria-hidden /> 停止
                  </button>
                ) : (
                  <button className="btn btn--primary composer__send" onClick={() => send(conversationId)} disabled={addingAttachments || (!draft.trim() && !attachmentDrafts.length) || !store.ready || !isAvailableAI(data, activeResponderId)} title="发送">
                    <Send size={16} aria-hidden />
                    <span className="sr-only">发送</span>
                  </button>
                )}
              </div>
              <div className="composer__hint">
                <span className="desktop-only">
                  <CornerDownLeft size={11} aria-hidden /> Enter 发送 · Shift+Enter 换行
                </span>
                <span>
                  {allSelected ? '全部成员依次回应 · 每人一次 · 可随时停止' : isReal
                    ? (clientRoute ? `发送给 ${activeResponder?.name} · 本机 ${clientName}${clientRoute.connected ? '' : '（等待连接）'}` : isCodex
                        ? `真实 Codex 试聊 · 发送给 ${activeResponder?.name} (${effectiveModel} · 独立会话)`
                        : `真实接口 · 发送给 ${activeResponder?.name} (${effectiveModel})`)
                    : `演示模式 · 发送给 ${activeResponder?.name} (本机生成)`}
                </span>
              </div>
            </div>}

            {/* 隐藏消息管理抽屉/弹窗 */}
            {showHiddenModal && (
              <div className="modal-backdrop" onClick={() => setShowHiddenModal(false)} role="presentation">
                <div
                  className="modal modal--settings"
                  style={{ maxWidth: 600, width: '90vw', maxHeight: '80vh', overflowY: 'auto' }}
                  onClick={(e) => e.stopPropagation()}
                  role="dialog"
                  aria-labelledby="hidden-modal-title"
                  aria-modal="true"
                >
                  <div className="modal__head">
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <EyeOff size={18} aria-hidden />
                      <h2 id="hidden-modal-title" className="modal__title">
                        已隐藏消息 ({hiddenMessages.length})
                      </h2>
                    </div>
                    <button className="btn btn--icon" onClick={() => setShowHiddenModal(false)} aria-label="关闭">
                      <X size={16} aria-hidden />
                    </button>
                  </div>

                  <div className="modal__body" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                    <p style={{ fontSize: 12, color: 'var(--text-sub)', margin: 0 }}>
                      这些消息仅从窗口气泡中隐藏，原话仍保存在本地数据中并参与上下文与长时记忆。若需彻底清除，请选择永久删除。
                    </p>

                    <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                      <button
                        type="button"
                        className="btn btn--ghost"
                        style={{ minHeight: 28, fontSize: 12 }}
                        onClick={() => store.unhideMessages(hiddenMessages.map((m) => m.id))}
                      >
                        全部恢复到窗口
                      </button>
                    </div>

                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: '50vh', overflowY: 'auto' }}>
                      {hiddenMessages.map((m) => {
                        const ag = data.agents.find((a) => a.id === m.agentId);
                        const bj = getBeijingTime(m.createdAt);
                        return (
                          <div
                            key={m.id}
                            style={{
                              padding: '8px 12px',
                              background: 'var(--panel)',
                              border: '1px solid var(--border)',
                              borderRadius: 6,
                              display: 'flex',
                              flexDirection: 'column',
                              gap: 4,
                            }}
                          >
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 11, color: 'var(--text-sub)' }}>
                              <span style={{ fontWeight: 600, color: 'var(--ink)' }}>{ag?.name ?? '未知成员'}</span>
                              <span title={bj.formattedFull}>{bj.formattedDateTime}</span>
                            </div>
                            <div style={{ fontSize: 13, whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: 'var(--ink)' }}>
                              {m.text}
                            </div>
                            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 4 }}>
                              <button
                                type="button"
                                className="btn btn--ghost"
                                style={{ minHeight: 24, padding: '2px 8px', fontSize: 11 }}
                                onClick={() => store.unhideMessages([m.id])}
                                title="恢复到聊天窗口"
                              >
                                <Eye size={12} style={{ marginRight: 4 }} /> 恢复
                              </button>
                              <button
                                type="button"
                                className="btn btn--danger"
                                style={{ minHeight: 24, padding: '2px 8px', fontSize: 11 }}
                                onClick={() => setConfirmPurge({ ids: [m.id], count: 1 })}
                                title="彻底清理该消息及派生记忆"
                              >
                                <Trash2 size={12} style={{ marginRight: 4 }} /> 永久删除
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  <div className="modal__foot" style={{ display: 'flex', justifyContent: 'flex-end' }}>
                    <button className="btn btn--ghost" onClick={() => setShowHiddenModal(false)}>
                      关闭
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* 永久删除二次确认对话框 */}
            {confirmPurge && (
              <div className="modal-backdrop" onClick={() => !purgePending && setConfirmPurge(null)} role="presentation">
                <div
                  className="modal modal--settings"
                  style={{ maxWidth: 520, width: '90vw' }}
                  onClick={(e) => e.stopPropagation()}
                  role="alertdialog"
                  aria-labelledby="purge-dialog-title"
                  aria-modal="true"
                >
                  <div className="modal__head">
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--danger)' }}>
                      <AlertTriangle size={18} aria-hidden />
                      <h2 id="purge-dialog-title" className="modal__title" style={{ color: 'var(--danger)' }}>
                        确认永久删除消息？
                      </h2>
                    </div>
                    <button className="btn btn--icon" disabled={purgePending} onClick={() => setConfirmPurge(null)} aria-label="关闭">
                      <X size={16} aria-hidden />
                    </button>
                  </div>

                  <div className="modal__body" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                    <p style={{ margin: 0, fontSize: 13, lineHeight: 1.6, color: 'var(--ink)' }}>
                      将永久删除所选的 <strong>{confirmPurge.count}</strong> 条消息。
                    </p>

                    <div style={{ padding: '10px 12px', background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 6, fontSize: 12, lineHeight: 1.6 }}>
                      <div style={{ fontWeight: 600, marginBottom: 4 }}>影响范围与接线承诺：</div>
                      <ul style={{ margin: 0, paddingLeft: 18, color: 'var(--text-sub)' }}>
                        <li>选中的原话正文及内容副本从当前小屋数据中物理剔除；</li>
                        <li>关联由该原话派生的长时记忆条目与上下文检查点摘要将同步失效/重建；</li>
                        <li>受影响成员将断开被污染的旧 Codex thread，从保留的干净记忆新建独立会话；</li>
                        <li>永久删除墓碑将阻止迟到流式或受控备份将内容复活。</li>
                      </ul>
                    </div>

                    <p style={{ margin: 0, fontSize: 11, color: 'var(--text-sub)' }}>
                      说明：此操作将清理本机小屋记录与后续记忆，不会撤回服务商已收到的数据。
                    </p>
                  </div>

                  <div className="modal__foot" style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
                    <button className="btn btn--ghost" disabled={purgePending} onClick={() => setConfirmPurge(null)}>
                      取消
                    </button>
                    <button
                      className="btn btn--danger"
                      data-testid="btn-confirm-purge-execute"
                      disabled={purgePending}
                      onClick={executePurge}
                    >
                      {purgePending ? '正在彻底清理…' : '确认永久删除并清理记忆'}
                    </button>
                  </div>
                </div>
              </div>
            )}
          </>
        );
      })()}
    </section>
  );
}

function MessageRow({
  message,
  workReply,
  store,
  conversationId,
  streaming,
  isSelecting,
  isSelected,
  isCopied,
  onToggleSelect,
  onCopy,
  onHideOne,
  onPurgeOne,
}: {
  message: Message;
  workReply: boolean;
  store: Store;
  conversationId: string;
  streaming: boolean;
  isSelecting: boolean;
  isSelected: boolean;
  isCopied: boolean;
  onToggleSelect: () => void;
  onCopy: () => void;
  onHideOne: () => void;
  onPurgeOne: () => void;
}) {
  const agent = store.data.agents.find((a) => a.id === message.agentId);
  const self = message.agentId === 'agent_owner';
  const replyParts = replyRules.splitReply(message.text, {work: workReply, preserve: self || message.status === 'error' || !!message.attachments?.length, legacy: message.hiddenReplyParts || false}).filter(part=>!message.hiddenReplyParts?.includes(part.trim()));

  // 工单 09：前台时间统一使用北京时间；较早日期显示日期+时分，避免跨日混淆
  const bj = getBeijingTime(message.createdAt);
  const bjNow = getBeijingTime(Date.now());
  const isToday = bj.year === bjNow.year && bj.month === bjNow.month && bj.day === bjNow.day;
  const timeDisplay = isToday ? bj.formattedShort : bj.formattedDateShort;

  return (
    <article
      className={`msg ${self ? 'msg--self' : ''} ${isSelected ? 'is-selected' : ''} ${isSelecting ? 'is-selecting' : ''}`}
      data-status={message.status}
      data-request-id={message.requestId ?? ''}
      data-agent-id={message.agentId}
      data-message-id={message.id}
    >
      <div className="msg__avatar-wrap">
        {isSelecting && (
          <input
            type="checkbox"
            className="msg__select-check"
            checked={isSelected}
            onChange={onToggleSelect}
            aria-label={`选择消息 ${message.id}`}
            data-testid={`msg-select-check-${message.id}`}
          />
        )}
        <Avatar agent={agent} className="msg__avatar" />
      </div>

      <div className="msg__body">
        <div className="msg__meta">
          <span className="msg__who">{agent?.name ?? '未知成员'}</span>
          <time dateTime={new Date(message.createdAt).toISOString()} title={bj.formattedFull}>
            {timeDisplay}
          </time>
          {message.demo && <span className="tag tag--demo">演示</span>}
          {self && <span className="tag tag--me">我</span>}

          {/* 消息行悬浮操作条 */}
          <div className="msg__actions">
            <button
              type="button"
              className="btn btn--icon"
              style={{ minHeight: 22, width: 22, padding: 0 }}
              onClick={onCopy}
              title={isCopied ? '已复制原文' : '复制文本'}
              data-testid={`btn-copy-msg-${message.id}`}
            >
              {isCopied ? <Check size={12} color="var(--accent)" /> : <Copy size={12} />}
            </button>
            <button
              type="button"
              className="btn btn--icon"
              style={{ minHeight: 22, width: 22, padding: 0 }}
              onClick={onHideOne}
              title="从窗口删除 (保留记忆)"
              data-testid={`btn-hide-msg-${message.id}`}
            >
              <EyeOff size={12} />
            </button>
            <button
              type="button"
              className="btn btn--icon"
              style={{ minHeight: 22, width: 22, padding: 0, color: 'var(--danger)' }}
              onClick={onPurgeOne}
              title="永久删除 (同时清理记忆)"
              data-testid={`btn-purge-msg-${message.id}`}
            >
              <Trash2 size={12} />
            </button>
          </div>
        </div>

        {message.text ? (
          <div style={{display:'flex',flexDirection:'column',alignItems:self?'flex-end':'flex-start',gap:6}}>
            {replyParts.map((part,index)=>{
              const text=replyParts.length>1?part.trim():part;
              return <div key={index} className="msg__bubble" data-reply-part={index+1}>
                {/```|~~~/.test(text)?text:text.split(/\r?\n[\t ]*\r?\n+/).map((paragraph,i)=><span key={i} style={{display:'block',marginTop:i?4:0}}>{paragraph}</span>)}
              </div>;
            })}
          </div>
        ) : (
          <div className="msg__bubble msg__bubble--empty">
            {message.status === 'stopped' ? '（本次回复已停止）' : '（正在组织语言…）'}
          </div>
        )}
        {!!message.attachments?.length && <AttachmentCards attachments={message.attachments} />}

        {message.memoryReceipt && (
          <details className="msg__memory-receipt" style={{ marginTop: 6, fontSize: 11, color: 'var(--text-sub)' }}>
            <summary style={{ cursor: 'pointer', userSelect: 'none', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <span>本轮参考了哪些记忆 ({message.memoryReceipt.injectedSources.length} 项)</span>
            </summary>
            <div style={{ marginTop: 4, padding: '6px 8px', background: 'var(--panel-sub-bg, rgba(0,0,0,0.04))', borderRadius: 6, fontSize: 11 }}>
              {message.memoryReceipt.preparedSources.length === 0 ? (
                <div>无相关长时记忆命中（使用基础对话上下文）</div>
              ) : (
                <ul style={{ margin: 0, paddingLeft: 14 }}>
                  {message.memoryReceipt.preparedSources.map((src, i) => {
                    const srcBj = getBeijingTime(src.timestamp);
                    return (
                      <li key={i} style={{ marginBottom: 2 }}>
                        <span style={{ fontWeight: 500 }}>{src.title}</span>
                        <span style={{ marginLeft: 6, opacity: 0.8 }}>({src.sourceType} · {srcBj.formattedShort})</span>
                        {src.injected ? (
                          <span style={{ marginLeft: 6, color: 'var(--accent, #4a6b82)' }}>[已带入]</span>
                        ) : (
                          <span style={{ marginLeft: 6, opacity: 0.5 }}>[预算精简未带入]</span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
              <div style={{ marginTop: 4, opacity: 0.7, fontSize: 10 }}>
                状态: {message.memoryReceipt.status === 'completed' ? '已完成' : message.memoryReceipt.status === 'failed' ? '失败' : message.memoryReceipt.status === 'cancelled' ? '已取消' : '准备就绪'} · 字符预算: {message.memoryReceipt.usedChars} / {message.memoryReceipt.totalBudgetChars}
                {message.memoryReceipt.fallbackUsed && message.memoryReceipt.fallbackUsed !== 'none' && ` · 回退: ${message.memoryReceipt.fallbackUsed}`}
              </div>
            </div>
          </details>
        )}

        {streaming && store.thinking && (
          <div className="msg__state">
            <span className="thinking">
              <span className="thinking__halo" aria-hidden />
              正在思考（演示）
            </span>
          </div>
        )}

        {message.status === 'stopped' && (
          <div className="msg__state msg__state--stopped">
            <Info size={12} aria-hidden /> 已停止
            <button className="btn btn--icon" style={{ minHeight: 26, marginLeft: 6 }} onClick={() => store.retry(conversationId, message.id)}>
              <RotateCcw size={13} aria-hidden /> 重试
            </button>
          </div>
        )}

        {message.status === 'error' && (
          <div className="msg__state msg__state--error">
            <Info size={12} aria-hidden /> 发送失败：{message.error ?? '未知错误'}
            {message.error && (message.error.includes('中断') || message.error.includes('停止') || message.error.includes('unconfirmed')) ? (
              <button className="btn btn--danger btn--icon" style={{ minHeight: 26, marginLeft: 6 }} onClick={store.stop} title="再次向后台发送停止请求">
                <Square size={13} aria-hidden /> 重试停止
              </button>
            ) : (
              <button className="btn btn--icon" style={{ minHeight: 26 }} onClick={() => store.retry(conversationId, message.id)}>
                <RotateCcw size={13} aria-hidden /> 重试
              </button>
            )}
          </div>
        )}
      </div>
    </article>
  );
}
