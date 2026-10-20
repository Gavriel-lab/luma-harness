/**
 * ChatAdapter：UI 与模型传输层之间的唯一接口。
 *
 * 本原型只提供 DemoAdapter，它不调用任何真实 API。
 * 真实接入（工单 02/03）时新增 RemoteAdapter 实现同一接口即可，UI 与数据层无需改动。
 * 硬性约束：凭据只允许出现在可信后端；浏览器构建产物内不得含任何 Key / Token。
 */

import type { ChatProfile } from '../types';

export interface ChatMessageContext {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatRequest {
  /** 会话 ID：回调必须原样带回，UI 据此丢弃发往其他会话的迟到回复 */
  conversationId: string;
  /** 请求 ID：同一会话内区分先后，用于丢弃被取消或被取代的旧请求 */
  requestId: string;
  /** 发言者身份：本条消息是谁说的 */
  speakerId: string;
  /** 目标成员；null 表示客厅群聊 */
  toAgentId: string | null;
  text: string;
  /** 冻结的上下文消息列表（含 systemPrompt 与历史上下文） */
  messages?: ChatMessageContext[];
  /** 冻结的配置快照，避免切换页面/改配置导致进行中的请求变动 */
  profileSnapshot?: ChatProfile;
  /** 指定是否以演示模式运行 */
  isDemo?: boolean;
  /** 工单 07：当前会话模式 */
  mode?: 'direct' | 'living-room';
  /** 工单 07：目标成员姓名 */
  targetAgentName?: string;
  /** 工单 07：当前在场参与者列表 */
  participants?: string[];
  /** 工单 07：近期公开公共发言记录 */
  publicRecentMessages?: Array<{
    id: string;
    speakerName: string;
    speakerId: string;
    text: string;
    createdAt: number;
  }>;
  /** 工单 08-R2：过去请求重试的时间边界（早于该时间的资料才可进入上下文） */
  cutoffTime?: number;
  /** 工单 08-R3：本轮自身消息（刚追加的用户消息/过去重试原话）不重复进入历史或召回 */
  excludeMessageIds?: string[];
  /** 工单 08-R2：主进程权威来源收据送达（渲染端只展示，不自造收据） */
  onMemoryReceipt?: (info: MemoryReceiptInfo) => void;
}

/** 主进程权威组装后的收据与派生检查点 */
export interface MemoryReceiptInfo {
  requestId: string;
  conversationId: string;
  targetAgentId: string;
  receipt: import('../types').MemoryDeliveryReceipt;
  updatedCheckpoints?: import('../types').ContextCheckpoint[];
}

export interface ChatChunk {
  type: 'thinking' | 'delta' | 'done' | 'error';
  /** 仅 delta 携带增量文本 */
  delta?: string;
  message?: string;
}

export interface ChatHandle {
  cancel: () => void;
}

export interface ChatAdapter {
  /** 稳定标识，展示在界面上用于说明当前用的是演示还是真实服务 */
  readonly id: string;
  readonly label: string;
  /** 演示为 true 时 UI 必须显示演示标识 */
  readonly demo: boolean;
  /**
   * 发送一条消息。取消后不得再回调。
   * 实现方必须把 conversationId / requestId 原样透传。
   */
  send(req: ChatRequest, onChunk: (chunk: ChatChunk) => void): ChatHandle;
}