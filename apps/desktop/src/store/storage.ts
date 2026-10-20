import {
  STORAGE_KEY,
  STORAGE_VERSION,
  type AppData,
  DEFAULT_READING_PREFERENCES,
  type ReadingPreferences,
  type FontFamilyOption,
} from '../types';
import { validAttachments } from '../utils/attachments';

export type LoadResult =
  | { kind: 'ok'; data: AppData }
  | { kind: 'empty' }
  | { kind: 'recovered'; data: AppData | null; reason: string; raw: string; unreadable?: boolean };

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const timestamp = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 8.64e15;
const nullableId = (v: unknown) => v === null || typeof v === 'string';
const uniqueIds = (items: { id: string }[]) => new Set(items.map((item) => item.id)).size === items.length;

/**
 * 结构校验：只做形状检查，缺失的可选集合补空数组。
 * 校验失败不静默清空，而是把损坏原文回传给调用方展示恢复提示。
 */
export function validateData(value: unknown): { ok: true; data: AppData } | { ok: false; reason: string } {
  if (!value || typeof value !== 'object') return { ok: false, reason: '根节点不是对象' };
  const d = value as Partial<AppData>;
  if ((Array.isArray(d.messages) && d.messages.some(m => m && m.attachments !== undefined && !validAttachments(m.attachments))) || (d.attachmentDrafts !== undefined && (!record(d.attachmentDrafts) || !Object.values(d.attachmentDrafts).every(validAttachments)))) return { ok: false, reason: '附件引用数据损坏' };

  if (typeof d.version !== 'number' || !Number.isInteger(d.version) || d.version < 1) return { ok: false, reason: '缺少有效版本号' };
  if (d.version > STORAGE_VERSION) return { ok: false, reason: `数据版本 ${d.version} 高于当前程序支持的 ${STORAGE_VERSION}` };
  if (!Array.isArray(d.agents) || !Array.isArray(d.conversations)) return { ok: false, reason: '成员或会话列表缺失' };
  if (!Array.isArray(d.messages) || !Array.isArray(d.tickets)) return { ok: false, reason: '消息或工单列表缺失' };
  if (!d.preferences || typeof d.preferences.theme !== 'string') return { ok: false, reason: '偏好设置缺失' };
  if (!['fusion', 'day', 'night'].includes(d.preferences.theme)) return { ok: false, reason: '偏好主题无效' };
  if (!d.agents.every((a) => record(a) && typeof a.id === 'string' && typeof a.name === 'string' && typeof a.initial === 'string' && ['human', 'ai'].includes(a.kind) && typeof a.connected === 'boolean' && typeof a.accent === 'string' && typeof a.statusNote === 'string') || !uniqueIds(d.agents)) return { ok: false, reason: '成员数据损坏' };
  if (!d.conversations.every((c) => record(c) && typeof c.id === 'string' && typeof c.title === 'string' && ['living-room', 'direct'].includes(c.kind) && nullableId(c.agentId) && timestamp(c.createdAt)) || !uniqueIds(d.conversations)) return { ok: false, reason: '会话数据损坏' };
  if (!d.messages.every((m) => record(m) && typeof m.id === 'string' && typeof m.conversationId === 'string' && typeof m.agentId === 'string' && typeof m.text === 'string' && timestamp(m.createdAt) && ['sent', 'streaming', 'stopped', 'error'].includes(m.status) && typeof m.demo === 'boolean' && nullableId(m.requestId)) || !uniqueIds(d.messages)) return { ok: false, reason: '消息数据损坏' };
  if (!d.tickets.every((t) => record(t) && typeof t.id === 'string' && typeof t.title === 'string' && typeof t.goal === 'string' && isStringArray(t.participantIds) && Array.isArray(t.tasks) && t.tasks.every((task) => record(task) && typeof task.id === 'string' && typeof task.title === 'string' && ['todo', 'doing', 'review', 'done'].includes(task.status) && nullableId(task.assigneeId)) && uniqueIds(t.tasks) && record(t.discussion) && typeof t.discussion.text === 'string' && timestamp(t.discussion.updatedAt) && record(t.artifacts) && typeof t.artifacts.text === 'string' && timestamp(t.artifacts.updatedAt) && timestamp(t.updatedAt)) || !uniqueIds(d.tickets)) return { ok: false, reason: '工单数据损坏' };
  if (d.drafts !== undefined && (!record(d.drafts) || !Object.values(d.drafts).every((v) => typeof v === 'string'))) return { ok: false, reason: '会话草稿损坏' };
  if (d.chatProfiles !== undefined && (!Array.isArray(d.chatProfiles) || !d.chatProfiles.every((p) => {
    if (!record(p) || typeof p.id !== 'string' || typeof p.name !== 'string') return false;
    if (p.providerType === 'codex-app-server') return true;
    return typeof p.baseUrl === 'string' && typeof p.model === 'string' && ['openai-compatible', 'demo'].includes(p.providerType as string);
  }))) {
    return { ok: false, reason: '模型服务配置损坏' };
  }
  if (d.livingRoomSpeakerId !== undefined && d.livingRoomSpeakerId !== null && typeof d.livingRoomSpeakerId !== 'string') {
    return { ok: false, reason: '客厅发言人标识无效' };
  }
  // 校验 memories 集合
  if (d.memories !== undefined) {
    if (!Array.isArray(d.memories) || !d.memories.every((m) =>
      record(m) &&
      typeof m.id === 'string' &&
      record(m.scope) &&
      typeof m.scope.type === 'string' &&
      ['direct', 'living-room', 'ticket'].includes(m.scope.type) &&
      typeof m.authorAgentId === 'string' &&
      typeof m.content === 'string' &&
      timestamp(m.createdAt)
    ) || !uniqueIds(d.memories)) {
      return { ok: false, reason: '长时记忆数据损坏' };
    }
  }
  // 校验 checkpoints 集合
  if (d.checkpoints !== undefined) {
    if (!Array.isArray(d.checkpoints) || !d.checkpoints.every((c) =>
      record(c) &&
      typeof c.id === 'string' &&
      typeof c.conversationId === 'string' &&
      typeof c.summary === 'string' &&
      typeof c.createdBeforeMessageId === 'string' &&
      timestamp(c.createdAt)
    ) || !uniqueIds(d.checkpoints)) {
      return { ok: false, reason: '上下文检查点数据损坏' };
    }
  }
  // 校验 memoryGatewayConfig
  if (d.memoryGatewayConfig !== undefined && d.memoryGatewayConfig !== null) {
    if (!record(d.memoryGatewayConfig) ||
      typeof d.memoryGatewayConfig.enabled !== 'boolean' ||
      typeof d.memoryGatewayConfig.baseUrl !== 'string' ||
      typeof d.memoryGatewayConfig.credentialRef !== 'string') {
      return { ok: false, reason: 'MemoryGateway 服务配置损坏' };
    }
  }
  if (typeof d.activeConversationId !== 'string' || d.activeConversationId.length === 0) {
    return { ok: false, reason: '缺少当前会话 ID' };
  }
  if (!d.conversations.some((c) => c.id === d.activeConversationId)) return { ok: false, reason: '当前会话不存在' };
  if (!d.conversations.some((c) => c.id === 'conv_living_room') || !d.agents.some((a) => a.id === 'agent_owner')) return { ok: false, reason: '基础成员或客厅缺失' };

  const rawReading = d.preferences.reading;
  const validFamily: FontFamilyOption[] = ['system', 'sans-serif', 'serif', 'monospace'];
  const sanitizedReading: ReadingPreferences = {
    fontFamily: (rawReading && validFamily.includes(rawReading.fontFamily)) ? rawReading.fontFamily : DEFAULT_READING_PREFERENCES.fontFamily,
    fontSize: (rawReading && typeof rawReading.fontSize === 'number' && Number.isFinite(rawReading.fontSize))
      ? Math.max(12, Math.min(22, Math.round(rawReading.fontSize)))
      : DEFAULT_READING_PREFERENCES.fontSize,
    lineHeight: (rawReading && typeof rawReading.lineHeight === 'number' && Number.isFinite(rawReading.lineHeight))
      ? Math.max(1.3, Math.min(2.0, Number(rawReading.lineHeight.toFixed(2))))
      : DEFAULT_READING_PREFERENCES.lineHeight,
    messageSpacing: (rawReading && typeof rawReading.messageSpacing === 'number' && Number.isFinite(rawReading.messageSpacing))
      ? Math.max(4, Math.min(24, Math.round(rawReading.messageSpacing)))
      : DEFAULT_READING_PREFERENCES.messageSpacing,
    customFontCss: typeof rawReading?.customFontCss === 'string' ? rawReading.customFontCss.slice(0, 20000) : undefined,
    customFontStyle: typeof rawReading?.customFontStyle === 'string' ? rawReading.customFontStyle.slice(0, 2000000) : undefined,
  };

  const purgedIds = Array.isArray(d.purgedMessageIds) ? d.purgedMessageIds.filter((x): x is string => typeof x === 'string') : [];
  const purgedSet = new Set(purgedIds);
  const purgedThreadIds = Array.isArray(d.purgedThreadIds) ? d.purgedThreadIds.filter((x): x is string => typeof x === 'string') : [];
  const purgedThreadSet = new Set(purgedThreadIds);

  const cleanAgents = d.agents.map((a) => {
    if (a.canonicalCodexThreadId && purgedThreadSet.has(a.canonicalCodexThreadId)) {
      const copy = { ...a };
      delete copy.canonicalCodexThreadId;
      return copy;
    }
    return a;
  });

  const cleanConversations = d.conversations.map((c) => {
    if (c.codexThreadId && purgedThreadSet.has(c.codexThreadId)) {
      const copy = { ...c };
      delete copy.codexThreadId;
      return copy;
    }
    return c;
  });

  const cleanProfiles = (Array.isArray(d.chatProfiles) ? d.chatProfiles : []).map((p) => {
    let copy = { ...p };
    let mod = false;
    if (copy.codexThreadId && purgedThreadSet.has(copy.codexThreadId)) {
      delete copy.codexThreadId;
      mod = true;
    }
    if (copy.canonicalCodexThreadId && purgedThreadSet.has(copy.canonicalCodexThreadId)) {
      delete copy.canonicalCodexThreadId;
      mod = true;
    }
    return mod ? copy : p;
  });

  return {
    ok: true,
    data: {
      version: d.version!,
      preferences: {
        theme: d.preferences.theme,
        motion: d.preferences.motion !== false,
        scenic: d.preferences.scenic === true,
        reading: sanitizedReading,
      },
      agents: cleanAgents,
      conversations: cleanConversations,
      // 重启没有正在运行的网络请求，不能恢复成永远生成中的气泡；墓碑已记录的消息绝对拒绝恢复
      messages: d.messages
        .filter((m) => !purgedSet.has(m.id))
        .map((m) => m.status === 'streaming' ? { ...m, status: 'stopped' } : m),
      tickets: d.tickets,
      drafts: d.drafts && typeof d.drafts === 'object' ? d.drafts : {},
      attachmentDrafts: d.attachmentDrafts,
      seeded: d.seeded === true,
      activeConversationId: d.activeConversationId,
      activeTicketId: d.tickets.some((t) => t.id === d.activeTicketId) ? d.activeTicketId! : null,
      workbenchOpen: d.workbenchOpen !== false,
      chatProfiles: cleanProfiles,
      livingRoomSpeakerId: typeof d.livingRoomSpeakerId === 'string' ? d.livingRoomSpeakerId : null,
      memories: Array.isArray(d.memories) ? d.memories : [],
      memoryTombstones: Array.isArray(d.memoryTombstones) ? d.memoryTombstones : [],
      checkpoints: Array.isArray(d.checkpoints) ? d.checkpoints : [],
      memoryGatewayConfig: d.memoryGatewayConfig && typeof d.memoryGatewayConfig === 'object' ? d.memoryGatewayConfig : undefined,
      memoryGatewayOutbox: Array.isArray(d.memoryGatewayOutbox) ? d.memoryGatewayOutbox : [],
      purgedMessageIds: purgedIds,
      purgedMessageEpoch: typeof d.purgedMessageEpoch === 'number' ? d.purgedMessageEpoch : 0,
      purgedThreadIds,
    },
  };
}

/** 恢复决定前保留原文；备份失败时调用方必须保持只读，不能替换原数据。 */
export function backupRecovery(storage: StorageLike | null, raw: string): { ok: boolean; reason?: string } {
  if (!storage) return { ok: false, reason: '无法访问本地存储，未替换原文' };
  try {
    if (raw) storage.setItem(`${STORAGE_KEY}.recovery.${Date.now()}`, raw);
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: `原文备份失败，未替换数据：${error instanceof Error ? error.message : '写入失败'}` };
  }
}

export function loadData(storage: StorageLike | null): LoadResult {
  if (!storage) return { kind: 'empty' };
  let raw: string | null;
  try {
    raw = storage.getItem(STORAGE_KEY);
  } catch {
    return { kind: 'recovered', data: null, reason: '无法读取本地存储（可能是隐私模式或存储被禁用）', raw: '', unreadable: true };
  }
  if (raw === null || raw === '') return { kind: 'empty' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: 'recovered', data: null, reason: '本地数据不是合法 JSON', raw };
  }

  const result = validateData(parsed);
  if (!result.ok) return { kind: 'recovered', data: null, reason: result.reason, raw };
  return { kind: 'ok', data: result.data };
}

export function saveData(storage: StorageLike | null, data: AppData): { ok: boolean; reason?: string } {
  if (!storage) return { ok: false, reason: '当前环境没有本地存储' };
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(data));
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : '写入失败' };
  }
}

/** 导出用：带命名空间与元信息，方便以后人工检查 */
export function buildExport(data: AppData) {
  return {
    exportedAt: new Date().toISOString(),
    namespace: STORAGE_KEY,
    version: data.version,
    note: '小屋本地数据导出。导出文件仅保存在本机，不经外部中转；发给真实接口的聊天内容受各成员连接设置约束。',
    data,
  };
}

export const __testables = { isStringArray };
