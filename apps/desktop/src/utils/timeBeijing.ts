/**
 * 工单 09：北京时间感知与格式化工具（固定 Asia/Shanghai，明示 UTC+08:00）
 * 不依赖操作系统当前时区，不让模型猜测，不硬编码在人格里。
 */

export interface BeijingTimeComponents {
  year: number;
  month: number;
  day: number;
  weekday: string;
  hour: number;
  minute: number;
  second: number;
  formattedFull: string;
  formattedDateTime: string;
  formattedShort: string;
  formattedDateShort: string;
  rawMs: number;
}

const WEEKDAY_NAMES = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];

export function getBeijingTime(ms: number = Date.now()): BeijingTimeComponents {
  const date = new Date(ms);
  // 计算在 UTC+8 下的年月日时分秒与星期（不受操作系统本地时区影响）
  const utcMs = date.getTime();
  const bjMs = utcMs + 8 * 3600 * 1000;
  const bjDate = new Date(bjMs);

  const year = bjDate.getUTCFullYear();
  const month = bjDate.getUTCMonth() + 1;
  const day = bjDate.getUTCDate();
  const weekday = WEEKDAY_NAMES[bjDate.getUTCDay()] || '星期日';
  const hour = bjDate.getUTCHours();
  const minute = bjDate.getUTCMinutes();
  const second = bjDate.getUTCSeconds();

  const pad = (n: number) => n.toString().padStart(2, '0');

  const formattedFull = `${year}年${month}月${day}日 ${weekday} ${pad(hour)}:${pad(minute)}:${pad(second)}（UTC+08:00）`;
  const formattedDateTime = `${year}年${month}月${day}日 ${pad(hour)}:${pad(minute)}:${pad(second)}`;
  const formattedShort = `${pad(hour)}:${pad(minute)}`;
  const formattedDateShort = `${month}月${day}日 ${pad(hour)}:${pad(minute)}`;

  return {
    year,
    month,
    day,
    weekday,
    hour,
    minute,
    second,
    formattedFull,
    formattedDateTime,
    formattedShort,
    formattedDateShort,
    rawMs: ms,
  };
}

export function formatBeijingRelativeInterval(nowMs: number, pastMs: number): string {
  if (!pastMs || pastMs <= 0) return '暂无可确认记录';
  const diffMs = nowMs - pastMs;
  if (diffMs < 0) return '刚刚';
  if (diffMs < 60_000) return '约几秒前';
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return `约${minutes}分钟前`;
  const hours = Math.floor(diffMs / 3_600_000);
  if (hours < 24) return `约${hours}小时前`;
  const days = Math.floor(diffMs / 86_400_000);
  return `约${days}天前`;
}

export interface LastInteractionResult {
  lastInteractionMs: number | null;
  lastUserMsgMs: number | null;
  lastAgentMsgMs: number | null;
  description: string;
}

export function findLastInteraction(
  messages: Array<{
    id: string;
    conversationId: string;
    agentId: string;
    text: string;
    createdAt: number;
    status: string;
    targetAgentId?: string;
  }>,
  conversations: Array<{
    id: string;
    kind: 'living-room' | 'direct';
    agentId: string | null;
  }>,
  targetAgentId: string,
  options: {
    nowMs?: number;
    cutoffTime?: number;
    excludeIds?: Set<string>;
  } = {},
): LastInteractionResult {
  const nowMs = options.nowMs ?? Date.now();
  const cutoff = options.cutoffTime;
  const excludeSet = options.excludeIds ?? new Set<string>();

  const convMap = new Map(conversations.map((c) => [c.id, c]));

  let lastUserMsgMs: number | null = null;
  let lastAgentMsgMs: number | null = null;

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!m) continue;
    if (excludeSet.has(m.id)) continue;
    if (cutoff !== undefined && cutoff !== null && m.createdAt > cutoff) continue;
    if (m.status !== 'sent') continue; // 必须是 sent，排除 pending、error 等未发送状态
    if (!m.text || !m.text.trim()) continue;

    const conv = convMap.get(m.conversationId);
    const isDirect = conv?.kind === 'direct' && conv.agentId === targetAgentId;
    const isLivingRoom = conv?.kind === 'living-room';

    if (m.agentId === targetAgentId) {
      // 该成员有效回复（无论私聊还是客厅，都属于该成员与使用者的交流线）
      if (!lastAgentMsgMs || m.createdAt > lastAgentMsgMs) {
        lastAgentMsgMs = m.createdAt;
      }
    } else if (m.agentId === 'agent_owner') {
      let isForThisAgent = false;

      // 用户气泡的 sent 仅表示已保存在本机。必须有本轮同会话的有效回复
      // 才确认双方交流；删除失败占位后仍不能将“没有回复”当作发送成功。
      const subsequentSameConv = messages.slice(i + 1).filter((nm) => nm.conversationId === m.conversationId);
      const nextUserIndex = subsequentSameConv.findIndex((nm) => nm.agentId === 'agent_owner');
      const sameTurn = nextUserIndex < 0 ? subsequentSameConv : subsequentSameConv.slice(0, nextUserIndex);
      const reply = sameTurn.find((nm) => !excludeSet.has(nm.id) && nm.agentId !== 'agent_owner');
      const eligibleTarget = isDirect || (isLivingRoom && (!m.targetAgentId || m.targetAgentId === targetAgentId));
      isForThisAgent = Boolean(eligibleTarget && reply && reply.agentId === targetAgentId
        && reply.status === 'sent' && reply.text?.trim()
        && (cutoff === undefined || cutoff === null || reply.createdAt <= cutoff));

      if (isForThisAgent) {
        if (!lastUserMsgMs || m.createdAt > lastUserMsgMs) {
          lastUserMsgMs = m.createdAt;
        }
      }
    }
  }

  const times = [lastUserMsgMs, lastAgentMsgMs].filter((t): t is number => t !== null && t > 0);
  if (times.length === 0) {
    return {
      lastInteractionMs: null,
      lastUserMsgMs,
      lastAgentMsgMs,
      description: '暂无可确认记录',
    };
  }

  const lastInteractionMs = Math.max(...times);
  const timeComp = getBeijingTime(lastInteractionMs);
  const relative = formatBeijingRelativeInterval(nowMs, lastInteractionMs);
  const description = `${timeComp.formattedDateTime}，${relative}`;

  return {
    lastInteractionMs,
    lastUserMsgMs,
    lastAgentMsgMs,
    description,
  };
}

export function buildDynamicTimePrompt(params: {
  nowMs?: number;
  chatMode: 'direct' | 'living-room';
  lastInteractionText: string;
}): string {
  const nowMs = params.nowMs ?? Date.now();
  const bj = getBeijingTime(nowMs);
  const modeText = params.chatMode === 'direct' ? '私聊' : '客厅群聊';
  return `【当前北京时间：${bj.formattedFull}。当前模式：${modeText}。你与使用者上一次交流：${params.lastInteractionText}。历史消息的时间属于当时，不代表现在；没有依据时不要编造早晚、离开多久或期间发生的事。】`;
}
