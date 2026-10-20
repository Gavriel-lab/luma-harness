import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { ChatBus } from '../adapter/ChatBus';
import { CompositeAdapter } from '../adapter/CompositeAdapter';
import type { ChatAdapter } from '../adapter/ChatAdapter';
import { reducer, type Action } from '../store/reducer';
import { buildEmpty, buildSeed } from '../store/seed';
import { createBackend, type Backend } from '../store/backend';
import { assembleTurnContext } from '../store/memoryManager';
import { livingRoomResponder, isAvailableAI } from '../utils/activeAgents';
import {
  uid,
  type Agent,
  type AgentId,
  type AppData,
  type ChatProfile,
  type ConversationId,
  type Message,
  type MessageId,
  type ThemeId,
  type MemoryItem,
  type ContextCheckpoint,
  type MemoryGatewayConfig,
  type ReadingPreferences,
} from '../types';

/** 工单 08-R4：保存屏障期限（毫秒）——发送/重试等待可信保存确认的统一配置点 */
export const SAVE_BARRIER_TIMEOUT_MS = 15000;

type ReplyOutcome = 'sent' | 'error' | 'stopped' | 'blocked';
interface AllReplyRound {
  id: string;
  conversationId: string;
  currentAgentId: string;
  index: number;
  total: number;
}
interface SendOptions {
  agentId: string;
  userMessage: Message;
  appendUser: boolean;
  roundId: string;
}

export interface RecoveryNotice {
  reason: string;
  raw: string;
  /** 用户是否已选择丢弃损坏数据 */
  discarded: boolean;
  /** 主文件是否根本读不出来（此时不允许「备份空字符串」后覆写） */
  unreadable: boolean;
  /** 原文是否已安全另存；未保存前不允许恢复/覆盖 */
  rawPreserved: boolean;
}

export interface Store {
  data: AppData;
  dispatch: React.Dispatch<Action>;
  adapter: ChatAdapter;
  /** 异步存储是否加载完成；未完成前不写入任何数据，编辑入口禁用 */
  ready: boolean;
  backendKind: 'browser' | 'desktop';
  storageHint: string;
  /** 最近一次保存是否真的落盘 */
  saved: boolean;
  saveFailed: boolean;
  /** 上次关闭被拦下的原因（写入失败或超时） */
  closeBlockedReason: string | null;
  backupUsable: boolean;
  streamingConversationId: ConversationId | null;
  streamingMessageId: MessageId | null;
  thinking: boolean;
  livingRoomAll: boolean;
  allReplyRound: AllReplyRound | null;
  setLivingRoomAll: () => void;
  recovery: RecoveryNotice | null;
  persistError: string | null;
  exportError: string | null;
  dismissRecovery: () => void;
  discardAndStartBlank: () => void;
  /** 恢复最近有效副本：只有原文已安全保留且副本校验通过才允许 */
  restoreFromBackup: () => void;
  /** 用户明确放弃未保存内容后退出 */
  discardUnsavedAndClose: () => void;
  dismissCloseBlocked: () => void;
  send: (conversationId: ConversationId) => void;
  stop: () => void;
  retry: (conversationId: ConversationId, messageId: MessageId) => void;
  exportData: () => Promise<void>;
  setTheme: (theme: ThemeId) => void;
  setLivingRoomSpeaker: (agentId: AgentId | null) => void;
  saveChatProfile: (profile: ChatProfile) => void;
  deleteChatProfile: (profileId: string) => void;
  updateAgentConfig: (agentId: AgentId, patch: Partial<Pick<Agent, 'mode' | 'profileId' | 'systemPrompt' | 'statusNote' | 'connected'>>) => void;
  saveMemory: (memory: MemoryItem) => void;
  tombstoneMemory: (memoryId: string) => void;
  deleteMemoryPermanently: (memoryId: string) => void;
  saveCheckpoint: (checkpoint: ContextCheckpoint) => void;
  updateMemoryGatewayConfig: (config: Partial<MemoryGatewayConfig>) => void;
  setReadingPreferences: (reading: Partial<ReadingPreferences>) => void;
  hideMessages: (messageIds: MessageId[]) => void;
  unhideMessages: (messageIds: MessageId[]) => void;
  purgeMessages: (messageIds: MessageId[]) => Promise<boolean>;
  flushSave?: (customSnapshot?: AppData) => Promise<boolean>;
}

export function useAppStore(): Store {
  const backend = useMemo<Backend>(() => createBackend(), []);
  const [data, dispatch] = useReducer(reducer, undefined, () => buildEmpty());
  const [ready, setReady] = useState(false);
  const [recovery, setRecovery] = useState<RecoveryNotice | null>(null);
  const [stream, setStream] = useState<{ conversationId: string; messageId: string } | null>(null);
  const [thinking, setThinking] = useState(false);
  const [livingRoomAll, setLivingRoomAllState] = useState(false);
  const [allReplyRound, setAllReplyRound] = useState<AllReplyRound | null>(null);
  const livingRoomAllRef = useRef(false);
  const allRoundIdRef = useRef<string | null>(null);
  const allRoundConversationRef = useRef<string | null>(null);
  const replyWaitersRef = useRef(new Map<string, (outcome: ReplyOutcome) => void>());
  const finishReply = (requestId: string, outcome: ReplyOutcome) => {
    const resolve = replyWaitersRef.current.get(requestId);
    replyWaitersRef.current.delete(requestId);
    resolve?.(outcome);
  };
  const cancelAllRound = () => {
    allRoundIdRef.current = null;
    allRoundConversationRef.current = null;
    setAllReplyRound(null);
    for (const resolve of replyWaitersRef.current.values()) resolve('stopped');
    replyWaitersRef.current.clear();
  };
  const [persistError, setPersistError] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [storageHint, setStorageHint] = useState('');
  const [saved, setSaved] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const [closeBlockedReason, setCloseBlockedReason] = useState<string | null>(null);
  const [backupUsable, setBackupUsable] = useState(false);

  const adapter = useMemo(() => new CompositeAdapter(), []);

  const dataRef = useRef(data);
  dataRef.current = data;
  const revisionRef = useRef(0);
  const recoveryRef = useRef(recovery);
  recoveryRef.current = recovery;
  const readyRef = useRef(ready);
  readyRef.current = ready;
  const streamRef = useRef(stream);
  streamRef.current = stream;
  /** 当前挂载的会话标识；桌面端每次挂载都不同 */
  const sessionIdRef = useRef<string | null>(null);
  /** 待执行的防抖保存：关闭握手时要能立刻冲掉它 */
  const pendingSaveRef = useRef<(() => void) | null>(null);
  const cancelPendingSaveRef = useRef<(() => void) | null>(null);
  const discardingRef = useRef(false);
  const rawPreservedRef = useRef(false);
  /** 工单 08-R4 P1：保存屏障等待期的待发请求登记（可停止/可失效，迟到成功不再启动模型） */
  const pendingBarrierRef = useRef<{
    requestId: string;
    messageId: string;
    conversationId: string;
    cancelled: boolean;
  } | null>(null);
  /** 工单 08-R4 P2：保存批次的最长等待计时器（锚定批次首脏时刻，不随每次 delta 重置） */
  const saveBatchRef = useRef<{ maxWaitTimer: number } | null>(null);
  /** 工单 08-R4 补单：窗口关闭握手状态标识，阻止关闭流程中新发起模型请求 */
  const closingRef = useRef(false);

  const bus = useMemo(
    () =>
      new ChatBus(adapter, {
        onStart: (i) => {
          setStream({ conversationId: i.conversationId, messageId: i.messageId });
          setThinking(false);
          dispatch({ type: 'patchMessage', id: i.messageId, patch: { status: 'streaming', error: undefined } });
        },
        onThinking: () => setThinking(true),
        onDelta: (i) => {
          setThinking(false);
          dispatch({
            type: 'appendDelta',
            messageId: i.messageId,
            conversationId: i.conversationId,
            requestId: i.requestId,
            delta: i.delta,
          });
        },
        onDone: (i) => {
          setStream(null);
          setThinking(false);
          dispatch({
            type: 'finishMessage',
            messageId: i.messageId,
            conversationId: i.conversationId,
            requestId: i.requestId,
            status: 'sent',
          });
          finishReply(i.requestId, 'sent');

          // 旁路 MemoryGateway 录入（容错降级，不阻断主流程）
          try {
            const currentData = dataRef.current;
            if (currentData.memoryGatewayConfig?.enabled && typeof window !== 'undefined' && window.xiaowuDesktop?.memoryGateway) {
              const conv = currentData.conversations.find((c) => c.id === i.conversationId);
              let namespace = '';
              if (conv?.kind === 'direct' && conv.agentId === 'agent_editor') {
                namespace = 'xiaowu-direct-antigravity';
              } else if (conv?.kind === 'living-room') {
                namespace = 'xiaowu-living-room';
              }
              if (namespace) {
                const assistantMsg = currentData.messages.find((m) => m.id === i.messageId);
                const userMsgs = currentData.messages.filter(
                  (m) => m.conversationId === i.conversationId && m.agentId === 'agent_owner',
                );
                const userMsg = userMsgs.length > 0 ? userMsgs[userMsgs.length - 1] : undefined;
                if (userMsg && assistantMsg) {
                  window.xiaowuDesktop.memoryGateway.ingest({
                    conversationId: i.conversationId,
                    namespace,
                    messages: [
                      { role: 'user', content: userMsg.text, createdAt: userMsg.createdAt },
                      { role: 'assistant', content: assistantMsg.text, createdAt: assistantMsg.createdAt },
                    ],
                  }).catch(() => {});
                }
              }
            }
          } catch {
            // 静默容错
          }
        },
        onError: (i) => {
          setStream(null);
          setThinking(false);
          dispatch({
            type: 'finishMessage',
            messageId: i.messageId,
            conversationId: i.conversationId,
            requestId: i.requestId,
            status: 'error',
            error: i.message,
          });
          finishReply(i.requestId, 'error');
        },
        onCancelled: (i) => {
          setStream(null);
          setThinking(false);
          dispatch({
            type: 'finishMessage',
            messageId: i.messageId,
            conversationId: i.conversationId,
            requestId: i.requestId,
            status: 'stopped',
          });
          finishReply(i.requestId, 'stopped');
        },
      }),
    [adapter],
  );

  /* ---------- 会话初始化 + 异步加载：完成前绝不写入初始空数据 ---------- */
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const session = await backend.beginSession();
        if (!alive) return;
        sessionIdRef.current = session.sessionId;

        const loaded = await backend.load();
        if (!alive) return;
        // 路径提示失败不阻断已读取的数据
        setStorageHint(await backend.describe());

        if (loaded.kind === 'ok') {
          dispatch({ type: 'hydrate', data: loaded.data });
        } else if (loaded.kind === 'recovered') {
          // 损坏或读不出来：保持暂停写入，等用户明确决定，绝不当成首次使用覆盖
          dispatch({ type: 'hydrate', data: buildSeed() });
          rawPreservedRef.current = false;
          setRecovery({
            reason: loaded.reason,
            raw: loaded.raw,
            discarded: false,
            unreadable: loaded.unreadable === true,
            rawPreserved: false,
          });
          // 顺便看看有没有可用的有效副本
          const b = await backend.checkBackup();
          if (alive) setBackupUsable(b.usable);
        } else {
          dispatch({ type: 'hydrate', data: buildEmpty() });
        }
      } catch (err) {
        if (!alive) return;
        console.error('加载本地数据发生异常:', err);
        dispatch({ type: 'hydrate', data: buildSeed() });
        rawPreservedRef.current = false;
        setRecovery({
          reason: err instanceof Error ? err.message : '加载本地数据发生异常',
          raw: '',
          discarded: false,
          unreadable: true,
          rawPreserved: false,
        });
      } finally {
        if (alive) setReady(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, [backend]);

  /* ---------- 保存：串行 + revision，旧状态不会盖掉新状态 ---------- */
  useEffect(() => {
    if (!ready || discardingRef.current) return;
    // 等用户明确选择恢复方案前，不能把损坏原文覆盖掉
    if (recoveryRef.current && !recoveryRef.current.discarded) return;

    revisionRef.current += 1;
    const revision = revisionRef.current;
    const snapshot = data;

    let saveFired = false;
    const run = () => {
      if (saveFired) return;
      saveFired = true;
      pendingSaveRef.current = null;
      cancelPendingSaveRef.current = null;
      // 本次保存落地即收掉本批次的最长等待计时器
      if (saveBatchRef.current) {
        window.clearTimeout(saveBatchRef.current.maxWaitTimer);
        saveBatchRef.current = null;
      }
      if (discardingRef.current) return;
      void backend.save(snapshot, revision).then((r) => {
        // 迟到的旧请求不再改提示，避免旧失败盖掉新成功
        if (revision < revisionRef.current) return;
        if (!r.ok) {
          setSaveFailed(true);
          setSaved(false);
          setPersistError(r.reason ?? '写入失败');
        } else if (r.applied) {
          setSaved(true);
          setSaveFailed(false);
          setPersistError(null);
        } else {
          // skipped：这份状态没落盘，不能显示成已保存
          setSaved(false);
          setSaveFailed(false);
        }
      }).catch((e) => {
        // 保存管道异常必须显式暴露，绝不能静默吞掉（工单 08-R3）
        if (revision >= revisionRef.current) {
          setSaveFailed(true);
          setSaved(false);
          setPersistError(`保存管道异常：${e instanceof Error ? e.message : '未知错误'}`);
        }
      });
    };

    if (backend.kind === 'desktop') {
      // 200ms 尾随防抖 + 1000ms 最长等待（工单 08-R4 P2）：最长等待锚定本批次第一次
      // 变脏的时刻，连续流式更新只刷新 200ms 防抖与本 effect 的快照/revision，
      // 不再重置 1000ms 期限；触发时经 pendingSaveRef 保存最新快照，写入单调且最终完整。
      const timer = window.setTimeout(run, 200);
      if (!saveBatchRef.current) {
        const batch = { maxWaitTimer: 0 as number };
        batch.maxWaitTimer = window.setTimeout(() => {
          if (saveBatchRef.current === batch) saveBatchRef.current = null;
          pendingSaveRef.current?.();
        }, 1000);
        saveBatchRef.current = batch;
      }
      pendingSaveRef.current = () => {
        window.clearTimeout(timer);
        run();
      };
      cancelPendingSaveRef.current = () => {
        window.clearTimeout(timer);
        pendingSaveRef.current = null;
        cancelPendingSaveRef.current = null;
      };
      // cleanup 只取消本次防抖与待执行保存；批次最长等待保留给下一次更新接管
      return () => {
        window.clearTimeout(timer);
        pendingSaveRef.current = null;
      };
    }

    run();
    return undefined;
  }, [backend, data, ready]);

  /** 关闭握手：立刻提交最新状态，等主进程确认落盘后才放行关闭 */
  useEffect(() => {
    const off = backend.onCloseRequest(async () => {
      closingRef.current = true;
      cancelAllRound();
      const current = recoveryRef.current;
      if (current && !current.discarded) {
        closingRef.current = false;
        return { ok: false, reason: '数据尚未恢复，窗口保持打开' };
      }
      if (!readyRef.current) {
        closingRef.current = false;
        return { ok: false, reason: '数据仍在加载，窗口保持打开' };
      }

      // 工单 08-R4 补单：真实关闭请求到达时，立即终结/失效 pending send 或 retry 代次并阻止关闭阶段新启动
      const pending = pendingBarrierRef.current;
      if (pending && !pending.cancelled) {
        pending.cancelled = true;
        pendingBarrierRef.current = null;
        dispatch({
          type: 'finishMessage',
          messageId: pending.messageId,
          conversationId: pending.conversationId,
          requestId: pending.requestId,
          status: 'stopped',
        });
        setStream((cur) => (cur && cur.messageId === pending.messageId ? null : cur));
        setThinking(false);
        // 同步更新 dataRef.current 中该占位的状态为 stopped，确保随后关闭保存写入的是 stopped 终态而非 streaming
        dataRef.current = {
          ...dataRef.current,
          messages: dataRef.current.messages.map((m) =>
            m.id === pending.messageId ? { ...m, status: 'stopped' as const } : m,
          ),
        };
      }
      bus.cancel('user');

      // 冲掉还在防抖计时器里的那次保存，用 dataRef 里的最新状态提交
      pendingSaveRef.current?.();

      revisionRef.current += 1;
      const revision = revisionRef.current;
      try {
        const r = await backend.save(dataRef.current, revision);
        if (!r.ok) {
          closingRef.current = false;
          return { ok: false, reason: r.reason ?? '未保存的内容没有写入磁盘' };
        }
        if (!r.applied) {
          closingRef.current = false;
          return { ok: false, reason: r.reason ?? '这次保存被跳过，可能已有更新版本' };
        }
        setSaved(true);
        setSaveFailed(false);
        setPersistError(null);
        return { ok: true };
      } catch (e) {
        closingRef.current = false;
        return { ok: false, reason: e instanceof Error ? e.message : '保存失败' };
      }
    });
    const offFail = backend.onCloseFailed((reason) => {
      closingRef.current = false;
      setCloseBlockedReason(reason);
    });
    return () => {
      off?.();
      offFail?.();
    };
  }, [backend, bus]);

  /** 关闭/切后台前把最后一次改动推出去，避免丢掉最新草稿 */
  useEffect(() => {
    const flush = () => {
      if (!readyRef.current || discardingRef.current) return;
      if (recoveryRef.current && !recoveryRef.current.discarded) return;
      revisionRef.current += 1;
      void backend.save(dataRef.current, revisionRef.current);
    };
    window.addEventListener('beforeunload', flush);
    document.addEventListener('visibilitychange', flush);
    return () => {
      window.removeEventListener('beforeunload', flush);
      document.removeEventListener('visibilitychange', flush);
    };
  }, [backend, ready]);

  // 卸载时停掉进行中的生成，并使保存屏障等待期的待发请求失效
  useEffect(
    () => () => {
      allRoundIdRef.current = null;
      allRoundConversationRef.current = null;
      for (const resolve of replyWaitersRef.current.values()) resolve('stopped');
      replyWaitersRef.current.clear();
      if (pendingBarrierRef.current) {
        pendingBarrierRef.current.cancelled = true;
        pendingBarrierRef.current = null;
      }
      bus.cancel('user');
    },
    [bus],
  );

  // 监听主进程返回的 Codex 专属 thread 绑定通知并更新本地会话
  useEffect(() => {
    if (typeof window === 'undefined' || !window.xiaowuDesktop?.chat?.onCodexThreadBound) return;
    const unbind = window.xiaowuDesktop.chat.onCodexThreadBound((data) => {
        dispatch({
          type: 'bindCodexThread',
          conversationId: data.conversationId,
          threadId: data.threadId,
          instructionSources: data.instructionSources,
          profileId: data.profileId,
          verifiedAt: data.verifiedAt,
          agentId: data.agentId,
          canonicalThreadId: data.canonicalThreadId,
        });
    });
    return () => unbind();
  }, [dispatch]);

  function buildContext(
    s: AppData,
    conversationId: string,
    targetAgentId: string,
    currentText: string,
    targetMsgIdx?: number,
    extraMemoryGatewayMemories: string[] = [],
    requestId?: string,
  ) {
    return assembleTurnContext(s, {
      conversationId,
      targetAgentId,
      currentText,
      targetMsgIdx,
      extraMemoryGatewayMemories,
      requestId,
    });
  }


  const sendOne = useCallback(
    async (conversationId: ConversationId, options?: SendOptions): Promise<ReplyOutcome | undefined> => {
      if (closingRef.current || (options && allRoundIdRef.current !== options.roundId)) return 'stopped';
      const s = dataRef.current;
      const conversation = s.conversations.find((c) => c.id === conversationId);
      if (!conversation) return;
      const attachments = options?.userMessage.attachments ?? s.attachmentDrafts?.[conversationId] ?? [];
      const text = options?.userMessage.text ?? ((s.drafts[conversationId] ?? '').trim() || (attachments.length ? '请看看我发的附件。' : ''));
      if (!text) return;

      const targetAgentId = options?.agentId ?? (
        conversation.kind === 'direct'
          ? conversation.agentId
          : livingRoomResponder(s));

      if (!targetAgentId || !isAvailableAI(s, targetAgentId)) return;

      const now = Date.now();
      const userMessage: Message = options?.userMessage ?? {
        id: uid('msg'),
        conversationId,
        agentId: 'agent_owner',
        text,
        createdAt: now,
        status: 'sent',
        demo: false,
        requestId: null,
        ...(attachments.length ? { attachments } : {}),
        targetAgentId: conversation.kind === 'living-room' ? targetAgentId : undefined,
      };

      // MemoryGateway 旁路记忆召回（未启用时网络调用为 0；异常时静默降级为本地）
      let extraMemoryGatewayMemories: string[] = [];
      if (s.memoryGatewayConfig?.enabled && typeof window !== 'undefined' && window.xiaowuDesktop?.memoryGateway) {
        let namespace = '';
        if (conversation.kind === 'direct' && targetAgentId === 'agent_editor') {
          namespace = 'xiaowu-direct-antigravity';
        } else if (conversation.kind === 'living-room') {
          namespace = 'xiaowu-living-room';
        }
        if (namespace) {
          try {
            const recallRes = await Promise.race([
              window.xiaowuDesktop.memoryGateway.recall({ conversationId, namespace, query: text, top_k: 3, k: 3 }),
              new Promise<any>((_, reject) => setTimeout(() => reject(new Error('MemoryGateway recall 超时')), 2000)),
            ]);
            if (recallRes?.success && Array.isArray(recallRes.memories)) {
              extraMemoryGatewayMemories = recallRes.memories.map((m: any) =>
                typeof m === 'string' ? m : (m.content || m.text || JSON.stringify(m)),
              );
            }
          } catch {
            // 降级为本地
          }
        }
      }

      if (!isAvailableAI(dataRef.current, targetAgentId) || closingRef.current || (options && allRoundIdRef.current !== options.roundId)) return 'stopped';
      const replyId = uid('msg');
      const requestId = uid('req');

      // 工单 08-R2：真实请求的上下文/资料/预算/收据全部由主进程权威组装；
      // 渲染端只提交本轮文本、目标成员、会话与重试边界。本地组装仅保留给演示模式。
      const targetAgentEarly = s.agents.find((a) => a.id === targetAgentId);
      const realProfile = s.chatProfiles?.find((p) => p.id === targetAgentEarly?.profileId);
      const isRealSend = !(targetAgentEarly?.mode === 'demo' || !realProfile) && realProfile?.providerType !== 'demo';

      /** 主进程权威收据回填：按 requestId 定位占位消息，仅展示不自造 */
      const handleMemoryReceipt = (messageId: string) => (info: {
        requestId: string;
        conversationId: string;
        targetAgentId: string;
        receipt: import('../types').MemoryDeliveryReceipt;
        updatedCheckpoints?: import('../types').ContextCheckpoint[];
      }) => {
        dispatch({ type: 'patchMessage', id: messageId, patch: { memoryReceipt: info.receipt } });
        if (Array.isArray(info.updatedCheckpoints) && info.updatedCheckpoints.length > 0) {
          dispatch({ type: 'mergeCheckpoints', checkpoints: info.updatedCheckpoints });
        }
      };

      let isDemo: boolean;
      let profileSnapshot: import('../types').ChatProfile | undefined;
      let ctxMessages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [];
      let configError: string | undefined;
      let deliveryReceipt: import('../types').MemoryDeliveryReceipt | undefined;

      if (isRealSend) {
        isDemo = false;
        profileSnapshot = realProfile;
        configError = undefined;
        deliveryReceipt = undefined;
      } else {
        const local = buildContext(
          s,
          conversationId,
          targetAgentId,
          text,
          undefined,
          extraMemoryGatewayMemories,
          requestId,
        );
        isDemo = local.isDemo;
        profileSnapshot = local.profile;
        ctxMessages = local.messages;
        configError = local.configError;
        deliveryReceipt = local.deliveryReceipt;

        if (local.updatedCheckpoints && local.updatedCheckpoints.length !== (s.checkpoints?.length ?? 0)) {
          dispatch({ type: 'saveCheckpoints', checkpoints: local.updatedCheckpoints });
        }
      }

      const placeholder: Message = {
        id: replyId,
        conversationId,
        agentId: targetAgentId,
        text: '',
        createdAt: now + 1,
        status: configError ? 'error' : 'streaming',
        demo: isDemo,
        requestId,
        error: configError,
        memoryReceipt: deliveryReceipt,
      };

      if (!options || options.appendUser) dispatch({ type: 'appendMessage', message: userMessage });
      dispatch({ type: 'appendMessage', message: placeholder });
      if (!options || options.appendUser) {
        dispatch({ type: 'setDraft', conversationId, text: '' });
        dispatch({ type: 'clearAttachmentDrafts', conversationId });
      }


      if (configError) {
        // 未配置真实接口时明确拦截，绝不静默退回 Demo 假冒真实回复
        return 'error';
      }

      // 工单 08-R3 提交屏障：真实发送前必须等待当前状态（含刚追加的本轮消息、
      // 之前完成的公开回复与已提交编辑/人格变化）被主进程权威存储确认接受。
      // 工单 08-R4 P1：等待前先登记可观测的待发请求并把界面切入可停止状态；
      // 屏障有有限期限（SAVE_BARRIER_TIMEOUT_MS），失败/超时进入明确 error 终态，
      // 模型零启动、原始输入保留、可从正常入口重试；等待期停止/被替换使代次失效，
      // 迟到的保存成功不再启动模型，也不覆盖新请求状态（保存本身照常完成）。
      if (isRealSend) {
        const pending = { requestId, messageId: replyId, conversationId, cancelled: false };
        const superseded = pendingBarrierRef.current;
        if (superseded && !superseded.cancelled) {
          superseded.cancelled = true;
          dispatch({
            type: 'patchMessage',
            id: superseded.messageId,
            patch: { status: 'error' as const, error: '本轮请求已被新请求取代，未发送' },
          });
        }
        pendingBarrierRef.current = pending;
        setStream({ conversationId, messageId: replyId });

        const nextData: AppData = { ...s, messages: [...s.messages, ...(!options || options.appendUser ? [userMessage] : []), placeholder], drafts: !options || options.appendUser ? { ...s.drafts, [conversationId]: '' } : s.drafts, attachmentDrafts: !options || options.appendUser ? { ...s.attachmentDrafts, [conversationId]: [] } : s.attachmentDrafts };
        const committed = await flushSave(nextData, { timeoutMs: SAVE_BARRIER_TIMEOUT_MS });

        if (pendingBarrierRef.current === pending && pending.cancelled) {
          // 等待期间被停止：stop 已置 stopped 终态；迟到成功不得重启模型
          pendingBarrierRef.current = null;
          return 'stopped';
        }
        if (pendingBarrierRef.current !== pending) {
          // 代次已被其他请求接管，占位状态由接管方处理
          return 'stopped';
        }
        pendingBarrierRef.current = null;
        if (!committed) {
          dispatch({
            type: 'patchMessage',
            id: replyId,
            patch: { status: 'error' as const, error: '本地状态尚未提交成功，本轮请求未发起；请重试' },
          });
          setStream((cur) => (cur && cur.messageId === replyId ? null : cur));
          return 'blocked';
        }
      }

      if (options && (allRoundIdRef.current !== options.roundId || closingRef.current)) return 'stopped';
      // Only a broadcast waits for completion. Ordinary sends retain their existing lifecycle.
      const completion = options ? new Promise<ReplyOutcome>((resolve) => {
        replyWaitersRef.current.set(requestId, resolve);
      }) : undefined;

      const isDirect = conversation.kind === 'direct';
      const mode = isDirect ? 'direct' : 'living-room';
      const targetAgent = s.agents.find((a) => a.id === targetAgentId);
      const targetAgentName = targetAgent?.name || (targetAgentId === 'agent_coordinator' ? '协调者' : '伙伴');
      const participants = isDirect
        ? ['使用者', targetAgentName]
        : ['使用者', ...s.agents.map((a) => a.name)];

      bus.start({
        conversationId,
        requestId,
        messageId: replyId,
        speakerId: 'agent_owner',
        toAgentId: targetAgentId,
        text,
        messages: ctxMessages,
        profileSnapshot,
        isDemo,
        mode,
        targetAgentName,
        participants,
        ...(isRealSend ? { excludeMessageIds: [userMessage.id], onMemoryReceipt: handleMemoryReceipt(replyId) } : {}),
      });
      return completion;
    },
    [bus],
  );

  const stop = useCallback(() => {
    cancelAllRound();
    // 工单 08-R4 P1：保存屏障等待期的待发请求也纳入停止范围——
    // 占位进入明确终态（可重试），使代次失效；已提交的保存照常完成，不丢聊天。
    const pending = pendingBarrierRef.current;
    if (pending && !pending.cancelled) {
      pending.cancelled = true;
      pendingBarrierRef.current = null;
      dispatch({
        type: 'finishMessage',
        messageId: pending.messageId,
        conversationId: pending.conversationId,
        requestId: pending.requestId,
        status: 'stopped',
      });
      setStream((cur) => (cur && cur.messageId === pending.messageId ? null : cur));
      setThinking(false);
    }
    bus.cancel('user');
  }, [bus, dispatch]);

  const send = useCallback(async (conversationId: ConversationId) => {
    if (closingRef.current || !readyRef.current || (recoveryRef.current && !recoveryRef.current.discarded)) return;
    const s = dataRef.current;
    const conv = s.conversations.find((c) => c.id === conversationId);
    if (!conv) return;
    const attachments = s.attachmentDrafts?.[conversationId] ?? [];
    const raw = (s.drafts[conversationId] ?? '').trim() || (attachments.length ? '请看看我发的附件。' : '');
    if (!raw) return;
    const isAll = conv.kind === 'living-room' && (livingRoomAllRef.current || /^@(?:全部|所有人)(?=\s|$)/u.test(raw));
    // Enter during an ongoing round must not start a duplicate round.
    if (allRoundIdRef.current) {
      if (allRoundConversationRef.current === conversationId) return;
      stop();
    }
    if (!isAll) return sendOne(conversationId);
    const recipients = s.agents.filter((a) => a.kind === 'ai' && !a.removed).map((a) => a.id);
    if (!recipients.length) return;
    const roundId = uid('all');
    allRoundIdRef.current = roundId;
    allRoundConversationRef.current = conversationId;
    const userMessage: Message = {
      id: uid('msg'), conversationId, agentId: 'agent_owner',
      text: /^@(?:全部|所有人)(?=\s|$)/u.test(raw) ? raw : `@全部 ${raw}`,
      createdAt: Date.now(), status: 'sent', demo: false, requestId: null,
      ...(attachments.length ? { attachments } : {}),
    };
    let appended = false;
    try {
      for (let index = 0; index < recipients.length; index++) {
        if (allRoundIdRef.current !== roundId || closingRef.current) break;
        const agentId = recipients[index];
        if (!agentId || !isAvailableAI(dataRef.current, agentId)) continue;
        if (appended && !dataRef.current.messages.some((m) => m.id === userMessage.id)) break;
        setAllReplyRound({ id: roundId, conversationId, currentAgentId: agentId, index, total: recipients.length });
        const outcome = await sendOne(conversationId, { agentId, userMessage, appendUser: !appended, roundId });
        if (outcome === 'stopped' || outcome === 'blocked') break;
        // React must commit the previous reply before the next save/context assembly.
        await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
        appended = dataRef.current.messages.some((m) => m.id === userMessage.id);
      }
    } finally {
      if (allRoundIdRef.current === roundId) {
        allRoundIdRef.current = null;
        allRoundConversationRef.current = null;
        setAllReplyRound(null);
      }
    }
  }, [sendOne, stop]);

  /** 失败重试：沿用同一条消息，不重复插入，保留用户原始输入与历史 */
  const retry = useCallback(
    async (conversationId: ConversationId, messageId: MessageId) => {
      if (allRoundIdRef.current) stop();
      if (closingRef.current) return;
      const s = dataRef.current;
      const original = s.messages.find((m) => m.id === messageId);
      if (!original) return;
      const conversation = s.conversations.find((c) => c.id === conversationId);
      if (!conversation) return;

      const idx = s.messages.findIndex((m) => m.id === messageId);
      const prevUser = s.messages
        .slice(0, idx)
        .reverse()
        .find((m) => m.conversationId === conversationId && m.agentId === 'agent_owner');
      const text = prevUser?.text ?? '';
      if (!text || !prevUser) return;

      const prevUserIdx = s.messages.findIndex((m) => m.id === prevUser.id);

      const targetAgentId =
        conversation.kind === 'direct'
          ? conversation.agentId
          : original.agentId || livingRoomResponder(s);

      if (!targetAgentId || !isAvailableAI(s, targetAgentId)) return;

      const requestId = uid('req');

      // 工单 08-R2：真实重试同样只提交本轮文本与过去请求时间边界，上下文由主进程权威组装
      const targetAgentEarly = s.agents.find((a) => a.id === targetAgentId);
      const realProfile = s.chatProfiles?.find((p) => p.id === targetAgentEarly?.profileId);
      const isRealSend = !(targetAgentEarly?.mode === 'demo' || !realProfile) && realProfile?.providerType !== 'demo';

      const handleMemoryReceipt = (msgId: string) => (info: {
        requestId: string;
        conversationId: string;
        targetAgentId: string;
        receipt: import('../types').MemoryDeliveryReceipt;
        updatedCheckpoints?: import('../types').ContextCheckpoint[];
      }) => {
        dispatch({ type: 'patchMessage', id: msgId, patch: { memoryReceipt: info.receipt } });
        if (Array.isArray(info.updatedCheckpoints) && info.updatedCheckpoints.length > 0) {
          dispatch({ type: 'mergeCheckpoints', checkpoints: info.updatedCheckpoints });
        }
      };

      let isDemo: boolean;
      let profileSnapshot: import('../types').ChatProfile | undefined;
      let ctxMessages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [];
      let configError: string | undefined;
      let deliveryReceipt: import('../types').MemoryDeliveryReceipt | undefined;
      let cutoffTime: number | undefined;

      if (isRealSend) {
        isDemo = false;
        profileSnapshot = realProfile;
        configError = undefined;
        deliveryReceipt = undefined;
        cutoffTime = prevUser.createdAt;
      } else {
        const local = buildContext(
          s,
          conversationId,
          targetAgentId,
          text,
          prevUserIdx,
          [],
          requestId,
        );
        isDemo = local.isDemo;
        profileSnapshot = local.profile;
        ctxMessages = local.messages;
        configError = local.configError;
        deliveryReceipt = local.deliveryReceipt;

        if (local.updatedCheckpoints && local.updatedCheckpoints.length !== (s.checkpoints?.length ?? 0)) {
          dispatch({ type: 'saveCheckpoints', checkpoints: local.updatedCheckpoints });
        }
      }

      if (configError) {
        dispatch({
          type: 'patchMessage',
          id: messageId,
          patch: { status: 'error', error: configError, memoryReceipt: deliveryReceipt },
        });
        return;
      }

      dispatch({
        type: 'patchMessage',
        id: messageId,
        patch: { status: 'streaming', requestId, text: '', demo: isDemo, error: undefined, memoryReceipt: deliveryReceipt },
      });

      // 工单 08-R3 提交屏障：真实重试同样等待当前状态（含本轮占位重置与已提交编辑）被权威存储确认。
      // 工单 08-R4 P1：与 send 相同的待发请求登记/期限/停止/迟到成功语义。
      if (isRealSend) {
        const pending = { requestId, messageId, conversationId, cancelled: false };
        const superseded = pendingBarrierRef.current;
        if (superseded && !superseded.cancelled) {
          superseded.cancelled = true;
          dispatch({
            type: 'patchMessage',
            id: superseded.messageId,
            patch: { status: 'error' as const, error: '本轮请求已被新请求取代，未发送' },
          });
        }
        pendingBarrierRef.current = pending;
        setStream({ conversationId, messageId });

        const nextData: AppData = {
          ...s,
          messages: s.messages.map((m) =>
            m.id === messageId
              ? { ...m, status: 'streaming' as const, requestId, text: '', demo: false, error: undefined, memoryReceipt: undefined }
              : m,
          ),
        };
        const committed = await flushSave(nextData, { timeoutMs: SAVE_BARRIER_TIMEOUT_MS });

        if (pendingBarrierRef.current === pending && pending.cancelled) {
          pendingBarrierRef.current = null;
          return;
        }
        if (pendingBarrierRef.current !== pending) {
          return;
        }
        pendingBarrierRef.current = null;
        if (!committed) {
          dispatch({
            type: 'patchMessage',
            id: messageId,
            patch: { status: 'error' as const, error: '本地状态尚未提交成功，本轮重试未发起；请再次重试' },
          });
          setStream((cur) => (cur && cur.messageId === messageId ? null : cur));
          return;
        }
      }

      const isDirect = conversation.kind === 'direct';
      const mode = isDirect ? 'direct' : 'living-room';
      const targetAgent = s.agents.find((a) => a.id === targetAgentId);
      const targetAgentName = targetAgent?.name || (targetAgentId === 'agent_coordinator' ? '协调者' : '伙伴');
      const participants = isDirect
        ? ['使用者', targetAgentName]
        : ['使用者', ...s.agents.map((a) => a.name)];

      bus.start({
        conversationId,
        requestId,
        messageId,
        speakerId: 'agent_owner',
        toAgentId: targetAgentId,
        text,
        messages: ctxMessages,
        profileSnapshot,
        isDemo,
        mode,
        targetAgentName,
        participants,
        ...(isRealSend ? { cutoffTime, excludeMessageIds: [prevUser.id], onMemoryReceipt: handleMemoryReceipt(messageId) } : {}),
      });
    },
    [bus],
  );

  const setLivingRoomSpeaker = useCallback((agentId: AgentId | null) => {
    livingRoomAllRef.current = false;
    setLivingRoomAllState(false);
    dispatch({ type: 'setLivingRoomSpeaker', agentId });
  }, []);

  const setLivingRoomAll = useCallback(() => {
    livingRoomAllRef.current = true;
    setLivingRoomAllState(true);
  }, []);

  const saveChatProfile = useCallback((profile: ChatProfile) => {
    dispatch({ type: 'saveChatProfile', profile });
  }, []);

  const deleteChatProfile = useCallback((profileId: string) => {
    dispatch({ type: 'deleteChatProfile', profileId });
  }, []);

  const updateAgentConfig = useCallback(
    (agentId: AgentId, patch: Partial<Pick<Agent, 'mode' | 'profileId' | 'systemPrompt' | 'statusNote' | 'connected'>>) => {
      dispatch({ type: 'updateAgentConfig', agentId, patch });
    },
    [],
  );

  /** 导出：恢复提示存在时导出损坏原文；只有真正写盘成功才算成功 */
  const exportData = useCallback(async () => {
    setExportError(null);
    const current = recoveryRef.current;
    const r = await backend.export(dataRef.current, current && !current.discarded ? current.raw : null);
    if (!r.ok) setExportError(r.reason ?? '导出失败');
  }, [backend]);

  /**
 * 恢复流程：先安全保存原文，再决定去向。
 * 读不出原文时不允许「备份空字符串」后覆写真实文件，必须保持保护状态。
 */
  const preserveRaw = useCallback(async (): Promise<boolean> => {
    const current = recoveryRef.current;
    if (!current) return true;
    if (current.rawPreserved) return true;
    if (current.unreadable) {
      setPersistError('主文件无法读取，没有原文可备份。请先导出或修复该文件，窗口不会覆盖它。');
      return false;
    }
    const result = await backend.backupRaw(current.raw);
    if (!result.ok) {
      setPersistError(result.reason ?? '原文备份失败，未替换数据');
      return false;
    }
    rawPreservedRef.current = true;
    setRecovery((r) => (r ? { ...r, rawPreserved: true } : r));
    return true;
  }, [backend]);

  /** 恢复后立即提交选择结果，不依赖下一次编辑 */
  const commitAfterRecovery = useCallback(
    async (next: AppData | null) => {
      revisionRef.current += 1;
      const r = await backend.save(next ?? dataRef.current, revisionRef.current);
      if (!r.ok || !r.applied) {
        setSaveFailed(true);
        setSaved(false);
        setPersistError(r.reason ?? '恢复后的状态未能写入');
        return false;
      }
      setSaved(true);
      setSaveFailed(false);
      setPersistError(null);
      return true;
    },
    [backend],
  );

  const resolveRecovery = useCallback(
    async (blank: boolean) => {
      const current = recoveryRef.current;
      if (current && !current.discarded) {
        if (!(await preserveRaw())) return;
      }
      const next = blank ? buildEmpty() : null;
      if (next) dispatch({ type: 'hydrate', data: next });
      setRecovery(null);
      await commitAfterRecovery(next);
    },
    [commitAfterRecovery, preserveRaw],
  );

  const discardAndStartBlank = useCallback(() => {
    void resolveRecovery(true);
  }, [resolveRecovery]);

  /** 恢复最近有效副本：要求原文已安全保留，且副本通过完整校验 */
  const restoreFromBackup = useCallback(() => {
    void (async () => {
      const current = recoveryRef.current;
      if (!current) return;
      if (!(await preserveRaw())) return;

      const info = await backend.checkBackup();
      if (!info.usable) {
        setPersistError(info.reason ?? '没有可用的历史副本');
        return;
      }

      revisionRef.current += 1;
      const r = await backend.restoreBackup(revisionRef.current);
      if (!r.ok || !r.applied) {
        setPersistError(r.reason ?? '恢复失败，原文件未被改动');
        return;
      }
      const loaded = await backend.load();
      if (loaded.kind === 'ok') {
        dispatch({ type: 'hydrate', data: loaded.data });
        setRecovery(null);
        setSaved(true);
        setSaveFailed(false);
        setPersistError(null);
        setBackupUsable(false);
      } else {
        setPersistError('副本恢复后仍无法读取，请检查磁盘');
      }
    })();
  }, [backend, preserveRaw]);

  /** 用户明确放弃未保存内容后才退出 */
  const discardUnsavedAndClose = useCallback(() => {
    discardingRef.current = true;
    cancelPendingSaveRef.current?.();
    void backend.discardAndClose().then((r) => {
      if (!r.ok) {
        discardingRef.current = false;
        setCloseBlockedReason(r.reason ?? '退出请求失败，窗口保持打开');
      }
    });
  }, [backend]);

  const setTheme = useCallback((theme: ThemeId) => dispatch({ type: 'setTheme', theme }), []);

  const flushSave = useCallback(async (customSnapshot?: AppData, opts?: { timeoutMs?: number }): Promise<boolean> => {
    if (!readyRef.current || discardingRef.current) return false;
    if (recoveryRef.current && !recoveryRef.current.discarded) return false;
    pendingSaveRef.current?.();
    const snapshotToSave = customSnapshot ?? dataRef.current;
    if (customSnapshot) {
      dataRef.current = customSnapshot;
    }
    revisionRef.current += 1;
    const revision = revisionRef.current;
    try {
      const savePromise = backend.save(snapshotToSave, revision);
      const timeoutMs = opts?.timeoutMs ?? 0;
      if (timeoutMs > 0 && typeof window !== 'undefined') {
        // 工单 08-R4 P1：保存屏障有有限期限。超时只终结本轮等待并返回失败；
        // 保存本身继续在后台安全完成（已提交的聊天照常落盘，revision 保护不变）。
        let timer = 0;
        try {
          const timeoutPromise = new Promise<never>((_, reject) => {
            timer = window.setTimeout(() => reject(new Error('save-barrier-timeout')), timeoutMs);
          });
          const r = await Promise.race([savePromise, timeoutPromise]);
          if (r.ok && r.applied) {
            setSaved(true);
            setSaveFailed(false);
            setPersistError(null);
            return true;
          }
          return false;
        } finally {
          window.clearTimeout(timer);
        }
      }
      const r = await savePromise;
      if (r.ok && r.applied) {
        setSaved(true);
        setSaveFailed(false);
        setPersistError(null);
        return true;
      }
      if (!r.ok && revision >= revisionRef.current) {
        setSaved(false);
        setSaveFailed(true);
        setPersistError(r.reason ?? '写入失败');
      }
      return false;
    } catch (error) {
      if (revision >= revisionRef.current) {
        setSaved(false);
        setSaveFailed(true);
        setPersistError(`保存管道异常：${error instanceof Error ? error.message : '未知错误'}`);
      }
      return false;
    }
  }, [backend]);

  useEffect(()=>{
    const listen=window.xiaowuDesktop?.onAuthoritativeMutation;
    if(!listen)return;
    return listen(async command=>{
      if(!readyRef.current||closingRef.current||discardingRef.current||(recoveryRef.current&&!recoveryRef.current.discarded))return {ok:false,applied:false,reason:'小屋正在加载、恢复或关闭，未写入'};
      // Flush queued UI changes first; then reduce against current state. Saving
      // a disk snapshot directly here would discard unsaved live conversations.
      flushSync(()=>dispatch({type:'authorityMutation',command}));
      const applied=await flushSave(undefined,{timeoutMs:SAVE_BARRIER_TIMEOUT_MS});
      return {ok:applied,applied,...(!applied?{reason:'权威状态尚未确认保存'}:{})};
    });
  },[flushSave]);

  return {
    data,
    dispatch,
    adapter,
    ready,
    backendKind: backend.kind,
    storageHint,
    saved,
    saveFailed,
    closeBlockedReason,
    backupUsable,
    streamingConversationId: stream?.conversationId ?? null,
    streamingMessageId: stream?.messageId ?? null,
    thinking,
    livingRoomAll,
    allReplyRound,
    setLivingRoomAll,
    recovery,
    persistError,
    exportError,
    dismissRecovery: useCallback(() => void resolveRecovery(false), [resolveRecovery]),
    discardAndStartBlank,
    restoreFromBackup,
    discardUnsavedAndClose,
    dismissCloseBlocked: useCallback(() => setCloseBlockedReason(null), []),
    send,
    stop,
    retry,
    exportData,
    setTheme,
    setLivingRoomSpeaker,
    saveChatProfile,
    deleteChatProfile,
    updateAgentConfig,
    saveMemory: useCallback((memory: MemoryItem) => dispatch({ type: 'saveMemory', memory }), []),
    tombstoneMemory: useCallback((memoryId: string) => dispatch({ type: 'tombstoneMemory', memoryId }), []),
    deleteMemoryPermanently: useCallback((memoryId: string) => dispatch({ type: 'deleteMemoryPermanently', memoryId }), []),
    saveCheckpoint: useCallback((checkpoint: ContextCheckpoint) => dispatch({ type: 'saveCheckpoint', checkpoint }), []),
    updateMemoryGatewayConfig: useCallback((config: Partial<MemoryGatewayConfig>) => dispatch({ type: 'updateMemoryGatewayConfig', config }), []),
    setReadingPreferences: useCallback(
      (reading: Partial<ReadingPreferences>) => dispatch({ type: 'setReadingPreferences', reading }),
      [dispatch],
    ),
    hideMessages: useCallback((messageIds: MessageId[]) => dispatch({ type: 'hideMessagesFromWindow', messageIds }), [dispatch]),
    unhideMessages: useCallback((messageIds: MessageId[]) => dispatch({ type: 'unhideMessagesToWindow', messageIds }), [dispatch]),
    purgeMessages: useCallback(
      async (messageIds: MessageId[]) => {
        if (!Array.isArray(messageIds) || messageIds.length === 0) return true;
        // 工单 09-R1 P1：删除时无条件停止正在进行的任何流式/等待请求，杜绝迟到 delta/done 污染已删上下文
        if (streamRef.current || pendingBarrierRef.current) {
          stop();
        }
        const currentData = dataRef.current;
        const nextData = reducer(currentData, { type: 'purgeMessagesPermanently', messageIds });
        dataRef.current = nextData;
        dispatch({ type: 'purgeMessagesPermanently', messageIds });
        revisionRef.current += 1;
        const rev = revisionRef.current;
        const res = await backend.save(nextData, rev);
        if (!res.ok || res.applied === false) {
          const reason = res.reason || '永久删除保存失败或被跳过';
          setPersistError(reason);
          return false;
        }
        setPersistError(null);
        return true;
      },
      [backend, dispatch, stop],
    ),
    flushSave,
  };
}

export type AppStore = ReturnType<typeof useAppStore>;
