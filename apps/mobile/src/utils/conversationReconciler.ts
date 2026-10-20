/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * Luma Mobile Members R4 - 会话状态多会话映射与消息对账核销器
 * 核心原则：
 * 1. 任务完成 (Job done) 与远端历史对账 (Reconciliation) 彻底分离：
 *    - Job done 后本地项标记为 sent，记录 reply 与 userMessageId；
 *    - 无论远端 GET messages 是否暂时为空，本地用户原话与答复绝不丢弃，继续保留展示与可恢复状态；
 *    - 仅当远端历史中真正返回对应项（按 id、userMessageId 或 requestId）时才核销本地项；
 * 2. 消费 userMessageId 合同 (合同 B)，同时支持 requestId 合同 (合同 A)；
 * 3. 严禁以文本内容相同 (content 盲猜) 删消息；
 * 4. A→B→A 切换草稿与消息状态隔离，旧会话状态更新独立于当前活动 UI 屏障，保留 requestId，支持重试与恢复。
 */

import { Message, MessageDto } from '../types';
import { persistVoice } from './voiceCache';

const memoryMediaCache = new Map<string, string>();

export function getCachedMedia(key?: string): string | undefined {
  if (!key) return undefined;
  if (memoryMediaCache.has(key)) return memoryMediaCache.get(key);
  try {
    const stored = localStorage.getItem(`luma_media_${key}`);
    if (stored) {
      memoryMediaCache.set(key, stored);
      return stored;
    }
  } catch {}
  return undefined;
}

export function setCachedMedia(key: string, dataUrl: string): void {
  if (!key || !dataUrl) return;
  memoryMediaCache.set(key, dataUrl);
  try {
    if (dataUrl.length < 350000) {
      localStorage.setItem(`luma_media_${key}`, dataUrl);
    }
  } catch {}
}

export interface CachedVoiceData {
  audioUrl: string;
  audioDuration: number;
  voiceTranscription?: string;
}

const memoryVoiceCache = new Map<string, CachedVoiceData>();

export function getCachedVoice(key?: string): CachedVoiceData | undefined {
  if (!key) return undefined;
  return memoryVoiceCache.get(key);
}

export function setCachedVoice(key: string, data: CachedVoiceData, persist = true): void {
  if (!key || !data) return;
  memoryVoiceCache.set(key, data);
  if (persist) void persistVoice(key, data).catch(() => {});
}

/** Retry the original media, including previews retained after an ambiguous RPC failure. */
export function restoreRetryMedia(message: Message) {
  const image = message.image || getCachedMedia(message.id) || getCachedMedia(message.requestId);
  const file = message.fileAttachment;
  const attachment = image
    ? { type: 'image' as const, name: message.imageName || message.attachments?.find(a => a.kind === 'image')?.name || 'photo.jpg', size: 0, dataUrl: image }
    : file?.dataUrl
      ? { type: 'file' as const, name: file.name, size: file.size || 0, dataUrl: file.dataUrl }
      : undefined;
  const voice = message.audioUrl
    ? { audioUrl: message.audioUrl, audioDuration: message.audioDuration || 0, voiceTranscription: message.voiceTranscription || message.content }
    : getCachedVoice(message.id) || getCachedVoice(message.requestId);
  const voiceMeta = voice ? { ...voice, voiceTranscription: voice.voiceTranscription || message.content } : undefined;
  return { ...(attachment ? { attachment } : {}), ...(voiceMeta ? { voiceMeta } : {}) };
}

export interface LocalSessionState {
  conversationId?: string;
  agentId: string;
  draftText: string;
  unsentMessages: Message[];
  completedRequestIds: Set<string>;
  reconciledRequestIds: Set<string>; // 保持向后兼容
}

export class SessionStateManager {
  private sessionsByConvId: Map<string, LocalSessionState> = new Map();
  private draftsByAgentId: Map<string, string> = new Map();

  /**
   * 获取或初始化指定 conversationId 的会话状态
   */
  public getOrCreateSession(conversationId: string, agentId: string): LocalSessionState {
    let session = this.sessionsByConvId.get(conversationId);
    if (!session) {
      const pendingDraft = this.draftsByAgentId.get(agentId) || '';
      session = {
        conversationId,
        agentId,
        draftText: pendingDraft,
        unsentMessages: [],
        completedRequestIds: new Set<string>(),
        reconciledRequestIds: new Set<string>(),
      };
      this.sessionsByConvId.set(conversationId, session);
    }
    return session;
  }

  /**
   * 保存会话草稿：优先按真实 conversationId，若未解析出则按 agentId 暂存
   */
  public saveDraft(identifier: { conversationId?: string | null; agentId: string }, draft: string): void {
    if (identifier.conversationId) {
      const session = this.getOrCreateSession(identifier.conversationId, identifier.agentId);
      session.draftText = draft;
    } else {
      this.draftsByAgentId.set(identifier.agentId, draft);
    }
  }

  /**
   * 读取会话草稿
   */
  public getDraft(identifier: { conversationId?: string | null; agentId: string }): string {
    if (identifier.conversationId) {
      const session = this.sessionsByConvId.get(identifier.conversationId);
      if (session) {
        return session.draftText;
      }
    }
    return this.draftsByAgentId.get(identifier.agentId) || '';
  }

  /**
   * 添加本地未确认/失败消息到指定会话
   */
  public addUnsentMessage(conversationId: string, agentId: string, message: Message): void {
    const session = this.getOrCreateSession(conversationId, agentId);
    const existingIdx = session.unsentMessages.findIndex((m) => m.id === message.id);
    if (existingIdx >= 0) {
      session.unsentMessages[existingIdx] = message;
    } else {
      session.unsentMessages.push(message);
    }
  }

  /**
   * 更新本地未发送消息（如状态变为 failed，记录错误原因；或关联 jobId / userMessageId）
   */
  public updateUnsentMessage(
    conversationId: string,
    messageId: string,
    updates: Partial<Message>
  ): void {
    const session = this.sessionsByConvId.get(conversationId);
    if (!session) return;
    const msg = session.unsentMessages.find((m) => m.id === messageId);
    if (msg) {
      Object.assign(msg, updates);
    }
  }

  /**
   * 标记 Job 已在后端完成执行 (Job Done)
   * 将本地消息状态置为 sent，暂存服务端回传的 reply 与 userMessageId。
   * 注意：这并不等同于历史已对账，如果远端 GET messages 暂时为空，本地原话与 reply 依然必须保留展示！
   */
  public markJobCompleted(
    conversationId: string,
    requestId: string,
    reply?: { id: string; agentId: string; content: string; createdAt: string },
    userMessageId?: string
  ): void {
    const session = this.sessionsByConvId.get(conversationId);
    if (session) {
      session.completedRequestIds.add(requestId);
      const msg = session.unsentMessages.find((m) => m.requestId === requestId);
      if (msg) {
        msg.status = 'sent';
        if (userMessageId) msg.userMessageId = userMessageId;
        if (reply) msg.reply = reply;
      }
    }
  }

  /**
   * 兼容方法：旧代码调用的 markRequestReconciled
   */
  public markRequestReconciled(conversationId: string, requestId: string): void {
    const session = this.sessionsByConvId.get(conversationId);
    if (session) {
      session.completedRequestIds.add(requestId);
      session.reconciledRequestIds.add(requestId);
      const msg = session.unsentMessages.find((m) => m.requestId === requestId);
      if (msg && msg.status === 'pending') {
        msg.status = 'sent';
      }
    }
  }

  /**
   * 获取指定会话中的本地未核销消息列表
   */
  public getUnsentMessages(conversationId: string): Message[] {
    return this.sessionsByConvId.get(conversationId)?.unsentMessages || [];
  }

  /**
   * 设置本地未核销消息列表（例如在对账后剔除已核销项）
   */
  public setUnsentMessages(conversationId: string, messages: Message[]): void {
    const session = this.sessionsByConvId.get(conversationId);
    if (session) {
      session.unsentMessages = messages;
    }
  }
}

export interface ReconcileResult {
  mergedMessages: Message[];
  remainingUnsent: Message[];
  reconciledCount: number;
}

/**
 * 核心对账归并函数：
 * 将服务端权威历史与本地未核销项安全归并。
 * 遵循严格原则：
 * 1. 远端历史具备绝对权威；
 * 2. 精确核销判定：只有当远端真正返回匹配记录时，才将本地项标记为已核销并移出未对账列表：
 *    a) local.id === remote.id (本地临时 ID 恰好被服务端沿用)；
 *    b) local.userMessageId && remote.id === local.userMessageId (消费 userMessageId 合同 B)；
 *    c) local.requestId && remote.requestId === local.requestId (合同 A：远端回传 requestId)；
 * 3. 绝不因为任务状态变为 done，在远端历史为空时误将本地消息删除！
 *    若远端 GET messages 暂未返回对应项，本地原话（和已收到的 reply）必须 100% 保留在 mergedMessages 中展示；
 * 4. 严禁以 content 文本相同盲猜删消息，防止用户连发两条相同文本时误删；
 * 5. 剩余未核销项（pending / sent 等待对账 / failed），完整保留并追加展示；重试时严守原 requestId。
 */
export function reconcileMessages(
  remoteMessages: MessageDto[],
  localUnsent: Message[],
  reconciledRequestIdsOrTargetConvId?: Set<string> | string,
  targetConversationIdOrResolver?: string | ((agentId: string, isUser: boolean) => string),
  resolveSenderNameArg?: (agentId: string, isUser: boolean) => string
): ReconcileResult {
  // 处理灵活重载签名
  let targetConversationId = '';
  let resolveSenderName: ((agentId: string, isUser: boolean) => string) | undefined;

  if (typeof reconciledRequestIdsOrTargetConvId === 'string') {
    targetConversationId = reconciledRequestIdsOrTargetConvId;
    if (typeof targetConversationIdOrResolver === 'function') {
      resolveSenderName = targetConversationIdOrResolver;
    }
  } else {
    // 兼容旧调用签名: (remoteMessages, localUnsent, reconciledRequestIds, targetConversationId, resolveSenderName)
    if (typeof targetConversationIdOrResolver === 'string') {
      targetConversationId = targetConversationIdOrResolver;
    }
    if (typeof resolveSenderNameArg === 'function') {
      resolveSenderName = resolveSenderNameArg;
    }
  }

  const remoteIdSet = new Set(remoteMessages.map((m) => m.id));
  const remoteRequestIdSet = new Set(
    remoteMessages.map((m) => m.requestId).filter(Boolean) as string[]
  );

  let reconciledCount = 0;
  const remainingUnsent: Message[] = [];

  for (const localMsg of localUnsent) {
    let isReconciled = false;

    // 判定 1: 权威 ID 命中
    if (remoteIdSet.has(localMsg.id)) {
      isReconciled = true;
    }
    // 判定 2: 消费 userMessageId 合同 (服务端生成的权威用户消息 ID)
    else if (localMsg.userMessageId && remoteIdSet.has(localMsg.userMessageId)) {
      isReconciled = true;
    }
    // 判定 3: 合同 requestId 精准对账命中
    else if (localMsg.requestId && remoteRequestIdSet.has(localMsg.requestId)) {
      isReconciled = true;
    }

    // 关键修正：绝不根据 completedRequestIds 或 reconciledRequestIds 在远端为空时核销！
    // 只有远端真正匹配上（isReconciled === true），才算核销！

    if (isReconciled) {
      reconciledCount++;
    } else {
      // 远端暂无匹配：绝不删除！保留原话及状态
      remainingUnsent.push(localMsg);
    }
  }

  // 建立本地未核销消息的索引，确保图片、文件附件和引用信息在对账后完整继承
  const localIndexMap = new Map<string, Message>();
  for (const localMsg of localUnsent) {
    if (localMsg.id) localIndexMap.set(localMsg.id, localMsg);
    if (localMsg.userMessageId) localIndexMap.set(localMsg.userMessageId, localMsg);
    if (localMsg.requestId) localIndexMap.set(localMsg.requestId, localMsg);
    if (localMsg.image) {
      if (localMsg.id) setCachedMedia(localMsg.id, localMsg.image);
      if (localMsg.requestId) setCachedMedia(localMsg.requestId, localMsg.image);
      if (localMsg.userMessageId) setCachedMedia(localMsg.userMessageId, localMsg.image);
    }
  }

  // 映射服务端权威消息为视图 Message 结构
  const mappedRemote: Message[] = remoteMessages.map((m) => {
    const isUser = m.role === 'user' || m.agentId === 'agent_owner' || m.agentId === 'user';
    const senderName = resolveSenderName
      ? resolveSenderName(m.agentId, isUser)
      : isUser
      ? '使用者（我）'
      : '成员';

    const candidateLocal = localIndexMap.get(m.id) || (m.requestId ? localIndexMap.get(m.requestId) : undefined);
    // User and partner replies share requestId. Never attach the user's recording
    // (or quoted media) to the partner's message through that shared round ID.
    const localMatch = candidateLocal?.isUser === isUser ? candidateLocal : undefined;
    const roundImage = getCachedMedia(m.requestId);
    const cachedImage = getCachedMedia(m.id);
    const ownImage = isUser || m.attachments?.some(a => a.kind === 'image') || cachedImage !== roundImage ? cachedImage : undefined;
    const restoredImage = localMatch?.image || ownImage || (isUser ? roundImage : undefined);
    if (restoredImage && m.id) {
      setCachedMedia(m.id, restoredImage);
    }

    const cachedVoice = getCachedVoice(m.id) || (isUser && m.requestId ? getCachedVoice(m.requestId) : undefined) || (localMatch?.audioUrl ? {
      audioUrl: localMatch.audioUrl,
      audioDuration: localMatch.audioDuration || 3,
      voiceTranscription: localMatch.voiceTranscription,
    } : undefined);
    if (cachedVoice && m.id) {
      setCachedVoice(m.id, cachedVoice);
    }

    return {
      id: m.id,
      conversationId: targetConversationId,
      senderId: m.agentId,
      senderName,
      content: m.content,
      timestamp: formatIsoTimestamp(m.createdAt),
      createdAt: m.createdAt,
      isUser,
      status: m.status || 'sent',
      errorReason: m.error,
      requestId: m.requestId,
      sourceChannel: m.sourceChannel,
      eventKind: m.eventKind,
      image: restoredImage,
      imageName: localMatch?.imageName,
      fileAttachment: localMatch?.fileAttachment,
      hiddenReplyParts: m.hiddenReplyParts,
      audioUrl: cachedVoice?.audioUrl || localMatch?.audioUrl,
      audioDuration: cachedVoice?.audioDuration || localMatch?.audioDuration,
      voiceTranscription: cachedVoice?.voiceTranscription || localMatch?.voiceTranscription,
      attachments: m.attachments,
      quote: localMatch?.quote,
      isFavorite: localMatch?.isFavorite,
    };
  });

  // 检查 remainingUnsent 中已执行完毕但远端历史尚未包含的答复 (reply)
  const pendingReplies: Message[] = [];
  for (const localMsg of remainingUnsent) {
    if (localMsg.reply && !remoteIdSet.has(localMsg.reply.id)) {
      const replyAgentId = localMsg.reply.agentId;
      const isUser = false;
      const senderName = resolveSenderName
        ? resolveSenderName(replyAgentId, isUser)
        : '成员';

      pendingReplies.push({
        id: localMsg.reply.id,
        conversationId: targetConversationId,
        senderId: replyAgentId,
        senderName,
        content: localMsg.reply.content,
        timestamp: formatIsoTimestamp(localMsg.reply.createdAt),
        createdAt: localMsg.reply.createdAt,
        isUser: false,
        status: 'sent',
      });
    }
  }

  // 合并结果：远端权威历史 + 本地尚未核销/失败项 + 本地暂存答复
  const mergedMessages = [...mappedRemote, ...remainingUnsent, ...pendingReplies];

  return {
    mergedMessages,
    remainingUnsent,
    reconciledCount,
  };
}

function formatIsoTimestamp(isoString?: string): string {
  if (!isoString) {
    const now = new Date();
    return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  }
  try {
    const date = new Date(isoString);
    if (isNaN(date.getTime())) return '';
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    return `${hours}:${minutes}`;
  } catch {
    return '';
  }
}
