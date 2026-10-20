'use strict';

/**
 * 小屋 · 主进程权威上下文组装模块（工单 08-R2）
 *
 * 职责边界（对齐协调者 08-R1 独立审计的修复方向）：
 * 1. 上下文与资料只能由可信主进程从权威存储（authData）组装；渲染进程只提交本轮文本、
 *    目标成员、会话与请求/重试边界，不得提交系统历史、来源表或收据。
 * 2. 资格判定只依据来源 owner/scope/版本（谁的记忆、什么范围、哪个版本），不做关键词整段清空，
 *    与他人旧话同文的合法本轮输入正常放行。
 * 3. API 与 Codex 使用同一份授权/召回/预算模块，仅协议序列化不同。
 * 4. 16000 字符预算在最终序列化结果上计算：完整保留当前输入与授权人格，削减不相关旧资料，
 *    仍超限则明确拒绝且不启动模型。
 * 5. 来源收据在最终序列化时生成，只记录实际写入最终 payload 的来源（含实际片段与内容哈希）。
 */

const MAX_TOTAL_BUDGET = 16000;
const {deviceEventIds}=require('./chatChannels.cjs');
const {replyInstructions}=require('./chatReplies.cjs');

/* ------------------------------------------------------------------ *
 * 基础哈希与文本工具
 * ------------------------------------------------------------------ */

function computeMessagesHash(messages) {
  let hash = 0x811c9dc5;
  for (const m of messages) {
    const str = `${m.id}:${m.text}|`;
    for (let i = 0; i < str.length; i++) {
      hash ^= str.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/** 对实际写入 payload 的来源片段计算确定性内容哈希（收据核对用） */
function contentHash(str) {
  let hash = 0x811c9dc5;
  const text = typeof str === 'string' ? str : '';
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/* ------------------------------------------------------------------ *
 * 工单 09：北京时间感知工具（固定 Asia/Shanghai，明示 UTC+08:00）
 * ------------------------------------------------------------------ */

const BEIJING_WEEKDAY_NAMES = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];

function getBeijingTimeCjs(ms) {
  const date = new Date(typeof ms === 'number' && Number.isFinite(ms) ? ms : Date.now());
  const utcMs = date.getTime();
  const bjMs = utcMs + 8 * 3600 * 1000;
  const bjDate = new Date(bjMs);

  const year = bjDate.getUTCFullYear();
  const month = bjDate.getUTCMonth() + 1;
  const day = bjDate.getUTCDate();
  const weekday = BEIJING_WEEKDAY_NAMES[bjDate.getUTCDay()];
  const hour = bjDate.getUTCHours();
  const minute = bjDate.getUTCMinutes();
  const second = bjDate.getUTCSeconds();

  const pad = (n) => n.toString().padStart(2, '0');

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
    rawMs: date.getTime(),
  };
}

/** 原发生时间与编辑版本时间分别表述，不用 editedAt 替换 createdAt。 */
function formatMessageTimeCjs(message) {
  const created = getBeijingTimeCjs(message.createdAt).formattedDateTime;
  const edited = typeof message.editedAt === 'number' && Number.isFinite(message.editedAt)
    ? `；编辑于${getBeijingTimeCjs(message.editedAt).formattedDateTime}`
    : '';
  return `${created}${edited}`;
}

function formatBeijingRelativeIntervalCjs(nowMs, pastMs) {
  if (!pastMs || pastMs <= 0) return '暂无可确认记录';
  const diffMs = nowMs - pastMs;
  if (diffMs < 0) return '刚刚';
  if (diffMs < 60000) return '约几秒前';
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 60) return `约${minutes}分钟前`;
  const hours = Math.floor(diffMs / 3600000);
  if (hours < 24) return `约${hours}小时前`;
  const days = Math.floor(diffMs / 86400000);
  return `约${days}天前`;
}

function findLastInteractionCjs(messages, conversations, targetAgentId, options = {}) {
  const nowMs = options.nowMs || Date.now();
  const cutoff = options.cutoffTime;
  const excludeSet = options.excludeIds || new Set();

  const convMap = new Map((conversations || []).map((c) => [c.id, c]));

  let lastUserMsgMs = null;
  let lastAgentMsgMs = null;

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (excludeSet.has(m.id)) continue;
    if (cutoff !== undefined && cutoff !== null && m.createdAt > cutoff) continue;
    if (m.status !== 'sent') continue; // 必须是 sent，排除 pending、error 等未发送状态
    if (!m.text || !m.text.trim()) continue;

    const conv = convMap.get(m.conversationId);
    const isDirect = conv && conv.kind === 'direct' && conv.agentId === targetAgentId;
    const isLivingRoom = conv && conv.kind === 'living-room';

    if (m.agentId === targetAgentId) {
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

  const times = [lastUserMsgMs, lastAgentMsgMs].filter((t) => t !== null && t > 0);
  if (times.length === 0) {
    return {
      lastInteractionMs: null,
      lastUserMsgMs,
      lastAgentMsgMs,
      description: '暂无可确认记录',
    };
  }

  const lastInteractionMs = Math.max(...times);
  const timeComp = getBeijingTimeCjs(lastInteractionMs);
  const relative = formatBeijingRelativeIntervalCjs(nowMs, lastInteractionMs);
  const description = `${timeComp.formattedDateTime}，${relative}`;

  return {
    lastInteractionMs,
    lastUserMsgMs,
    lastAgentMsgMs,
    description,
  };
}

/* ------------------------------------------------------------------ *
 * 关键词提取与主题相关性（与 src/store/memoryManager.ts 保持同规则）
 * ------------------------------------------------------------------ */

const STOP_WORDS = new Set([
  '的', '了', '是', '在', '我', '有', '和', '就', '不', '人', '都', '一', '一个', '上', '也', '很', '到', '说',
  '要', '去', '你', '会', '着', '没有', '看', '好', '自己', '这', '那', '我们', '你们', '他们', '什么', '怎么',
  '可以', '请', '介绍', '聊聊', '今天', '讨论', '方案', '设计', '一下', '这个', '那个', '刚才', '之前', '如何',
  '工作', '顺利', '普通', '闲聊', '谢谢', '好的', '收到', '进行', '推进', '交流', '大家',
  '关于', '那些', '觉得', '一起', '另外', '另一个', '建议', '构想', '想法', '灵感', '私聊', '客厅', '群里', '群聊',
  '来说', '而言', '所谓', '由于', '因此', '并且', '而且', '或者', '还是', '之后', '然后', '最后',
  '设想', '打算', '考虑', '规划', '咱们',
]);

const PARTICLES = new Set(['的', '了', '着', '过', '得', '地', '在', '从', '向', '与', '和', '及', '或', '把', '被', '让', '给', '各', '每', '个', '前', '后', '中', '于', '自', '至', '到', '那', '这']);

function extractKeywords(text, excludeWords = []) {
  if (!text || typeof text !== 'string') return [];
  const keywords = [];
  const excludeLower = new Set(excludeWords.map((w) => String(w).toLowerCase()));

  const codeMatches = text.match(/[A-Za-z0-9_#-]{2,}/g);
  if (codeMatches) {
    for (const code of codeMatches) {
      if (!STOP_WORDS.has(code.toLowerCase()) && !excludeLower.has(code.toLowerCase())) {
        keywords.push(code);
      }
    }
  }

  const cleanCn = text.replace(/[^\u4e00-\u9fa5]/g, ' ');
  const chunks = cleanCn.split(/\s+/).filter((s) => s.length >= 2);
  for (const chunk of chunks) {
    if (!STOP_WORDS.has(chunk) && !excludeLower.has(chunk.toLowerCase())) {
      keywords.push(chunk);
    }
    if (chunk.length >= 4) {
      for (let i = 0; i <= chunk.length - 2; i++) {
        const sub2 = chunk.slice(i, i + 2);
        const firstChar = sub2[0];
        const secondChar = sub2[1];
        if ((firstChar && PARTICLES.has(firstChar)) || (secondChar && PARTICLES.has(secondChar))) {
          continue;
        }
        if (!STOP_WORDS.has(sub2) && !excludeLower.has(sub2.toLowerCase()) && !keywords.includes(sub2)) {
          keywords.push(sub2);
        }
      }
    }
  }

  return Array.from(new Set(keywords));
}

function matchTopicRelevance(keywords, text) {
  if (!keywords || keywords.length === 0 || !text) return 0;
  let score = 0;
  const lowerText = text.toLowerCase();
  for (const kw of keywords) {
    const lowerKw = kw.toLowerCase();
    if (lowerText.includes(lowerKw)) {
      if (/[A-Za-z0-9_]{3,}/.test(kw)) {
        score += 100;
      } else {
        score += kw.length * 10;
      }
    }
  }
  return score;
}

/* ------------------------------------------------------------------ *
 * 会话事实提炼与检查点（有界增长）
 * ------------------------------------------------------------------ */

function splitSentences(text) {
  return text
    .split(/([。！？\n；;]+)/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !/^[。！？\n；;]+$/.test(s));
}

function extractConversationFacts(messages, targetAgentName = '成员', isDirect = true) {
  const validMsgs = messages.filter((m) => m.status === 'sent' && m.text && m.text.trim());
  if (validMsgs.length === 0) return '暂无有效对话事实';

  const firstMsg = validMsgs[0];
  const lastMsg = validMsgs[validMsgs.length - 1];
  const firstTime = new Date(firstMsg.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const lastTime = new Date(lastMsg.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  const keyFacts = [];
  const ownerFacts = [];
  const otherFacts = [];

  for (const m of validMsgs) {
    const sentences = splitSentences(m.text);
    for (const sent of sentences) {
      const clean = sent.replace(/\s+/g, ' ').trim();
      if (!clean) continue;
      if (/^(嗯|好的|在的|收到|知道了|好呀|聊得很开心|今天聊得很开心|谢谢|哈哈|拜拜|晚安|早安)[。！!？?~～]*$/i.test(clean)) {
        continue;
      }
      if (!keyFacts.includes(clean)) keyFacts.push(clean);
      if (m.agentId === 'agent_owner') {
        if (!ownerFacts.includes(clean)) ownerFacts.push(clean);
      } else if (!otherFacts.includes(clean)) {
        otherFacts.push(clean);
      }
    }
  }

  const MAX_FACT_COUNT = 8;
  const boundedKeyFacts = keyFacts.length > MAX_FACT_COUNT ? [...keyFacts.slice(0, 4), ...keyFacts.slice(-4)] : keyFacts;
  const boundedOwner = ownerFacts.length > MAX_FACT_COUNT ? [...ownerFacts.slice(0, 4), ...ownerFacts.slice(-4)] : ownerFacts;
  const boundedOther = otherFacts.length > MAX_FACT_COUNT ? [...otherFacts.slice(0, 4), ...otherFacts.slice(-4)] : otherFacts;

  const quotes = (pattern) => keyFacts.filter(s => pattern.test(s)).slice(-4).map(s=>s.slice(0,180)).join('；') || '未提取到明确原话';
  const parts = [
    `【${isDirect ? targetAgentName : '客厅'}会话事实与检查点】`,
    `- 记录区间：${firstMsg.id} ~ ${lastMsg.id}（${firstTime} - ${lastTime}，共 ${validMsgs.length} 条对话）`,
    `- 话题与结论（原话摘录）：${boundedKeyFacts.map(s=>s.slice(0,120)).join('；')}；成员答复：${boundedOther.slice(-2).map(s=>s.slice(0,100)).join('；')}`,
    `- 决定与未决问题：${quotes(/决定|约定|说好|确认|问题|待办|还没|尚未/)}`,
    `- 记忆线索（以来源为准）：${boundedOwner.map(s=>s.slice(0,100)).join('；') || '暂无明确线索'}`,
    `- 临时情绪背景（不当作永久事实）：${quotes(/开心|难过|害怕|幸福|委屈|想你|累/)}`,
    `- 下一步与未完成事项：${quotes(/下一步|接下来|需要|准备|还没|尚未|待办/)}`,
  ];

  return parts.join('\n');
}

/**
 * 检查点有效性：显式失效 / 缺源哈希 / 边界丢失 / 哈希不符 / 快照被改 任一即无效。
 * 支持增量快照链（prevCheckpointId）：自身快照只覆盖增量段，整段一致性由 sourceMessagesHash 保证。
 */
function isCheckpointValid(checkpoint, currentMessages) {
  if (!checkpoint) return false;
  if (checkpoint.status === 'stale' || checkpoint.status === 'invalidated') return false;
  if (!checkpoint.sourceMessagesHash) return false;
  if (!checkpoint.createdBeforeMessageId) return false;

  const splitIdx = currentMessages.findIndex((m) => m.id === checkpoint.createdBeforeMessageId);
  if (splitIdx < 0) return false;

  const coveredMsgs = currentMessages.slice(0, splitIdx + 1);
  if (coveredMsgs.length === 0) return false;

  const currentHash = computeMessagesHash(coveredMsgs);
  if (currentHash !== checkpoint.sourceMessagesHash) return false;

  if (Array.isArray(checkpoint.sourceMessageSnapshots)) {
    for (const snap of checkpoint.sourceMessageSnapshots) {
      const cur = coveredMsgs.find((m) => m.id === snap.id);
      if (!cur || cur.text !== snap.text) return false;
    }
  }

  return true;
}

/**
 * 自动派生检查点（有界版本）：
 * - 新检查点优先做增量快照（只记录上一个有效检查点边界之后的消息）；
 * - 同一会话只保留最新检查点：新检查点派生成功后，旧的同会话检查点被替代移除。
 *   原始聊天消息永不删除，来源版本/失效依据由 sourceMessagesHash 保留，
 *   编辑/删除后哈希失配即整体失效，并可从原始记录重新派生。
 */
function autoDeriveCheckpoints(conversationId, messages, existingCheckpoints, targetAgentName = '成员', isDirect = true) {
  const validMsgs = messages.filter(
    (m) => m.conversationId === conversationId && m.status === 'sent' && m.text && m.text.trim() && !m.demo && !String(m.id).startsWith('msg_seed_'),
  );

  const validExisting = (existingCheckpoints || []).filter((cp) => {
    if (cp.conversationId !== conversationId) return false;
    return isCheckpointValid(cp, validMsgs);
  });

  const latestValid = validExisting.length > 0
    ? validExisting.reduce((prev, curr) => (curr.createdAt > prev.createdAt ? curr : prev))
    : null;

  if (validMsgs.length < 8) {
    return { activeCheckpoint: latestValid, updatedCheckpoints: existingCheckpoints || [] };
  }

  const ACTIVE_TAIL_COUNT = 8;
  const foldBoundaryIdx = validMsgs.length - ACTIVE_TAIL_COUNT - 1;
  if (foldBoundaryIdx < 0) {
    return { activeCheckpoint: latestValid, updatedCheckpoints: existingCheckpoints || [] };
  }

  const boundaryMsg = validMsgs[foldBoundaryIdx];
  const coveredMsgs = validMsgs.slice(0, foldBoundaryIdx + 1);

  if (latestValid) {
    const coveredIdx = validMsgs.findIndex((m) => m.id === latestValid.createdBeforeMessageId);
    if (coveredIdx >= foldBoundaryIdx) {
      return { activeCheckpoint: latestValid, updatedCheckpoints: existingCheckpoints || [] };
    }
  }

  const summary = extractConversationFacts(coveredMsgs, targetAgentName, isDirect);
  const hash = computeMessagesHash(coveredMsgs);

  // 增量快照：上一个有效检查点边界之后的消息才进入本次快照，避免重复保存整个已覆盖前缀
  let snapshots;
  let prevCheckpointId;
  if (latestValid) {
    const prevIdx = coveredMsgs.findIndex((m) => m.id === latestValid.createdBeforeMessageId);
    if (prevIdx >= 0) {
      snapshots = coveredMsgs.slice(prevIdx + 1).map((m) => ({ id: m.id, text: m.text }));
      prevCheckpointId = latestValid.id;
    }
  }
  if (!snapshots) {
    snapshots = coveredMsgs.map((m) => ({ id: m.id, text: m.text }));
  }

  const newCheckpoint = {
    id: `cp_auto_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    conversationId,
    summary,
    createdBeforeMessageId: boundaryMsg.id,
    createdAt: Date.now(),
    sourceMessageRange: {
      fromId: coveredMsgs[0] ? coveredMsgs[0].id : undefined,
      toId: boundaryMsg.id,
      count: coveredMsgs.length,
    },
    sourceMessagesHash: hash,
    sourceMessageSnapshots: snapshots,
    prevCheckpointId,
    status: 'active',
  };

  // 替代式收敛：同会话旧检查点全部由新检查点承接（其覆盖范围被新检查点完全覆盖）
  const updatedCheckpoints = [
    ...(existingCheckpoints || []).filter((c) => c.conversationId !== conversationId),
    newCheckpoint,
  ];
  return { activeCheckpoint: newCheckpoint, updatedCheckpoints };
}

/* ------------------------------------------------------------------ *
 * 权威数据过滤（与 src/store/memoryManager.ts 的 filterAuthorizedData 同规则）
 * ------------------------------------------------------------------ */

function filterAuthorizedDataCjs(authData, targetAgentId, cutoffTime = Infinity, isDemo = false) {
  const deviceIds=deviceEventIds(authData.messages||[]);
  const targetAgent = (authData.agents || []).find((a) => a.id === targetAgentId) || null;
  const targetDirectConv = (authData.conversations || []).find(
    (c) => c.kind === 'direct' && c.agentId === targetAgentId,
  ) || null;
  const livingRoomConv = (authData.conversations || []).find((c) => c.kind === 'living-room') || null;

  const withinCutoff = (t) => !(typeof cutoffTime === 'number' && cutoffTime !== Infinity && t > cutoffTime);

  const authorizedDirectMessages = targetDirectConv
    ? (authData.messages || []).filter((m) => {
        if (m.conversationId !== targetDirectConv.id) return false;
        if (deviceIds.has(m.id)) return false;
        if (m.status !== 'sent') return false;
        if (!m.text || !m.text.trim()) return false;
        if (!isDemo && (m.demo || String(m.id).startsWith('msg_seed_'))) return false;
        if (!withinCutoff(m.createdAt)) return false;
        // 工单 08-R3：过去请求不得读取后来改写的原话——编辑版本时间晚于重试边界的消息
        // 无法证明当时版本，明确排除（memory 的 updatedAt 过滤保持不变）
        if (m.editedAt && !withinCutoff(m.editedAt)) return false;
        return true;
      })
    : [];

  const authorizedLivingRoomMessages = livingRoomConv
    ? (authData.messages || []).filter((m) => {
        if (m.conversationId !== livingRoomConv.id) return false;
        if (deviceIds.has(m.id)) return false;
        if (m.status !== 'sent') return false;
        if (!m.text || !m.text.trim()) return false;
        if (!isDemo && (m.demo || String(m.id).startsWith('msg_seed_'))) return false;
        if (!withinCutoff(m.createdAt)) return false;
        if (m.editedAt && !withinCutoff(m.editedAt)) return false;
        return true;
      })
    : [];

  const evidenceMessages=new Map([...authorizedDirectMessages,...authorizedLivingRoomMessages].map(m=>[m.id,m]));
  const purged=new Set(authData.purgedMessageIds||[]), tombstoned=new Set(authData.memoryTombstones||[]);
  const allMemories = (authData.memories || []).filter((m) => !m.tombstoned && !tombstoned.has(m.id) && m.status !== 'deleted' && m.status !== 'invalidated' && !deviceIds.has(m.sourceMessageId) && !(m.sourceMessageIds||[]).some(id=>deviceIds.has(id)) &&
    (!m.externalMemorySources || Object.entries(m.externalMemorySources).every(([id,digest])=>{
      const source=evidenceMessages.get(id);
      return source&&!purged.has(id)&&require('node:crypto').createHash('sha256').update(source.text).digest('hex').slice(0,24)===digest;
    })));
  const authorizedMemories = allMemories.filter((m) => {
    if (!withinCutoff(m.createdAt)) return false;
    if (m.updatedAt && !withinCutoff(m.updatedAt)) return false;
    if (m.scope && m.scope.type === 'living-room') return true;
    if (m.scope && m.scope.type === 'direct' && (m.scope.id === targetAgentId || (targetDirectConv && m.scope.id === targetDirectConv.id))) return true;
    return false;
  });

  const authorizedCheckpoints = (authData.checkpoints || []).filter((c) => {
    if (!withinCutoff(c.createdAt)) return false;
    if (c.updatedAt && !withinCutoff(c.updatedAt)) return false;
    if (c.status && c.status !== 'active') return false;
    if (c.memberId && c.memberId !== targetAgentId) return false;
    if (c.targetAgentId && c.targetAgentId !== targetAgentId) return false;
    if (livingRoomConv && c.conversationId === livingRoomConv.id) return true;
    if (targetDirectConv && c.conversationId === targetDirectConv.id) return true;
    return false;
  });

  return {
    targetAgent,
    targetDirectConv,
    livingRoomConv,
    authorizedDirectMessages,
    authorizedLivingRoomMessages,
    authorizedMemories,
    authorizedCheckpoints,
  };
}

function queryRelevantMemories(memories, queryText, topK = 3) {
  if (!memories || memories.length === 0) {
    return { selectedMemories: [], reasons: {}, fallbackUsed: 'none' };
  }
  const queryKws = extractKeywords(queryText);
  const scored = memories.map((m) => {
    let score = 0;
    if (m.pinned) score += 20;
    const titleScore = matchTopicRelevance(queryKws, m.title || '');
    const contentScore = matchTopicRelevance(queryKws, m.content);
    score += titleScore * 2 + contentScore;
    return { memory: m, score };
  });
  scored.sort((a, b) => b.score - a.score || b.memory.createdAt - a.memory.createdAt);

  const topScored = scored.filter((x) => x.score > 0).slice(0, topK);
  if (topScored.length > 0) {
    const reasons = {};
    for (const item of topScored) {
      reasons[item.memory.id] = `关键词匹配度得分: ${item.score}`;
    }
    return { selectedMemories: topScored.map((x) => x.memory), reasons, fallbackUsed: 'basic_keyword' };
  }

  const recent = memories.slice(-2);
  const reasons = {};
  for (const item of recent) {
    reasons[item.id] = '近期活跃记忆回流';
  }
  return { selectedMemories: recent, reasons, fallbackUsed: 'recent_window' };
}

/** 按主题为结构化检查点摘要做分句级过滤（与 TS 版同规则） */
function filterSummaryByTopic(summaryText, queryKeywords) {
  if (!summaryText || !queryKeywords || queryKeywords.length === 0) return summaryText;
  if (!summaryText.includes('【会话事实与检查点】') && !summaryText.includes('- 关键约定与核心事实')) {
    return summaryText;
  }

  const lines = summaryText.split('\n');
  const filteredLines = [];

  for (const line of lines) {
    if (!line.startsWith('- ') || !line.includes('：')) {
      filteredLines.push(line);
      continue;
    }
    const colonIdx = line.indexOf('：');
    const prefix = line.slice(0, colonIdx + 1);
    const content = line.slice(colonIdx + 1);
    const clauses = content.split('；');

    const matchedClauses = [];
    for (const clause of clauses) {
      if (!clause.trim()) continue;
      const score = matchTopicRelevance(queryKeywords, clause);
      if (score > 0) matchedClauses.push(clause.trim());
    }

    if (matchedClauses.length > 0) {
      filteredLines.push(`${prefix}${matchedClauses.join('；')}`);
    } else {
      const score = matchTopicRelevance(queryKeywords, line);
      if (score > 0) filteredLines.push(line);
    }
  }

  return filteredLines.length > 1 ? filteredLines.join('\n') : summaryText;
}

/* ------------------------------------------------------------------ *
 * 权威上下文组装（API 与 Codex 共用；主进程唯一生产入口）
 * ------------------------------------------------------------------ */

const SCENE_PRINCIPLE =
  '【场景与身份原则】：你仍是同一个成员，模式只改变在场者与表达场景；自己的私聊记忆可用于理解使用者要求，不无缘无故整段公开私人历史；使用者主动要求介绍刚才的灵感时，可把相关灵感带入当前讨论。';

function failAssembly(requestId, conversationId, targetAgentId, reason, preparedSources) {
  return {
    ok: false,
    reason,
    receipt: {
      requestId,
      conversationId,
      targetAgentId,
      preparedSources: preparedSources || [],
      injectedSources: [],
      status: 'failed',
      totalBudgetChars: MAX_TOTAL_BUDGET,
      usedChars: 0,
      error: reason,
      timestamp: Date.now(),
    },
  };
}

/**
 * 权威组装一次对话轮。
 * @param authData 权威存储解析出的完整数据（DataStore.read）
 * @param req { requestId, conversationId, targetAgentId, currentText, cutoffTime?, extraMemoryGatewayMemories? }
 */
function assembleAuthoritativeTurn(authData, req) {
  if (!authData || typeof authData !== 'object') {
    return failAssembly(req && req.requestId, req && req.conversationId, req && req.targetAgentId, '权威存储未就绪或已损坏，已拦截请求');
  }
  const requestId = typeof req.requestId === 'string' ? req.requestId : `req_${Date.now().toString(36)}`;
  const conversationId = req.conversationId;
  const targetAgentId = req.targetAgentId;
  const currentText = typeof req.currentText === 'string' ? req.currentText : '';
  if (!conversationId || !targetAgentId) {
    return failAssembly(requestId, conversationId, targetAgentId, '缺少会话或目标成员');
  }
  if (!currentText.trim()) {
    return failAssembly(requestId, conversationId, targetAgentId, '本轮输入为空');
  }
  if (currentText.length > 32000) {
    return failAssembly(requestId, conversationId, targetAgentId, '本轮输入超过安全上限 (32000 字符)');
  }

  const conversation = (authData.conversations || []).find((c) => c.id === conversationId);
  if (!conversation) {
    return failAssembly(requestId, conversationId, targetAgentId, `会话 ${conversationId} 未注册或不存在`);
  }
  const isDirect = conversation.kind === 'direct';
  if (isDirect && conversation.agentId !== targetAgentId) {
    return failAssembly(requestId, conversationId, targetAgentId, `会话 ${conversationId} 属于成员 ${conversation.agentId}，禁止成员 ${targetAgentId} 使用`);
  }

  const cutoffTime = typeof req.cutoffTime === 'number' && Number.isFinite(req.cutoffTime) ? req.cutoffTime : Infinity;

  const filtered = filterAuthorizedDataCjs(authData, targetAgentId, cutoffTime, false);
  let authorizedDirectMessages = filtered.authorizedDirectMessages;
  let authorizedLivingRoomMessages = filtered.authorizedLivingRoomMessages;
  const { targetAgent, targetDirectConv, livingRoomConv, authorizedMemories, authorizedCheckpoints } = filtered;

  // 工单 08-R3 提交屏障配套：本轮自身消息（刚追加的用户消息 / 过去重试的原话）不得
  // 再作为历史或召回来源重复注入——currentText 只出现一次。
  const excludeMessageIds = new Set(
    Array.isArray(req.excludeMessageIds)
      ? req.excludeMessageIds.filter((x) => typeof x === 'string' && x)
      : [],
  );
  if (excludeMessageIds.size > 0) {
    const notExcluded = (m) => !excludeMessageIds.has(m.id);
    authorizedDirectMessages = authorizedDirectMessages.filter(notExcluded);
    authorizedLivingRoomMessages = authorizedLivingRoomMessages.filter(notExcluded);
  }

  if (!targetAgent) {
    return failAssembly(requestId, conversationId, targetAgentId, `权威存储中未找到成员 ${targetAgentId}`);
  }

  const authProfile = targetAgent.profileId
    ? (authData.chatProfiles || []).find((p) => p.id === targetAgent.profileId) || null
    : null;

  const targetAgentName = targetAgent.name || '伙伴';
  const isDemo = targetAgent.mode === 'demo' || !authProfile;
  const useExternalMemory = req.externalMemoryContext?.engine === 'ExternalMemory';

  /* ---- 检查点派生（有界），主进程只派生不落盘，交由渲染进程经产品保存事务提交 ---- */
  const dmDerive = targetDirectConv && !useExternalMemory
    ? autoDeriveCheckpoints(targetDirectConv.id, authorizedDirectMessages, authData.checkpoints || [], targetAgentName, true)
    : { activeCheckpoint: null, updatedCheckpoints: authData.checkpoints || [] };
  const lrDerive = livingRoomConv && !useExternalMemory
    ? autoDeriveCheckpoints(livingRoomConv.id, authorizedLivingRoomMessages, dmDerive.updatedCheckpoints, '大家', false)
    : { activeCheckpoint: null, updatedCheckpoints: dmDerive.updatedCheckpoints };
  const updatedCheckpoints = lrDerive.updatedCheckpoints;

  const dmCheckpoint = !useExternalMemory && (dmDerive.activeCheckpoint
    || authorizedCheckpoints.find(
      (c) => targetDirectConv && c.conversationId === targetDirectConv.id && isCheckpointValid(c, authorizedDirectMessages),
    ));
  const lrCheckpoint = !useExternalMemory && (lrDerive.activeCheckpoint
    || authorizedCheckpoints.find(
      (c) => livingRoomConv && c.conversationId === livingRoomConv.id && isCheckpointValid(c, authorizedLivingRoomMessages),
    ));

  /* ---- 关键词与召回 ---- */
  const allParticipantNames = ['使用者', targetAgentName, ...(authData.agents || []).flatMap((a) => [a.name, a.id])].filter(Boolean);
  const queryKeywords = extractKeywords(currentText, allParticipantNames);

  const lexical=useExternalMemory?{selectedMemories:[],reasons:{},fallbackUsed:'none'}:queryRelevantMemories(authorizedMemories, currentText);
  const semantic=(req.semanticMemoryIds||[]).map(id=>authorizedMemories.find(m=>m.id===id)).filter(Boolean);
  const selectedMemories=useExternalMemory?[]:[...new Map([...semantic,...lexical.selectedMemories].map(m=>[m.id,m])).values()].slice(0,3);
  const reasons={...lexical.reasons,...Object.fromEntries(semantic.map(m=>[m.id,'ExternalMemory 语义召回']))};
  const fallbackUsed=useExternalMemory?'externalMemory-hook':semantic.length?'externalMemory-semantic':lexical.fallbackUsed;

  /* ---- 参考块构建（工单 08-R3）：块由"部分(part)"组成，每个 part 可携带自己的来源；
       是否注入由最终序列化逐 part 决定，收据按实际写入 wire 的 part 逐源登记 ---- */
  const preparedMetas = [];
  const registerPrepared = (meta) => {
    preparedMetas.push({ ...meta, injected: false });
    return meta;
  };

  // 块结构：{ meta(块级来源，可为空), parts: [{ text, source? }] }
  const referenceBlocks = [];
  const pushPartsBlock = (meta, parts) => {
    const usable = parts.filter((pt) => pt && pt.text && pt.text.trim());
    if (usable.length === 0) return;
    referenceBlocks.push({
      meta: meta ? registerPrepared(meta) : null,
      parts: usable.map((pt) => ({ text: pt.text, source: pt.source || null })),
    });
  };
  const pushTextBlock = (meta, text) => {
    if (!text || !text.trim()) return;
    pushPartsBlock(meta, [{ text }]);
  };

  // ExternalMemory alone selects long-term materials. Recheck live originals here,
  // including edits/deletions that raced the asynchronous recall request.
  if(useExternalMemory) {
    const originals=[...authorizedDirectMessages,...authorizedLivingRoomMessages];
    const digest=text=>require('node:crypto').createHash('sha256').update(text).digest('hex').slice(0,24);
    const allowedConvs=new Set([targetDirectConv?.id,livingRoomConv?.id]);
    for(const note of req.externalMemoryContext.notes||[]) {
      if(!allowedConvs.has(note.conversationId))continue;
      if(note.sourceMemoryId) {
        if(!authorizedMemories.some(m=>m.id===note.sourceMemoryId&&m.content===note.content))continue;
      } else if(!note.sourceMessageIds?.length || !note.sourceMessageIds.every(id=>originals.some(m=>m.id===id&&m.conversationId===note.conversationId&&digest(m.text)===note.sourceHashes?.[id])))continue;
      const id=note.sourceMemoryId||`externalMemory:${note.conversationId}:${note.engineId}`;
      const timestamp=note.sourceMemoryId?authorizedMemories.find(m=>m.id===note.sourceMemoryId).createdAt:
        Math.max(...note.sourceMessageIds.map(id=>originals.find(m=>m.id===id).createdAt));
      pushTextBlock({id,title:note.title,sourceType:'memory',sourceConversationId:note.conversationId,
        engineId:note.engineId,revision:note.revision,sourceMessageIds:note.sourceMessageIds,
        reason:'ExternalMemory 选中的记忆',timestamp},
        `[ExternalMemory ${note.kind} ref=${note.engineId} revision=${note.revision}]\n${note.title}\n${note.recallText||note.content}`);
    }
  }

  // 长时记忆召回（候选与已确认事实分列，只有真正写入 payload 的行记为 injected）
  const confirmedMemoryLines = [];
  const confirmedLineOwners = [];
  const candidateMemoryLines = [];
  const candidateLineOwners = [];
  let memoryBudget = 2500;
  for (const m of selectedMemories) {
    if (memoryBudget <= 50) break;
    const isCand = m.status === 'candidate' || m.status === 'model_inference' || Boolean(m.candidate);
    const title = m.title ? `【${m.title.slice(0, 100)}】` : '';
    const maxTake = Math.min(m.content.length, Math.min(1000, memoryBudget));
    const safeContent = m.content.length > maxTake ? `${m.content.slice(0, maxTake)}…` : m.content;
    const prefix = isCand ? '（候选待审）' : '';
    const line = `- ${prefix}${title}${safeContent}`;
    if (isCand) {
      candidateMemoryLines.push(line);
      candidateLineOwners.push(m);
    } else {
      confirmedMemoryLines.push(line);
      confirmedLineOwners.push(m);
    }
    memoryBudget -= line.length;
  }
  const memoryMetaById = new Map();
  for (const m of authorizedMemories) {
    const isCand = m.status === 'candidate' || m.status === 'model_inference' || Boolean(m.candidate);
    memoryMetaById.set(m.id, {
      id: m.id,
      title: m.title || m.content.slice(0, 30),
      sourceType: 'memory',
      status: isCand ? 'candidate' : 'confirmed',
      candidate: isCand,
      authorAgentId: m.authorAgentId,
      timestamp: m.updatedAt || m.createdAt,
      reason: reasons[m.id] || (isCand ? '候选推断记忆（待审阅）' : '已确认长时记忆'),
    });
  }

  // 相关原话检索（B1）：从全部授权原始记录中检索主题命中，不限于检查点摘要或近期窗口
  const isAskingGroupConsensus =
    queryKeywords.some((k) => ['客厅', '共识', '群聊', '大家', '讨论', '早期'].includes(k)) ||
    /群|客厅|共识|大家|公开发言|讨论/.test(currentText) ||
    (authData.agents || []).some((a) => a.id !== targetAgentId && currentText.includes(a.name));

  // 结构化历史窗口：直接会话按 contextLimit*2（缺省 24），客厅取最近 12 条，检索时排除窗口内消息
  const windowCount = isDirect
    ? (authProfile && typeof authProfile.contextLimit === 'number' && authProfile.contextLimit > 0 ? authProfile.contextLimit * 2 : 24)
    : 12;

  const recallFrom = (msgs, excludeIds, sourceType, blockTitle, limit = 6, perLineCap = 600) => {
    if(useExternalMemory)return null;
    const semanticIds=new Set(req.semanticMessageIds||[]);
    if ((!queryKeywords.length&&!semanticIds.size) || !msgs.length) return null;
    const scored = msgs
      .filter((m) => !excludeIds.has(m.id))
      .map((m) => ({ m, score: semanticIds.has(m.id)?10000:matchTopicRelevance(queryKeywords, m.text) }))
      .filter((x) => x.score > 0 && (!useExternalMemory || semanticIds.has(x.m.id)))
      .sort((a, b) => b.score - a.score || b.m.createdAt - a.m.createdAt)
      .slice(0, limit);
    if (scored.length === 0) return null;
    const parts = [{ text: blockTitle }];
    const metas = [];
    for (const { m } of scored) {
      const speaker = m.agentId === 'agent_owner'
        ? '使用者'
        : (((authData.agents || []).find((a) => a.id === m.agentId) || {}).name || '伙伴');
      // 工单 08-R4：AI 成员在 wire 中携带稳定 speakerId（agentId），同名成员可区分
      const speakerLabel = m.agentId === 'agent_owner' ? speaker : `${speaker}|${m.agentId}`;
      const text = m.text.length > perLineCap ? `${m.text.slice(0, perLineCap)}…` : m.text;
      const meta = {
        id: m.id,
        title: `相关原话：${m.text.slice(0, 24)}`,
        sourceType,
        sourceConversationId: m.conversationId,
        authorAgentId: m.agentId,
        authorName: speaker,
        chatMode: sourceType === 'direct_history' ? 'direct' : 'living-room',
        timestamp: m.createdAt,
        ...(m.editedAt ? { editedAt: m.editedAt } : {}),
        // sourceContentHash = 原始消息全文哈希；payloadHash/injectedChars 由收据按实际写入片段计算
        sourceContentHash: contentHash(m.text),
        reason: semanticIds.has(m.id)?'ExternalMemory 语义召回原话':`主题相关原话检索命中（得分 ${matchTopicRelevance(queryKeywords, m.text)}）`,
      };
      metas.push(meta);
      const timeStr = formatMessageTimeCjs(m);
      parts.push({ text: `【${timeStr}】[${speakerLabel}]: ${text}`, source: registerPrepared(meta) });
    }
    return { parts, metas };
  };

  // 历史窗口内的消息集合（检索块只收窗口外的中段命中，避免与历史重复）
  const dmExcludeCount = isDirect ? windowCount : 2;
  const directWindowIds = new Set(authorizedDirectMessages.slice(-dmExcludeCount).map((m) => m.id));
  const lrWindowCount = isDirect ? 6 : 8;
  const lrWindowIds = new Set(authorizedLivingRoomMessages.slice(-lrWindowCount).map((m) => m.id));

  const dmRecall = recallFrom(authorizedDirectMessages, directWindowIds, 'direct_history', '【相关私聊原话检索（你的个人记忆）】');
  const lrRecall = recallFrom(authorizedLivingRoomMessages, lrWindowIds, 'living_room_history', '【相关客厅公开发言检索】');

  if (isDirect && dmCheckpoint) {
    pushTextBlock(
      {
        id: dmCheckpoint.id,
        title: '前序会话事实检查点',
        sourceType: 'checkpoint',
        sourceConversationId: dmCheckpoint.conversationId,
        timestamp: dmCheckpoint.createdAt,
        // 工单 08-R4：摘要来源保留实际检查点 ID/覆盖哈希/覆盖范围
        sourceMessagesHash: dmCheckpoint.sourceMessagesHash,
        coverage: dmCheckpoint.sourceMessageRange,
        reason: '私聊前序历史事实折叠摘要',
      },
      `【你与使用者的前序会话事实检查点】：\n${dmCheckpoint.summary}`,
    );
  }

  if (!isDirect && dmCheckpoint) {
    const filteredSummary = filterSummaryByTopic(dmCheckpoint.summary, queryKeywords);
    if (filteredSummary.trim()) {
      pushTextBlock(
        {
          id: dmCheckpoint.id,
          title: '私聊个人经历检查点',
          sourceType: 'checkpoint',
          sourceConversationId: dmCheckpoint.conversationId,
          timestamp: dmCheckpoint.createdAt,
          sourceMessagesHash: dmCheckpoint.sourceMessagesHash,
          coverage: dmCheckpoint.sourceMessageRange,
          reason: '跨模式私聊记忆摘要',
        },
        `【你与使用者的私聊经历摘要（你的个人记忆，未在群内公开）】：\n${filteredSummary}`,
      );
    }
  }

  if (dmRecall) {
    pushPartsBlock(null, dmRecall.parts);
  }

  if (isDirect && authProfile && authProfile.providerType === 'codex-app-server') {
    // 工单 09-R1：Codex 单轮 turn 模式下注入近期私聊历史作为参考背景（附原始发生北京时间）
    const directRecentMsgs = authorizedDirectMessages.slice(-10);
    if (directRecentMsgs.length > 0) {
      const directParts = [{ text: '【你与使用者的近期私聊记录】' }];
      for (const m of directRecentMsgs) {
        const speaker = m.agentId === 'agent_owner' ? '使用者' : targetAgentName;
        const speakerLabel = m.agentId === 'agent_owner' ? speaker : `${speaker}|${m.agentId}`;
        const timeStr = formatMessageTimeCjs(m);
        directParts.push({
          text: `【${timeStr}】[${speakerLabel}]: ${m.text}`,
          source: registerPrepared({
            id: m.id,
            title: `私聊历史：${m.text.slice(0, 24)}`,
            sourceType: 'direct_history',
            sourceConversationId: targetDirectConv ? targetDirectConv.id : m.conversationId,
            authorAgentId: m.agentId,
            authorName: speaker,
            chatMode: 'direct',
            timestamp: m.createdAt,
            ...(m.editedAt ? { editedAt: m.editedAt } : {}),
            sourceContentHash: contentHash(m.text),
            reason: '私聊历史记录（逐消息来源）',
          }),
        });
      }
      pushPartsBlock(
        {
          id: targetDirectConv ? targetDirectConv.id : 'dm_recent_history',
          title: '私聊近期历史',
          sourceType: 'direct_history',
          sourceConversationId: targetDirectConv ? targetDirectConv.id : undefined,
          timestamp: Date.now(),
          reason: '私聊历史记录（集合块标注，逐消息来源见各 part）',
          aggregate: true,
        },
        directParts,
      );
    }
  }

  if (!isDirect) {
    // 工单 08-R4：跨模式私聊近期回流改为逐消息 part——每条实际进入 wire 的原话
    // 各自登记真实 messageId/会话/作者/模式/版本与源内容哈希；集合块仅作 aggregate 标注。
    const privateRecentMsgs = authorizedDirectMessages.slice(-2);
    // 无私聊消息时不构造只有标题的空块（避免收据虚增）
    if (privateRecentMsgs.length > 0) {
      const privateParts = [{ text: '【你与使用者的私聊近期记录（你的个人记忆，未在群内公开）】' }];
      for (const m of privateRecentMsgs) {
        const speaker = m.agentId === 'agent_owner' ? '使用者' : targetAgentName;
        const timeStr = formatMessageTimeCjs(m);
        privateParts.push({
          text: `【${timeStr}】[${speaker}]: ${m.text}`,
          source: registerPrepared({
            id: m.id,
            title: `私聊原话：${m.text.slice(0, 24)}`,
            sourceType: 'direct_history',
            sourceConversationId: targetDirectConv ? targetDirectConv.id : m.conversationId,
            authorAgentId: m.agentId,
            authorName: speaker,
            chatMode: 'direct',
            timestamp: m.createdAt,
            ...(m.editedAt ? { editedAt: m.editedAt } : {}),
            sourceContentHash: contentHash(m.text),
            reason: '跨模式私聊历史回流（逐消息来源）',
          }),
        });
      }
      pushPartsBlock(
        {
          id: targetDirectConv ? targetDirectConv.id : 'dm_history',
          title: '本人私聊灵感记录',
          sourceType: 'direct_history',
          sourceConversationId: targetDirectConv ? targetDirectConv.id : undefined,
          timestamp: Date.now(),
          reason: '跨模式私聊历史回流（集合块标注，逐消息来源见各 part）',
          aggregate: true,
        },
        privateParts,
      );
    }
  }

  if (lrRecall) {
    pushPartsBlock(null, lrRecall.parts);
  }

  if (isDirect && (isAskingGroupConsensus || authorizedLivingRoomMessages.length > 20) && lrCheckpoint) {
    pushTextBlock(
      {
        id: lrCheckpoint.id,
        title: '客厅早期共识检查点',
        sourceType: 'checkpoint',
        sourceConversationId: lrCheckpoint.conversationId,
        timestamp: lrCheckpoint.createdAt,
        sourceMessagesHash: lrCheckpoint.sourceMessagesHash,
        coverage: lrCheckpoint.sourceMessageRange,
        reason: '客厅公开共识回流',
      },
      `【客厅公开讨论共识与检查点】：\n${filterSummaryByTopic(lrCheckpoint.summary, queryKeywords)}`,
    );
  }

  // 工单 08-R4：客厅近期公开讨论改为逐消息 part（稳定 speakerId = 名字|agentId），
  // 同时记录进入参考块的消息 ID，供结构化历史窗口排除、避免同一原话重复占用预算。
  let lrRecentMsgs = [];
  if (authorizedLivingRoomMessages.length > 0 && (!isDirect || isAskingGroupConsensus)) {
    lrRecentMsgs = authorizedLivingRoomMessages.slice(-lrWindowCount);
    const lrParts = [{ text: '【客厅近期公开讨论记录】' }];
    for (const m of lrRecentMsgs) {
      const author = (authData.agents || []).find((a) => a.id === m.agentId);
      const authorName = author ? author.name : (m.agentId === 'agent_owner' ? '使用者' : '伙伴');
      const speakerLabel = m.agentId === 'agent_owner' ? authorName : `${authorName}|${m.agentId}`;
      const timeStr = formatMessageTimeCjs(m);
      lrParts.push({
        text: `【${timeStr}】[${speakerLabel}]: ${m.text}`,
        source: registerPrepared({
          id: m.id,
          title: `客厅公开发言：${m.text.slice(0, 24)}`,
          sourceType: 'living_room_history',
          sourceConversationId: livingRoomConv ? livingRoomConv.id : m.conversationId,
          authorAgentId: m.agentId,
          authorName,
          chatMode: 'living-room',
          timestamp: m.createdAt,
          ...(m.editedAt ? { editedAt: m.editedAt } : {}),
          sourceContentHash: contentHash(m.text),
          reason: '客厅近期公开上下文（逐消息来源）',
        }),
      });
    }
    pushPartsBlock(
      {
        id: 'living_room_highlights',
        title: '客厅近期公开讨论',
        sourceType: 'living_room_history',
        timestamp: Date.now(),
        reason: '群聊公开上下文回流（集合块标注，逐消息来源见各 part）',
        aggregate: true,
      },
      lrParts,
    );
  }

  if (confirmedMemoryLines.length > 0) {
    const memParts = [{ text: '【长期记忆（已确认事实）】' }];
    confirmedMemoryLines.forEach((line, idx) => {
      const owner = confirmedLineOwners[idx];
      const meta = memoryMetaById.get(owner.id);
      memParts.push({ text: line, source: meta ? registerPrepared(meta) : null });
    });
    pushPartsBlock(
      {
        id: 'confirmed_memory_block',
        title: '长期记忆（已确认事实）',
        sourceType: 'memory',
        timestamp: Date.now(),
        reason: '已确认长期记忆注入',
      },
      memParts,
    );
  }

  if (candidateMemoryLines.length > 0) {
    const candParts = [{ text: '【候选推断（待审阅，非确认事实）】' }];
    candidateMemoryLines.forEach((line, idx) => {
      const owner = candidateLineOwners[idx];
      const meta = memoryMetaById.get(owner.id);
      candParts.push({ text: line, source: meta ? registerPrepared(meta) : null });
    });
    pushPartsBlock(
      {
        id: 'candidate_memory_block',
        title: '候选推断（待审阅，非确认事实）',
        sourceType: 'memory',
        timestamp: Date.now(),
        reason: '候选推断记忆注入（待审阅）',
      },
      candParts,
    );
  }

  const safeExtraMemories = (useExternalMemory?[]:req.extraMemoryGatewayMemories || []).filter((s2) => s2 && String(s2).trim());
  if (safeExtraMemories.length > 0) {
    const extraParts = [{ text: '【外部记忆召回（低信任参考资料）】' }];
    for (const m of safeExtraMemories) extraParts.push({ text: `- ${m}` });
    pushPartsBlock(
      {
        id: 'memoryGateway_extra',
        title: '外部记忆召回',
        sourceType: 'memoryGateway',
        timestamp: Date.now(),
        reason: '外部旁路记忆（低信任参考）',
      },
      extraParts,
    );
  }

  /* ---- 工单 09：所有成员统一获得真实北京时间与上次交流时间 ---- */
  const requestNowMs = typeof req.nowMs === 'number' && Number.isFinite(req.nowMs)
    ? req.nowMs
    : Date.now();

  const bjNow = getBeijingTimeCjs(requestNowMs);

  // 计算与使用者上一次交流时间（沿该成员连续记忆线跨私聊/客厅计算，排除本轮输入、空占位、失败与 cutoffTime 之后的历史）
  const lastInteraction = findLastInteractionCjs(
    authData.messages || [],
    authData.conversations || [],
    targetAgentId,
    {
      nowMs: requestNowMs,
      cutoffTime: req.cutoffTime,
      excludeIds: excludeMessageIds,
    }
  );

  const timeNotice = `【当前北京时间：${bjNow.formattedFull}。当前模式：${isDirect ? '私聊' : '客厅群聊'}。你与使用者上一次交流：${lastInteraction.description}。历史消息的时间属于当时，不代表现在；没有依据时不要编造早晚、离开多久或期间发生的事。】`;

  /* ---- 可信人格与场景说明（只来自权威存储，不做关键词清空） ---- */
  const personality = (targetAgent.systemPrompt && targetAgent.systemPrompt.trim())
    || (authProfile && authProfile.developerInstructions && authProfile.developerInstructions.trim())
    || '你是一位温暖可靠的伙伴。';

  const participants = isDirect
    ? ['使用者', targetAgentName]
    : ['使用者', ...(authData.agents || []).map((a) => a.name)];

  const sceneGuide = isDirect
    ? '【当前场景：私聊直连房间 | 交流对象：使用者 | 原则：保持专属亲密与个人记忆连续】'
    : `【当前场景：小屋客厅多人公共大厅 | 在场者：${participants.join('、')} | 原则：全家在场同屏交流，使用者此话为当众发言。有事直接现场交流或@成员联动，严禁使用“去客厅”等跨房间调度话术】`;

  const codexDeveloperInstructions = `${SCENE_PRINCIPLE}\n\n${sceneGuide}\n\n${personality}\n\n${replyInstructions}`;
  let apiSystemPrompt = `${personality}\n\n${sceneGuide}\n\n${timeNotice}\n\n${replyInstructions}`;
  if(useExternalMemory)apiSystemPrompt=apiSystemPrompt.replace(`\n\n${timeNotice}`,'');

  /* ---- 预算内按相关性选择参考部分（工单 08-R3 第3条）----
   * 1) 块按主题相关性降序排列（无关块最先被裁）；
   * 2) 块内逐 part 装入，放不下的 part 跳过并继续尝试更小的后续 part；
   * 3) 当前输入与可信人格完整保留； personality+输入本身超限才明确拒绝。
   */
  const blockRelevance = (blk) => {
    if (!queryKeywords.length) return 0;
    return blk.parts.reduce((n, pt) => n + matchTopicRelevance(queryKeywords, pt.text), 0);
  };
  const fitReferenceParts = (budgetChars) => {
    const ordered = referenceBlocks
      .map((blk, idx) => ({ blk, idx, score: blockRelevance(blk) }))
      .sort((a, b) => useExternalMemory?a.idx-b.idx:b.score-a.score||a.idx-b.idx);
    let used = 0;
    let includedBlockCount = 0;
    /** blockIdx -> [partIdx...]（保持块内原始顺序写入） */
    const included = new Map();
    for (const { blk, idx } of ordered) {
      for (let pi = 0; pi < blk.parts.length; pi++) {
        const part = blk.parts[pi];
        const already = included.get(idx);
        // 工单 08-R4：cost 计入最终拼接的真实结构——块内 part 间 1 个换行、
        // 块间 2 个换行分隔符，保证预算按最终序列化文本计算。
        let cost = part.text.length + (already && already.length > 0 ? 1 : 0);
        if (!already && includedBlockCount > 0) cost += 2;
        if (used + cost <= budgetChars) {
          used += cost;
          if (!included.has(idx)) {
            included.set(idx, []);
            includedBlockCount += 1;
          }
          included.get(idx).push(pi);
        }
      }
    }
    // 还原原始块顺序，拼最终文本
    const includedBlocks = [];
    let refText = '';
    for (let idx = 0; idx < referenceBlocks.length; idx++) {
      if (!included.has(idx)) continue;
      const blk = referenceBlocks[idx];
      const partIdxs = included.get(idx);
      const chosenParts = partIdxs.map((pi) => blk.parts[pi]);
      const blockText = chosenParts.map((pt) => pt.text).join('\n');
      includedBlocks.push({ meta: blk.meta, parts: chosenParts, text: blockText });
      refText = refText ? `${refText}\n\n${blockText}` : blockText;
    }
    return { includedBlocks, refText, usedChars: used };
  };

  /** 收据（工单 08-R3/08-R4）：逐源登记实际写入 wire 的 part——每个 sourceId 对应自己的
   * 片段 hash/chars；身份（作者名/模式/版本边界）与源内容哈希/片段哈希含义分明。
   * extraSources 用于结构化历史窗口中逐消息注入的来源登记。 */
  const buildReceipt = (includedBlocks, usedChars, status, error, extraSources = []) => {
    const injectedSources = [];
    const pushInjected = (meta, snippetText, blockId) => {
      if (!meta) return;
      injectedSources.push({
        id: meta.id,
        title: meta.title,
        sourceType: meta.sourceType,
        sourceConversationId: meta.sourceConversationId,
        authorAgentId: meta.authorAgentId,
        timestamp: meta.timestamp,
        injected: true,
        reason: meta.reason,
        injectedChars: (snippetText || '').length,
        payloadHash: contentHash(snippetText || ''),
        // 工单 08-R4：完整登记来源身份与版本边界
        ...(meta.authorName ? { authorName: meta.authorName } : {}),
        ...(meta.chatMode ? { chatMode: meta.chatMode } : {}),
        ...(meta.editedAt ? { editedAt: meta.editedAt } : {}),
        ...(meta.sourceContentHash ? { sourceContentHash: meta.sourceContentHash } : {}),
        ...(meta.aggregate ? { aggregate: true } : {}),
        ...(meta.sourceMessagesHash ? { sourceMessagesHash: meta.sourceMessagesHash } : {}),
        ...(meta.coverage ? { coverage: meta.coverage } : {}),
        ...(meta.engineId ? { engineId:meta.engineId,revision:meta.revision,sourceMessageIds:meta.sourceMessageIds } : {}),
        ...(blockId ? { blockId } : {}),
      });
    };
    for (const blk of includedBlocks) {
      let blockHasSourcedParts = false;
      for (const part of blk.parts) {
        if (part.source) {
          blockHasSourcedParts = true;
          pushInjected(part.source, part.text, blk.meta ? blk.meta.id : undefined);
        }
      }
      // 无逐源 part 的块（整体来源块）用块级来源登记
      if (!blockHasSourcedParts && blk.meta) {
        pushInjected(blk.meta, blk.text);
      }
    }
    for (const { meta, snippet } of extraSources) {
      pushInjected(meta, snippet);
    }
    const injectedIds = new Set(injectedSources.map((s2) => s2.id));
    const preparedSources = [];
    for (const meta of preparedMetas) {
      let injected = injectedIds.has(meta.id);
      // 集合块：其逐消息 part 有注入即视为该集合（经由 part）注入；不借集合 ID 表示具体片段
      if (!injected && meta.aggregate) {
        injected = injectedSources.some((s2) => s2.blockId === meta.id);
      }
      preparedSources.push({ ...meta, injected });
    }
    return {
      requestId,
      conversationId,
      targetAgentId,
      preparedSources,
      injectedSources,
      status,
      totalBudgetChars: MAX_TOTAL_BUDGET,
      usedChars,
      fallbackUsed,
      error,
      timestamp: Date.now(),
      ...(useExternalMemory?{memoryEngine:'ExternalMemory',memoryState:req.externalMemoryContext.state,recallDiagnostics:req.externalMemoryContext.diagnostics||[]}:{}),
    };
  };

  if (isDemo) {
    // 演示模式：不请求任何外部模型，直接以轻量上下文返回（不做预算拒绝，保持演示可用）
    const { includedBlocks, refText } = fitReferenceParts(MAX_TOTAL_BUDGET);
    const messages = [];
    messages.push({ role: 'system', content: apiSystemPrompt });
    if (refText) messages.push({ role: 'user', content: refText });
    messages.push({ role: 'user', content: currentText });
    const usedChars = messages.reduce((n, m) => n + m.content.length, 0);
    return {
      ok: true,
      isDemo: true,
      protocol: 'api',
      apiMessages: messages,
      profile: authProfile || undefined,
      receipt: buildReceipt(includedBlocks, usedChars, refText ? 'injected' : 'prepared', undefined),
      updatedCheckpoints,
    };
  }

  if (authProfile && authProfile.providerType === 'codex-app-server') {
    const header = isDirect
      ? `【当前场景：私聊 | 交流对象：使用者】\n${timeNotice}`
      : `【当前场景：客厅群聊 | 在场者：${participants.join('、')}】\n${timeNotice}`;

    // 最终序列化的固定部分：header + 分隔 + '[使用者]: ' + 当前输入（完整保留）。
    // 工单 08-R4：块间双换行分隔计入参考预算（fit 时扣除），提前拒绝只看固定部分本身，
    // 保证"人格+输入恰好填满 16000"的无参考输入可以放行。
    const turnFixedTail = `\n\n[使用者]: ${currentText}`;
    const fixedBase = header.length + turnFixedTail.length + codexDeveloperInstructions.length;
    if (fixedBase > MAX_TOTAL_BUDGET) {
      const failed = failAssembly(
        requestId,
        conversationId,
        targetAgentId,
        `输入内容与授权人格总长度（共 ${fixedBase} 字符）已超出单次最大预算上限（${MAX_TOTAL_BUDGET} 字符），请精简内容后发送`,
      );
      failed.receipt.usedChars = fixedBase;
      return { ...failed, updatedCheckpoints };
    }

    // 按相关性逐 part 装入参考（无关块最先裁掉，放得下的相关事实保留）
    const { includedBlocks, refText } = fitReferenceParts(MAX_TOTAL_BUDGET - fixedBase - 2);
    const turnText = refText
      ? `${header}\n\n${refText}${turnFixedTail}`
      : `${header}${turnFixedTail}`;
    const total = codexDeveloperInstructions.length + turnText.length;
    const canonicalThreadId = targetAgent.canonicalCodexThreadId
      || (targetDirectConv && targetDirectConv.codexThreadId)
      || null;

    // 工单 08-R4：最终序列化文本上再次核对预算；固定输入/人格仍越界则明确拒绝且模型零启动
    if (total > MAX_TOTAL_BUDGET) {
      const failed = failAssembly(
        requestId,
        conversationId,
        targetAgentId,
        `组装后总长度（共 ${total} 字符）已超出单次最大预算上限（${MAX_TOTAL_BUDGET} 字符），请精简内容后发送`,
      );
      failed.receipt.usedChars = total;
      return { ...failed, updatedCheckpoints };
    }

    const receipt = {
      ...buildReceipt(includedBlocks, total, includedBlocks.length > 0 ? 'injected' : 'prepared', undefined),
      // 工单 08-R4：收据与实际请求 thread 关联——只记权威 canonical thread，不借他人 thread
      ...(canonicalThreadId ? { threadId: canonicalThreadId } : {}),
    };

    return {
      ok: true,
      isDemo: false,
      protocol: 'codex',
      codexTurnText: turnText,
      developerInstructions: codexDeveloperInstructions,
      profile: authProfile,
      canonicalThreadId,
      receipt,
      authorizedParts: includedBlocks.flatMap(b => b.parts.map(p => ({ text:p.text, source:p.source || b.meta }))),
      updatedCheckpoints,
    };
  }

  // 通用 API（openai-compatible）
  const fixedChars = apiSystemPrompt.length + currentText.length + (useExternalMemory?timeNotice.length+2:0);
  if (fixedChars > MAX_TOTAL_BUDGET) {
    const failed = failAssembly(
      requestId,
      conversationId,
      targetAgentId,
      `输入内容与授权人格总长度（共 ${fixedChars} 字符）已超出单次最大预算上限（${MAX_TOTAL_BUDGET} 字符），请精简内容后发送`,
    );
    failed.receipt.usedChars = fixedChars;
    return { ...failed, updatedCheckpoints };
  }

  // 参考按相关性逐 part 装入（无独立上限帽；历史用剩余预算继续装）
  const { includedBlocks, refText } = fitReferenceParts(MAX_TOTAL_BUDGET - fixedChars);
  const availableBudget = MAX_TOTAL_BUDGET - fixedChars - (refText ? refText.length + (useExternalMemory?2:1) : 0);

  // 历史窗口逆向选取（检索块只收窗口外中段命中；已召回消息与客厅近期参考块消息
  // 不再进入历史，避免同一原话重复占用预算——工单 08-R4）
  const historySource = isDirect ? authorizedDirectMessages : authorizedLivingRoomMessages;
  const recalledHistoryIds = new Set([
    ...(dmRecall && isDirect ? dmRecall.metas.map((x) => x.id) : []),
    ...(lrRecall && !isDirect ? lrRecall.metas.map((x) => x.id) : []),
    ...(!isDirect ? lrRecentMsgs.map((m) => m.id) : []),
  ]);
  const maxHistoryCount = authProfile && typeof authProfile.contextLimit === 'number' && authProfile.contextLimit > 0
    ? authProfile.contextLimit * 2
    : historySource.length;

  const selectedWireMsgs = [];
  /** 工单 08-R4：结构化历史逐消息来源登记（与 selectedWireMsgs 同序） */
  const wireMsgSources = [];
  let historyChars = 0;
  for (let i = historySource.length - 1; i >= 0; i--) {
    if (selectedWireMsgs.length >= maxHistoryCount) break;
    const m = historySource[i];
    if (!m) continue;
    if (recalledHistoryIds.has(m.id)) continue;

    let role = 'user';
    const timeStr = formatMessageTimeCjs(m);
    let prefix = '';
    if (m.agentId === 'agent_owner') {
      role = 'user';
    } else if (m.agentId === targetAgentId) {
      role = 'assistant';
    } else if (!isDirect) {
      const otherAgent = (authData.agents || []).find((a) => a.id === m.agentId);
      // 工单 08-R4：群聊 wire 带稳定 speakerId（名字|agentId），同名成员可区分
      prefix = otherAgent ? `[${otherAgent.name}|${m.agentId}] ` : '';
      role = 'user';
    }
    const wireContent = `【${timeStr}】${prefix}${m.text}`;

    const exactItemLen = wireContent.length;
    if (historyChars + exactItemLen <= availableBudget) {
      const speakerName = m.agentId === 'agent_owner'
        ? '使用者'
        : (((authData.agents || []).find((a) => a.id === m.agentId) || {}).name || targetAgentName);
      wireMsgSources.unshift(registerPrepared({
        id: m.id,
        title: `${isDirect ? '私聊' : '客厅'}历史：${m.text.slice(0, 24)}`,
        sourceType: isDirect ? 'direct_history' : 'living_room_history',
        sourceConversationId: m.conversationId,
        authorAgentId: m.agentId,
        authorName: speakerName,
        chatMode: isDirect ? 'direct' : 'living-room',
        timestamp: m.createdAt,
        ...(m.editedAt ? { editedAt: m.editedAt } : {}),
        sourceContentHash: contentHash(m.text),
        reason: '结构化历史窗口（逐消息来源）',
      }));
      selectedWireMsgs.unshift({ role, content: wireContent });
      historyChars += exactItemLen;
    } else {
      break;
    }
  }

  const apiMessages = [];
  apiMessages.push({ role: 'system', content: apiSystemPrompt });
  if (refText && !useExternalMemory) apiMessages.push({ role: 'user', content: refText });
  apiMessages.push(...selectedWireMsgs);
  apiMessages.push({ role: 'user', content: useExternalMemory?[timeNotice,refText,currentText].filter(Boolean).join('\n\n'):currentText });

  const actualWireChars = apiMessages.reduce((sum, msg) => sum + msg.content.length, 0);

  // 工单 08-R4：最终序列化文本上再次核对预算；固定输入/人格仍越界则明确拒绝且模型零启动
  if (actualWireChars > MAX_TOTAL_BUDGET) {
    const failed = failAssembly(
      requestId,
      conversationId,
      targetAgentId,
      `组装后总长度（共 ${actualWireChars} 字符）已超出单次最大预算上限（${MAX_TOTAL_BUDGET} 字符），请精简内容后发送`,
    );
    failed.receipt.usedChars = actualWireChars;
    return { ...failed, updatedCheckpoints };
  }

  const receipt = buildReceipt(
    includedBlocks,
    actualWireChars,
    includedBlocks.length > 0 || wireMsgSources.length > 0 ? 'injected' : 'prepared',
    undefined,
    selectedWireMsgs.map((m2, idx2) => ({ meta: wireMsgSources[idx2], snippet: m2.content })),
  );

  return {
    ok: true,
    isDemo: false,
    protocol: 'api',
    apiMessages,
    profile: authProfile,
    receipt,
    authorizedParts: [
      ...includedBlocks.flatMap(b => b.parts.map(p => ({ text:p.text, source:p.source || b.meta }))),
      ...selectedWireMsgs.map((m, i) => ({ text:m.content, source:wireMsgSources[i] })),
    ],
    updatedCheckpoints,
  };
}

/**
 * 统一受限可信读取：按 ID 查询单条记忆
 * 规则：
 * 1. 存储未就绪或参数缺失返回明确错误；
 * 2. 记忆不存在或已删除返回 NOT_FOUND；
 * 3. 私聊记忆非所属成员访问返回 FORBIDDEN，且绝不泄露正文与标题；
 * 4. 授权成功返回记忆对象。
 * @param {Object} authData 权威数据
 * @param {string} memberId 调用成员 ID
 * @param {string} memoryId 记忆 ID
 */
function readMemoryById(authData, memberId, memoryId) {
  if (!authData || typeof authData !== 'object') {
    return { ok: false, code: 'UNAVAILABLE', error: '存储未就绪' };
  }
  if (!memberId || !memoryId) {
    return { ok: false, code: 'BAD_REQUEST', error: '缺少成员 ID 或记忆 ID' };
  }

  // 1. 成员注册检查：未在 agents 中注册的成员一律拒绝访问
  const registeredMemberIds = new Set((authData.agents || []).map((a) => a.id));
  if (registeredMemberIds.size > 0 && !registeredMemberIds.has(memberId)) {
    return { ok: false, code: 'FORBIDDEN', error: '未注册成员无权访问' };
  }

  const mem = (authData.memories || []).find((m) => m.id === memoryId);
  if (!mem || mem.tombstoned || mem.status === 'deleted' || mem.status === 'invalidated' || mem.status === 'archived') {
    return { ok: false, code: 'NOT_FOUND', error: '记忆不存在' };
  }

  // 2. 范围权限校验：私聊记忆仅所属成员可读；无明确归属（unbound）一律 fail-closed；作者不能覆盖私聊归属
  const isDirect = (mem.scope && mem.scope.type === 'direct') || mem.scope === 'direct' || mem.scopeType === 'direct';
  if (isDirect) {
    const scopeId = (typeof mem.scope === 'object' && mem.scope ? mem.scope.id : null) || mem.scopeId || mem.memberId;
    if (!scopeId) {
      return { ok: false, code: 'FORBIDDEN', error: '无权访问该记忆' };
    }
    let authorized = scopeId === memberId;
    if (!authorized) {
      const conv = (authData.conversations || []).find((c) => c.id === scopeId);
      if (conv && conv.kind === 'direct' && conv.agentId === memberId) {
        authorized = true;
      }
    }
    if (!authorized) {
      return { ok: false, code: 'FORBIDDEN', error: '无权访问该记忆' };
    }
  }

  return { ok: true, memory: mem };
}

module.exports = {
  computeMessagesHash,
  contentHash,
  extractKeywords,
  matchTopicRelevance,
  extractConversationFacts,
  isCheckpointValid,
  autoDeriveCheckpoints,
  filterAuthorizedData: filterAuthorizedDataCjs,
  queryRelevantMemories,
  assembleAuthoritativeTurn,
  getBeijingTime: getBeijingTimeCjs,
  findLastInteraction: findLastInteractionCjs,
  readMemoryById,
  MAX_TOTAL_BUDGET,
};
