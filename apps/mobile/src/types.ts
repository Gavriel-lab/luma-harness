/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export type PageId = 'splash' | 'home' | 'garden' | 'chat' | 'settings' | 'diary' | 'reader' | 'atelier' | 'study';

export type AgentKind = 'human' | 'ai';

export interface OfficialMemberConfig {
  agentId: string;
  displayName: string;
  kind: AgentKind;
  executorId: string | null;
  frenchRole?: string;
  signatureColor?: string;
  bubbleBg?: string;
  bubbleBorder?: string;
  textColor?: string;
  greeting?: string;
}

export interface MemberDto {
  agentId: string;
  displayName: string;
  kind: AgentKind;
  avatarDataUrl?: string;
  accent?: string;
  available: boolean;
  status: string;
  reason?: string;
}

export interface GetMembersResponse {
  schema: 'members/1';
  homeId: string;
  members: MemberDto[];
}

export interface ConversationDto {
  conversationId: string;
  kind: 'direct' | 'group';
  agentId?: string;
  title: string;
  lastMessage?: string;
  updatedAt?: string;
}

export interface GetConversationsResponse {
  schema: 'conversations/1';
  homeId: string;
  conversations: ConversationDto[];
}

export interface AttachmentDto {
  id: string;
  name: string;
  size: number;
  kind: 'image' | 'text';
  mimeType: string;
  truncated?: boolean;
}

export interface MessageDto {
  hiddenReplyParts?: string[];
  id: string;
  agentId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  createdAt: string;
  status?: 'sent' | 'pending' | 'failed';
  error?: string;
  /**
   * 兼容扩展合同：网关可在历史消息中回传提交时的客户端 requestId，
   * 用于前端临时消息与权威历史的精准对账与核销。
   */
  requestId?: string;
  sourceChannel?: 'luma' | 'xiaodu';
  eventKind?: 'device-event';
  attachments?: AttachmentDto[];
}

export interface GetMessagesResponse {
  schema: 'messages/1';
  homeId: string;
  conversationId: string;
  messages: MessageDto[];
  cursor?: string;
}

export interface ApiError {
  code: string;
  message: string;
  retryable: boolean;
}

export interface SendChatAttachment {
  name: string;
  mimeType: string;
  size: number;
  dataBase64: string;
}

export interface SendChatRequest {
  requestId: string;
  conversationId: string;
  targetAgentId: string;
  text: string;
  attachments?: SendChatAttachment[];
}

export interface SendChatResponse {
  schema: 'chat-job/1';
  requestId: string;
  jobId: string;
  state: 'queued' | 'doing' | 'done' | 'failed';
  error?: ApiError;
  /**
   * 兼容扩展合同 (备选)：
   * 服务端接收到该轮提问后生成的权威用户消息 ID
   */
  userMessageId?: string;
}

export interface ChatJobDto {
  schema: 'chat-job/1';
  requestId: string;
  jobId: string;
  state: 'queued' | 'doing' | 'done' | 'failed';
  reply?: {
    id: string;
    agentId: string;
    content: string;
    createdAt: string;
  };
  error?: ApiError;
  /**
   * 兼容扩展合同 (备选)：
   * 服务端接收到该轮提问后生成的权威用户消息 ID
   */
  userMessageId?: string;
}

export interface Character {
  id: string;            // 稳定 agentId (例如 agent_coordinator)
  name: string;          // 显示名称
  pinyin: string;
  title: string;
  role: string;
  frenchRole: string;
  avatarSeed: string;
  avatarUrl?: string;
  kind: AgentKind;
  executorId: string | null;
  statusNote?: string;
  available: boolean;
  isPinned?: boolean;
  unreadCount?: number;
  lastMessage?: string;
  lastTime?: string;
  signatureColor: string;
  bubbleBg: string;
  bubbleBorder: string;
  textColor: string;
  greeting: string;
}

export interface Message {
  hiddenReplyParts?: string[];
  id: string;
  conversationId: string;
  senderId: string;       // user 或 agentId
  senderName: string;
  content: string;
  timestamp: string;
  /** 原始 ISO 时间，只用来画日期分隔线；本地刚发的消息可能没有 */
  createdAt?: string;
  isUser: boolean;
  image?: string;
  imageName?: string;
  fileAttachment?: {
    name: string;
    size?: number;
    type?: string;
    dataUrl?: string;
  };
  audioUrl?: string;
  audioDuration?: number;
  voiceTranscription?: string;
  status?: 'sent' | 'pending' | 'failed';
  errorReason?: string;
  sourceChannel?: 'luma' | 'xiaodu';
  eventKind?: 'device-event';
  requestId?: string;     // 重试时沿用相同 requestId
  targetAgentId?: string; // 保留本轮点名，重试不会改投其他成员
  userMessageId?: string; // 消费服务端生成的权威用户消息 ID (合同 B)
  jobId?: string;         // 关联的后台任务 ID (用于恢复轮询或状态追踪)
  reply?: {               // 本地暂存答复 (当远端 GET messages 延迟未返回时展示)
    id: string;
    agentId: string;
    content: string;
    createdAt: string;
  };
  attachments?: AttachmentDto[];
  quote?: {
    id: string;
    senderName: string;
    content: string;
    image?: string;
  };
  isFavorite?: boolean;
}

export interface Artwork {
  id: string;
  title: string;
  chineseTitle: string;
  year: string;
  medium: string;
  dimension: string;
  description: string;
  palette: string[];
  gradient: string;
  accentColor: string;
}

export interface ActiveRipple {
  x: number;
  y: number;
  progress: number;
  onComplete?: () => void;
}

export interface MemoryDto {
  id: string;
  scopeType: 'direct' | 'living-room';
  scopeId?: string | null;
  authorAgentId: string;
  title: string;
  content: string;
  memoryType: string;
  status: string;
  tags?: string[];
  triggers?: string[];
  pinned?: boolean;
  createdAt: string;
  updatedAt: string;
  version: number;
}

export interface GetMemoriesResponse {
  schema: 'memories/1';
  homeId: string;
  memories: MemoryDto[];
}

export interface SaveMemoryRequest {
  requestId: string;
  memoryId?: string;
  scopeType: 'direct' | 'living-room';
  scopeId?: string;
  authorMemberId?: string;
  title?: string;
  content: string;
  memoryType?: string;
  tags?: string[];
  pinned?: boolean;
}

export interface SaveMemoryResponse {
  schema: 'save-memory/1';
  requestId: string;
  memory: MemoryDto;
}

export interface SyncStatusResponse {
  schema: 'sync-status/1';
  homeId: string;
  enabled: boolean;
  status: string;
  lastSyncTime?: number | null;
  outboxPending: number;
  error?: string | null;
  conflictCount?: number;
  lastCommitSeq: number;
}

export interface GardenMemorySummaryDto {
  key: string;
  conversationId: string;
  documentId: string;
  kind: 'scene' | 'event';
  title: string;
  preview: string;
  date: string;
  scope: 'living-room' | 'direct';
  scopeName: string;
  authorName?: string;
  revision: number;
}

export interface GetMemoryGardenResponse {
  schema: 'memory-garden/1';
  snapshotId: string;
  total: number;
  items: GardenMemorySummaryDto[];
  cursor?: string | null;
  hasMore: boolean;
}

export interface GardenMemorySourceDto {
  messageId: string;
  speaker: string;
  text: string;
  createdAt?: string;
}

export interface GardenMemoryDetailDto {
  key: string;
  conversationId: string;
  documentId: string;
  kind: 'scene' | 'event';
  title: string;
  content: string;
  date: string;
  scope: 'living-room' | 'direct';
  scopeName: string;
  authorName?: string;
  revision: number;
  sources?: GardenMemorySourceDto[];
}

export interface GetMemoryGardenDetailResponse {
  schema: 'memory-garden-detail/1';
  detail: GardenMemoryDetailDto;
}

export interface GardenRelatedMemoryDto {
  key: string;
  title: string;
  score: number;
  basis: 'formal-relation' | 'externalMemory-recall';
  revision: number;
}

export interface GetMemoryGardenRelatedResponse {
  schema: 'memory-garden-related/1';
  key: string;
  related: GardenRelatedMemoryDto[];
}

export interface MomentAttachment {
  id: string;
  name: string;
  kind: 'image' | 'text';
  mimeType?: string;
  size: number;
  previewDataUrl?: string | null;
}

export interface MomentLike {
  actorId: string;
  createdAt: number;
}

export interface MomentComment {
  id: string;
  postId: string;
  authorId: string;
  text: string;
  createdAt: number;
  replyToCommentId?: string | null;
  replyToAuthorId?: string | null;
}

export interface MomentPost {
  id: string;
  authorId: string;
  createdAt: number;
  updatedAt: number;
  text: string;
  attachments: MomentAttachment[];
  imageUrl?: string | null;
  location?: string | null;
  type: 'post' | 'daily' | 'outing';
  activityId?: string | null;
  sourceLinks?: { title: string; url: string }[];
  likesCount: number;
  likedByViewer: boolean;
  likes: MomentLike[];
  comments: MomentComment[];
}

export interface GetMomentsResponse {
  schema: 'moments/1';
  posts: MomentPost[];
  nextCursor?: number | null;
  hasMore: boolean;
}

export interface PostMomentRequest {
  requestId?: string;
  text?: string;
  attachments?: SendChatAttachment[];
  location?: string;
}

export interface PostMomentResponse {
  ok: boolean;
  post: MomentPost;
  duplicate?: boolean;
}

export interface ToggleLikeResponse {
  ok: boolean;
  liked: boolean;
  count: number;
  postId: string;
}

export interface CommentMomentRequest {
  requestId?: string;
  postId: string;
  text: string;
  replyToCommentId?: string | null;
  replyToAuthorId?: string | null;
}

export interface CommentMomentResponse {
  ok: boolean;
  comment: MomentComment;
  duplicate?: boolean;
}

