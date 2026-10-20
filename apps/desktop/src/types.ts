/** 小屋基础数据模型。UI / 本地数据 / 模型传输三层分离，ID 一律稳定，不用显示名当主键。 */

export type AgentId = string;
export interface MessageAttachment {
  id: string;
  name: string;
  kind: 'image' | 'text';
  mimeType: string;
  size: number;
  truncated?: boolean;
}

export type ProviderType = 'openai-compatible' | 'demo' | 'codex-app-server';

export interface ChatProfile {
  id: string;
  name: string;
  providerType: ProviderType;
  baseUrl: string;
  model: string;
  credentialRef: string;
  maxTokens?: number;
  temperature?: number;
  contextLimit?: number;
  /** Codex app-server 专属配置 */
  codexModel?: string;
  codexCwd?: string;
  codexThreadId?: string;
  canonicalCodexThreadId?: string;
  developerInstructions?: string;
  instructionSources?: any[];
  lastVerifiedAt?: string | null;
  lastVerifiedStatus?: 'success' | 'failed' | null;
  lastVerifiedError?: string | null;
}

export interface ModelCatalogItem {
  id: string;
  name: string;
  context_length?: number;
  pricing?: { prompt?: string; completion?: string } | null;
  description?: string;
}

export interface ModelCatalogResult {
  ok: boolean;
  provider?: string;
  models?: ModelCatalogItem[];
  truncated?: boolean;
  error?: string;
}

export interface Agent {
  id: AgentId;
  name: string;
  /** 头像未提供时用姓名首字，不伪造人物肖像 */
  initial: string;
  /** 本地导入后缩放的头像，内嵌数据跟随本地配置保存 */
  avatarDataUrl?: string;
  /** 仅从可用成员中移除；完整本地资料、聊天和记忆保留，可恢复。 */
  removed?: boolean;
  kind: 'human' | 'ai';
  /** 后续接入真实服务时填；本原型全部为 false */
  connected: boolean;
  /** 工单要求的说明文案，用于避免把未接入的成员说成在线 */
  statusNote: string;
  accent: string;
  /** 模式：'demo' 演示模式 或 'real' 真实接口 */
  mode?: 'demo' | 'real';
  /** 绑定的服务配置 ID */
  profileId?: string | null;
  /** 成员独立系统人格 */
  systemPrompt?: string;
  /** 工单 07：成员个人 canonical Codex thread ID，跨私聊与客厅共用此连续会话 */
  canonicalCodexThreadId?: string;
  instructionSources?: any[];
}

export type ConversationId = string;
export type ConversationKind = 'living-room' | 'direct';

export interface Conversation {
  id: ConversationId;
  kind: ConversationKind;
  /** direct 会话指向唯一成员；living-room 为 null */
  agentId: AgentId | null;
  title: string;
  createdAt: number;
  /** 会话绑定的专属 Codex thread ID，重开后恢复同一上下文 */
  codexThreadId?: string;
  instructionSources?: any[];
}

export type MessageId = string;
export type MessageStatus = 'sent' | 'streaming' | 'stopped' | 'error';

export interface Message {
  id: MessageId;
  conversationId: ConversationId;
  agentId: AgentId;
  text: string;
  createdAt: number;
  status: MessageStatus;
  /** 演示回复为 true，界面上必须标明演示 */
  demo: boolean;
  /** 绑定请求，用于丢弃迟到的回复 */
  requestId: string | null;
  sourceChannel?: 'luma' | 'xiaodu';
  eventKind?: 'device-event';
  error?: string;
  /** 工单 08-R3：原话修订版本时间——过去请求（cutoffTime）早于该时间的改写不可证明，明确排除 */
  editedAt?: number;
  /** 工单 08：可审计的交付收据与记忆参考记录 */
  memoryReceipt?: MemoryDeliveryReceipt;
  /** 工单 09：从窗口删除（保留记忆） */
  hiddenFromWindow?: boolean;
  /** Presentation-only hidden split bubbles; original text remains in memory. */
  hiddenReplyParts?: string[];
  /** 工单 09：客厅发言针对的目标成员（稳定 recipient/target 归属） */
  targetAgentId?: AgentId;
  attachments?: MessageAttachment[];
}


export type TicketId = string;
export type TaskStatus = 'todo' | 'doing' | 'review' | 'done';

export interface TaskItem {
  id: string;
  title: string;
  status: TaskStatus;
  assigneeId: AgentId | null;
  acceptance?: string;
  execution?: Record<string, unknown>;
}

export interface Artifact {
  updatedAt: number;
  text: string;
}

export interface Ticket {
  id: TicketId;
  title: string;
  goal: string;
  /** 仅记录分工，不代表真实远端 AI 已执行 */
  participantIds: AgentId[];
  tasks: TaskItem[];
  discussion: Artifact;
  artifacts: Artifact;
  updatedAt: number;
  origin?: {
    conversationId: string;
    agentId: string;
    requestId: string;
  };
  originReported?: boolean;
  coordinatorCreation?: { requestId: string; payloadHash: string };
  reviewDecisions?: Array<{ jobId: string; taskId: string; requestId: string; reason: string; attemptId: string; reportId: string; at: number }>;
}

export type ThemeId = 'fusion' | 'day' | 'night';

export type FontFamilyOption = 'system' | 'sans-serif' | 'serif' | 'monospace';

export interface ReadingPreferences {
  fontFamily: FontFamilyOption;
  fontSize: number;       // 12 - 22, 默认 15
  lineHeight: number;     // 1.3 - 2.0, 默认 1.6
  messageSpacing: number; // 4 - 24, 默认 12
  customFontCss?: string;
  customFontStyle?: string;
}

export const DEFAULT_READING_PREFERENCES: ReadingPreferences = {
  fontFamily: 'system',
  fontSize: 15,
  lineHeight: 1.6,
  messageSpacing: 12,
};

export interface Preferences {
  theme: ThemeId;
  motion: boolean;
  /** 看风景模式 */
  scenic: boolean;
  /** 工单 09：聊天阅读设置 */
  reading?: ReadingPreferences;
}

export type MemoryScopeType = 'direct' | 'living-room' | 'ticket';

export interface MemoryScope {
  type: MemoryScopeType;
  /** direct 时为 agentId，ticket 时为 ticketId，living-room 时为 'living-room' 或 null */
  id?: string | null;
}

export interface MemoryItem {
  id: string;
  scope: MemoryScope;
  authorAgentId: AgentId;
  title?: string;
  content: string;
  tags?: string[];
  createdAt: number;
  updatedAt: number;
  tombstoned?: boolean;
  tombstonedAt?: number;
  version?: number;
  source?: 'manual' | 'ai_proposed' | 'memoryGateway_synced';
  status?: 'active' | 'deleted' | 'candidate' | 'invalidated' | 'archived';
  sourceMessageId?: string;
  sourceConversationId?: string;
  sourceAgentId?: AgentId;
  occurredAt?: number;
  savedAt?: number;
  sourceVersion?: number;
  memoryType?: 'experience' | 'preference' | 'agreement' | 'project_consensus' | 'model_inference';
  pinned?: boolean;
  history?: Array<{ content: string; updatedAt: number }>;
  conflict?: {
    localContent?: string;
    remoteContent?: string;
    remoteVersion?: number;
    baseVersion?: number;
    reason?: string;
  };
}

export interface ContextCheckpoint {
  id: string;
  conversationId: ConversationId;
  summary: string;
  createdBeforeMessageId: MessageId;
  createdAt: number;
  sourceMessageRange?: { fromId?: string; toId?: string; count?: number };
  sourceRevision?: number;
  sourceMessagesHash?: string;
  sourceMessageSnapshots?: Array<{ id: string; text: string }>;
  /** 工单 08-R2：增量快照链——本检查点快照只覆盖上一个检查点边界之后的消息 */
  prevCheckpointId?: string;
  status?: 'active' | 'stale' | 'invalidated';
  cumulativeFacts?: string[];
}

export interface MemoryReferenceSource {
  id: string;
  title: string;
  sourceType: 'memory' | 'direct_history' | 'living_room_history' | 'checkpoint' | 'memoryGateway';
  sourceConversationId?: string;
  authorAgentId?: string;
  timestamp: number;
  injected: boolean;
  reason?: string;
  /** 工单 08-R2：实际写入最终 payload 的片段长度与内容哈希（收据保真核对用） */
  injectedChars?: number;
  payloadHash?: string;
  /** 工单 08-R4：完整来源登记 */
  authorName?: string;
  chatMode?: 'direct' | 'living-room';
  /** 原话修订版本边界（无修订则缺省） */
  editedAt?: number;
  /** 原始来源内容全文哈希；payloadHash 为实际写入 wire 片段的哈希，两者含义分明 */
  sourceContentHash?: string;
  /** 集合块标注：块级来源不替代逐消息来源 */
  aggregate?: boolean;
  /** 该片段所属参考块（聚合核对用） */
  blockId?: string;
  /** 检查点摘要来源：覆盖哈希与范围 */
  sourceMessagesHash?: string;
  coverage?: { fromId?: string; toId?: string; count?: number };
}

export interface MemoryDeliveryReceipt {
  requestId: string;
  conversationId: string;
  targetAgentId: string;
  /** 工单 08-R4：与实际请求关联的 Codex thread（仅权威 canonical/实际绑定值） */
  threadId?: string;
  preparedSources: MemoryReferenceSource[];
  injectedSources: MemoryReferenceSource[];
  status: 'prepared' | 'injected' | 'completed' | 'failed' | 'cancelled';
  totalBudgetChars: number;
  usedChars: number;
  fallbackUsed?: 'none' | 'basic_keyword' | 'recent_window';
  error?: string;
  timestamp: number;
}

export interface TurnContextParams {
  conversationId: string;
  targetAgentId: string;
  currentText: string;
  targetMsgIdx?: number;
  cutoffTime?: number;
  extraMemoryGatewayMemories?: string[];
  /** 工单 08-R3：本轮自身消息（发送时刚追加的用户消息/过去重试的原话）不得重复进入历史/召回 */
  excludeMessageIds?: string[];
  isDemo?: boolean;
  requestId?: string;
}

export interface TurnContextResult {
  isDemo: boolean;
  profile?: ChatProfile;
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  configError?: string;
  deliveryReceipt: MemoryDeliveryReceipt;
  formattedTurnText?: string;
  effectiveDeveloperInstructions?: string;
}


export interface MemoryGatewayConfig {
  enabled: boolean;
  baseUrl: string;
  credentialRef: string;
  defaultNamespace?: string;
  lastVerifiedAt?: string | null;
  lastVerifiedStatus?: 'success' | 'failed' | null;
  lastVerifiedError?: string | null;
}

export interface MemoryGatewayOutboxItem {
  id: string;
  conversationId: ConversationId;
  namespace: string;
  messageIds: MessageId[];
  createdAt: number;
  attempts: number;
  status?: 'pending' | 'acked' | 'failed';
}

export interface AppData {
  version: number;
  preferences: Preferences;
  agents: Agent[];
  conversations: Conversation[];
  messages: Message[];
  tickets: Ticket[];
  /** 每个会话独立草稿 */
  drafts: Record<ConversationId, string>;
  attachmentDrafts?: Record<ConversationId, MessageAttachment[]>;
  seeded: boolean;
  activeConversationId: ConversationId;
  activeTicketId: TicketId | null;
  workbenchOpen: boolean;
  chatProfiles?: ChatProfile[];
  livingRoomSpeakerId?: AgentId | null;
  memories?: MemoryItem[];
  memoryTombstones?: string[];
  checkpoints?: ContextCheckpoint[];
  memoryGatewayConfig?: MemoryGatewayConfig;
  memoryGatewayOutbox?: MemoryGatewayOutboxItem[];
  cloudSyncConfig?: {
    enabled?: boolean;
    homeId?: string;
    url?: string;
    anonKey?: string;
    [key: string]: any;
  };
  cloudSyncOutbox?: any[];
  /** 工单 09：永久删除墓碑（不含正文，防止迟到回执与旧备份复活） */
  purgedMessageIds?: string[];
  purgedMessageEpoch?: number;
  /** 工单 09-R1：因永久删除而失效的 Codex thread 墓碑，彻底阻断迟到快照与绑定复活 */
  purgedThreadIds?: string[];
}

export const STORAGE_KEY = 'xiaowu.data.v1';
export const STORAGE_VERSION = 1;

export const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  todo: '待开始',
  doing: '进行中',
  review: '待检查',
  done: '完成',
};

/** 任务状态推进顺序，UI 上一键循环切换 */
export const TASK_STATUS_ORDER: TaskStatus[] = ['todo', 'doing', 'review', 'done'];

export const uid = (prefix: string): string =>
  `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
