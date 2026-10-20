import type {
  AppData,
  AgentId,
  Message,
  MemoryItem,
  ContextCheckpoint,
  TurnContextParams,
  TurnContextResult,
  MemoryDeliveryReceipt,
  MemoryReferenceSource,
} from '../types';
import { getBeijingTime, findLastInteraction } from '../utils/timeBeijing';

/**
 * 快速计算消息序列的确定性哈希，用于检测源消息是否被编辑、删除或插入
 */
export function computeMessagesHash(messages: Array<{ id: string; text: string }>): string {
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

/** 对实际写入 payload 的来源片段计算确定性内容哈希（收据核对用，与 electron/memoryManager.cjs 同算法） */
export function contentHash(str: string): string {
  let hash = 0x811c9dc5;
  const text = typeof str === 'string' ? str : '';
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * 结构化提取真实会话事实（通用提炼，拒绝硬编码与模板僵化）
 */
export function extractConversationFacts(
  messages: Array<{ id: string; agentId: string; text: string; createdAt: number; status: string }>,
  targetAgentName: string = '成员',
  isDirect: boolean = true,
): string {
  const validMsgs = messages.filter((m) => m.status === 'sent' && m.text.trim());
  if (validMsgs.length === 0) return '暂无有效对话事实';

  const firstMsg = validMsgs[0]!;
  const lastMsg = validMsgs[validMsgs.length - 1]!;
  const firstTime = new Date(firstMsg.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const lastTime = new Date(lastMsg.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  // 拆分单条消息中的所有分句
  const splitSentences = (text: string): string[] => {
    return text
      .split(/([。！？\n；;]+)/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0 && !/^[。！？\n；;]+$/.test(s));
  };

  const keyFacts: string[] = [];
  const ownerFacts: string[] = [];
  const otherFacts: string[] = [];

  for (const m of validMsgs) {
    const sentences = splitSentences(m.text);
    for (const sent of sentences) {
      const clean = sent.replace(/\s+/g, ' ').trim();
      if (!clean) continue;
      // 过滤简单问候寒暄
      if (/^(嗯|好的|在的|收到|知道了|好呀|聊得很开心|今天聊得很开心|谢谢|哈哈|拜拜|晚安|早安)[。！!？?~～]*$/i.test(clean)) {
        continue;
      }
      if (!keyFacts.includes(clean)) {
        keyFacts.push(clean);
      }
      if (m.agentId === 'agent_owner') {
        if (!ownerFacts.includes(clean)) ownerFacts.push(clean);
      } else {
        if (!otherFacts.includes(clean)) otherFacts.push(clean);
      }
    }
  }

  // 截取核心事实，避免超长堆叠膨胀（首部保留早期关键灵感，尾部保留近期关键对齐）
  const MAX_FACT_COUNT = 8;
  const boundedKeyFacts = keyFacts.length > MAX_FACT_COUNT ? [...keyFacts.slice(0, 4), ...keyFacts.slice(-4)] : keyFacts;
  const boundedOwner = ownerFacts.length > MAX_FACT_COUNT ? [...ownerFacts.slice(0, 4), ...ownerFacts.slice(-4)] : ownerFacts;
  const boundedOther = otherFacts.length > MAX_FACT_COUNT ? [...otherFacts.slice(0, 4), ...otherFacts.slice(-4)] : otherFacts;

  const quotes = (pattern: RegExp) => keyFacts.filter(s => pattern.test(s)).slice(-4).map(s=>s.slice(0,180)).join('；') || '未提取到明确原话';
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
 * 校验检查点有效性。
 * 核心规则（工单 08-R1）：
 * 1. 显式标记 stale / invalidated 则无效；
 * 2. 必须具备 sourceMessagesHash，无来源证明的旧检查点绝不把缺 hash 当有效来源（直接返回 false）；
 * 3. 必须具备 createdBeforeMessageId 并在当前有效消息中能找到对应的边界；
 * 4. 边界之前的消息哈希必须与 sourceMessagesHash 严格相等，任一修改/删除即失效；
 * 5. 如果有 sourceMessageSnapshots，逐条核对是否存在且未被修改；
 * 6. 不依赖 casual 文本包含“STALE/修改”做误判，依靠真正的源版本/哈希/快照。
 */
export function isCheckpointValid(
  checkpoint: ContextCheckpoint,
  currentMessages: Message[],
): boolean {
  if (!checkpoint) return false;
  if (checkpoint.status === 'stale' || checkpoint.status === 'invalidated') {
    return false;
  }

  // 必须具备源哈希证明；无来源证明的旧检查点绝不把缺 hash 当成有效来源
  if (!checkpoint.sourceMessagesHash) {
    return false;
  }

  // 必须具备切分边界标识
  if (!checkpoint.createdBeforeMessageId) {
    return false;
  }

  const splitIdx = currentMessages.findIndex((m) => m.id === checkpoint.createdBeforeMessageId);
  if (splitIdx < 0) {
    // 边界消息已被物理删除，历史切分依据丧失，直接失效
    return false;
  }

  const coveredMsgs = currentMessages.slice(0, splitIdx + 1);
  if (coveredMsgs.length === 0) {
    return false;
  }

  // 1. 对比源哈希
  const currentHash = computeMessagesHash(coveredMsgs);
  if (currentHash !== checkpoint.sourceMessagesHash) {
    return false;
  }

  // 2. 如果有快照记录，逐条核对是否存在且未被修改
  if (Array.isArray(checkpoint.sourceMessageSnapshots)) {
    for (const snap of checkpoint.sourceMessageSnapshots) {
      const cur = coveredMsgs.find((m) => m.id === snap.id);
      if (!cur || cur.text !== snap.text) {
        return false;
      }
    }
  }

  return true;
}

/**
 * 自动派生检查点与原话折叠（无需用户手动录入）。
 * 当会话有效消息超过滑动窗口（保留最近 8 条）且前序未覆盖时，自动提取事实并记录哈希快照。
 */
export function autoDeriveCheckpoints(
  conversationId: string,
  messages: Message[],
  existingCheckpoints: ContextCheckpoint[],
  targetAgentName: string = '成员',
  isDirect: boolean = true,
): { activeCheckpoint: ContextCheckpoint | null; updatedCheckpoints: ContextCheckpoint[] } {
  const validMsgs = messages.filter(
    (m) => m.conversationId === conversationId && m.status === 'sent' && m.text.trim() && !m.demo && !m.id.startsWith('msg_seed_'),
  );

  // 现有检查点有效性过滤
  const validExisting = (existingCheckpoints || []).filter((cp) => {
    if (cp.conversationId !== conversationId) return false;
    return isCheckpointValid(cp, validMsgs);
  });

  const latestValid = validExisting.length > 0
    ? validExisting.reduce((prev, curr) => (curr.createdAt > prev.createdAt ? curr : prev))
    : null;

  // 如果有效消息小于 8 条，无需折叠
  if (validMsgs.length < 8) {
    return { activeCheckpoint: latestValid, updatedCheckpoints: existingCheckpoints || [] };
  }

  // 保留最近 8 条原话活跃，对前序消息进行事实提炼折叠
  const ACTIVE_TAIL_COUNT = 8;
  const foldBoundaryIdx = validMsgs.length - ACTIVE_TAIL_COUNT - 1;
  if (foldBoundaryIdx < 0) {
    return { activeCheckpoint: latestValid, updatedCheckpoints: existingCheckpoints || [] };
  }

  const boundaryMsg = validMsgs[foldBoundaryIdx]!;
  const coveredMsgs = validMsgs.slice(0, foldBoundaryIdx + 1);

  // 如果最新有效检查点已经覆盖到了这个边界或更后，无需重新生成
  if (latestValid) {
    const coveredIdx = validMsgs.findIndex((m) => m.id === latestValid.createdBeforeMessageId);
    if (coveredIdx >= foldBoundaryIdx) {
      return { activeCheckpoint: latestValid, updatedCheckpoints: existingCheckpoints || [] };
    }
  }

  // 自动派生新检查点（有界版本：增量快照 + 替代式收敛）
  const summary = extractConversationFacts(coveredMsgs, targetAgentName, isDirect);
  const hash = computeMessagesHash(coveredMsgs);

  // 增量快照：上一个有效检查点边界之后的消息才进入本次快照，避免每轮重复保存整个已覆盖前缀
  let snapshots: Array<{ id: string; text: string }> | undefined;
  let prevCheckpointId: string | undefined;
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

  const newCheckpoint: ContextCheckpoint = {
    id: `cp_auto_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    conversationId,
    summary,
    createdBeforeMessageId: boundaryMsg.id,
    createdAt: Date.now(),
    sourceMessageRange: {
      fromId: coveredMsgs[0]?.id,
      toId: boundaryMsg.id,
      count: coveredMsgs.length,
    },
    sourceMessagesHash: hash,
    sourceMessageSnapshots: snapshots,
    prevCheckpointId,
    status: 'active',
  };

  // 替代式收敛：同会话旧检查点全部由新检查点承接（其覆盖范围被新检查点完全覆盖，原始消息永不删除）
  const updatedCheckpoints = [
    ...(existingCheckpoints || []).filter((c) => c.conversationId !== conversationId),
    newCheckpoint,
  ];
  return { activeCheckpoint: newCheckpoint, updatedCheckpoints };
}

/**
 * 停用词表
 */
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

/**
 * 通用关键词与主题提取（不硬编码任何具体业务主题）
 */
export function extractKeywords(text: string, excludeWords: string[] = []): string[] {
  if (!text || typeof text !== 'string') return [];
  const keywords: string[] = [];
  const excludeLower = new Set(excludeWords.map((w) => w.toLowerCase()));

  // 1. 提取英文字符、数字、唯一标识符/代号 (如 MOON_SHELF_A08_702, tokenE, ONLY_IN_MEMORY)
  const codeMatches = text.match(/[A-Za-z0-9_#-]{2,}/g);
  if (codeMatches) {
    for (const code of codeMatches) {
      if (!STOP_WORDS.has(code.toLowerCase()) && !excludeLower.has(code.toLowerCase())) {
        keywords.push(code);
      }
    }
  }

  // 2. 清理标点，提取中文 2~6 字关键词与 n-gram
  const cleanCn = text.replace(/[^\u4e00-\u9fa5]/g, ' ');
  const chunks = cleanCn.split(/\s+/).filter((s) => s.length >= 2);
  for (const chunk of chunks) {
    if (!STOP_WORDS.has(chunk) && !excludeLower.has(chunk.toLowerCase())) {
      keywords.push(chunk);
    }
    // 产生 2-gram，过滤掉包含语法助词/介词/量词的跨词虚假碎片（如“的关”、“于温”、“筑的”）
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

/**
 * 主题匹配相关性打分
 */
export function matchTopicRelevance(keywords: string[], text: string): number {
  if (!keywords || keywords.length === 0 || !text) return 0;
  let score = 0;
  const lowerText = text.toLowerCase();

  for (const kw of keywords) {
    const lowerKw = kw.toLowerCase();
    if (lowerText.includes(lowerKw)) {
      // 专有代号/英数字标识符高权重 (+100)
      if (/[A-Za-z0-9_]{3,}/.test(kw)) {
        score += 100;
      } else {
        score += kw.length * 10;
      }
    }
  }

  return score;
}

/**
 * 权威过滤目标成员授权的数据空间。
 * 严格执行安全范围（工单 08-R1）：
 * 1. 目标成员自身私聊 + 公共客厅；
 * 2. 严禁获取其他成员私聊消息、检查点或长时记忆；
 * 3. 遵从 cutoffTime 防止未来信息穿越（createdAt 与 updatedAt 均不可晚于 cutoffTime）。
 */
export function filterAuthorizedData(
  appData: AppData,
  targetAgentId: AgentId,
  _conversationId?: string,
  cutoffTime: number = Infinity,
  isDemo: boolean = false,
) {
  const targetAgent = appData.agents.find((a) => a.id === targetAgentId);
  const targetDirectConv = appData.conversations.find(
    (c) => c.kind === 'direct' && c.agentId === targetAgentId,
  );
  const livingRoomConv = appData.conversations.find((c) => c.kind === 'living-room');

  // 1. 过滤消息：本人私聊 + 客厅群聊
  const authorizedDirectMessages = targetDirectConv
    ? appData.messages.filter((m) => {
        if (m.conversationId !== targetDirectConv.id) return false;
        if (m.status !== 'sent') return false;
        if (!m.text.trim()) return false;
        if (!isDemo && (m.demo || m.id.startsWith('msg_seed_'))) return false;
        if (m.createdAt > cutoffTime) return false;
        return true;
      })
    : [];

  const authorizedLivingRoomMessages = livingRoomConv
    ? appData.messages.filter((m) => {
        if (m.conversationId !== livingRoomConv.id) return false;
        if (m.status !== 'sent') return false;
        if (!m.text.trim()) return false;
        if (!isDemo && (m.demo || m.id.startsWith('msg_seed_'))) return false;
        if (m.createdAt > cutoffTime) return false;
        return true;
      })
    : [];

  // 2. 过滤长时记忆：公共客厅 + 本人私聊专属，严格版本边界（更新时间晚于 cutoffTime 属未来版本，严禁倒灌）
  const allMemories = (appData.memories ?? []).filter((m) => !m.tombstoned && m.status !== 'deleted' && m.status !== 'invalidated');
  const authorizedMemories = allMemories.filter((m) => {
    if (m.createdAt > cutoffTime) return false;
    if (m.updatedAt && m.updatedAt > cutoffTime) return false;
    if (m.scope.type === 'living-room') return true;
    if (m.scope.type === 'direct' && (m.scope.id === targetAgentId || (targetDirectConv && m.scope.id === targetDirectConv.id))) return true;
    return false;
  });

  // 3. 过滤检查点：本人私聊会话 + 客厅会话
  const authorizedCheckpoints = (appData.checkpoints ?? []).filter((c) => {
    if (c.createdAt > cutoffTime) return false;
    if ((c as any).updatedAt && (c as any).updatedAt > cutoffTime) return false;
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

/**
 * 权威长时记忆语义/关键词检索
 */
export function queryRelevantMemories(
  memories: MemoryItem[],
  queryText: string,
  topK: number = 3,
): { selectedMemories: MemoryItem[]; reasons: Record<string, string>; fallbackUsed: 'none' | 'basic_keyword' | 'recent_window' } {
  if (memories.length === 0) {
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
    const reasons: Record<string, string> = {};
    for (const item of topScored) {
      reasons[item.memory.id] = `关键词匹配度得分: ${item.score}`;
    }
    return {
      selectedMemories: topScored.map((x) => x.memory),
      reasons,
      fallbackUsed: 'basic_keyword',
    };
  }

  // 降级：若无关键词匹配，返回最近 2 条活跃记忆
  const recent = memories.slice(-2);
  const reasons: Record<string, string> = {};
  for (const item of recent) {
    reasons[item.id] = '近期活跃记忆回流';
  }
  return {
    selectedMemories: recent,
    reasons,
    fallbackUsed: 'recent_window',
  };
}

/**
 * 统一生产级上下文拼装引擎（工单 08-R1 权威闭环）
 * 规范：
 * 1. 严格 16,000 字符上限，按实际 Wire 传输字符数逐字精准计算；
 * 2. 自动派生检查点，并在组装完成后真正落盘提交；
 * 3. 通用中文/英文主题检索与语义相关度区分，排除无关干扰；
 * 4. Codex 与通用 API 协议注入同一份已授权来源；Codex 真正送入长时记忆；
 * 5. 交付回执真实记录实际 injectedSources，未送入 wire 的严禁标为 injected。
 */
export function assembleTurnContext(
  appData: AppData,
  params: TurnContextParams,
): TurnContextResult & { updatedCheckpoints?: ContextCheckpoint[] } {
  const {
    conversationId,
    targetAgentId,
    currentText,
    targetMsgIdx,
    extraMemoryGatewayMemories = [],
    isDemo: explicitDemo,
    requestId = `req_${Date.now().toString(36)}`,
  } = params;

  const conversation = appData.conversations.find((c) => c.id === conversationId);
  const isDirect = conversation ? conversation.kind === 'direct' : false;

  // 1. 确定重试截断时间
  let cutoffTime = typeof params.cutoffTime === 'number' ? params.cutoffTime : Infinity;
  if (typeof targetMsgIdx === 'number' && targetMsgIdx >= 0) {
    const targetMsg = appData.messages[targetMsgIdx];
    if (targetMsg) cutoffTime = Math.min(cutoffTime, targetMsg.createdAt);
  }

  // 2. 授权范围提取
  const {
    targetAgent,
    targetDirectConv,
    livingRoomConv,
    authorizedDirectMessages,
    authorizedLivingRoomMessages,
    authorizedMemories,
    authorizedCheckpoints,
  } = filterAuthorizedData(appData, targetAgentId, conversationId, cutoffTime, Boolean(explicitDemo));

  const targetAgentName = targetAgent?.name || (targetAgentId === 'agent_coordinator' ? '协调者' : '伙伴');
  const targetProfileId = targetAgent?.profileId;
  const profile = appData.chatProfiles?.find((p) => p.id === targetProfileId);
  const isDemo = explicitDemo ?? (targetAgent?.mode === 'demo' || !profile);

  // 3. 自动派生检查点（会话原话 > 8 条时折叠前序历史，更新持久检查点）
  const directDerive = targetDirectConv
    ? autoDeriveCheckpoints(targetDirectConv.id, authorizedDirectMessages, appData.checkpoints || [], targetAgentName, true)
    : { activeCheckpoint: null, updatedCheckpoints: appData.checkpoints || [] };

  const livingRoomDerive = livingRoomConv
    ? autoDeriveCheckpoints(livingRoomConv.id, authorizedLivingRoomMessages, directDerive.updatedCheckpoints, '大家', false)
    : { activeCheckpoint: null, updatedCheckpoints: directDerive.updatedCheckpoints };

  // 工单 08-R2：组装函数不再原地修改 React 状态；派生结果通过返回值交由调用方
  // 经 reducer（saveCheckpoints/mergeCheckpoints）与持久化事务提交。
  const dmCheckpoint = directDerive.activeCheckpoint || authorizedCheckpoints.find(
    (c) => targetDirectConv && c.conversationId === targetDirectConv.id && isCheckpointValid(c, authorizedDirectMessages),
  );

  const allParticipantNames = [
    '使用者',
    targetAgentName,
    ...(appData.agents || []).flatMap((a) => [a.name, a.id]),
  ].filter(Boolean);
  const queryKeywords = extractKeywords(currentText, allParticipantNames);

  // 4. 参考块构建（工单 08-R2 B2）：每个块带来源元数据，是否注入由最终序列化结果决定，
  //    收据只记录真正写入最终 payload 的来源（含实际片段长度与内容哈希）。
  type RefBlock = { meta: MemoryReferenceSource; text: string; recallMetas?: MemoryReferenceSource[] };
  const preparedSources: MemoryReferenceSource[] = [];
  const registerPrepared = (meta: MemoryReferenceSource): MemoryReferenceSource => {
    preparedSources.push({ ...meta, injected: false });
    return meta;
  };
  const referenceBlocks: RefBlock[] = [];
  const pushBlock = (meta: MemoryReferenceSource, text: string) => {
    if (!text || !text.trim()) return;
    referenceBlocks.push({ meta: registerPrepared(meta), text });
  };

  // 长时记忆召回
  const { selectedMemories, reasons, fallbackUsed } = queryRelevantMemories(
    authorizedMemories,
    currentText,
  );

  const memoryLines: string[] = [];
  const memoryLineOwners: MemoryItem[] = [];
  let memoryBudget = 2500;
  for (const m of selectedMemories) {
    if (memoryBudget <= 50) break;
    const title = m.title ? `【${m.title.slice(0, 100)}】` : '';
    const maxTake = Math.min(m.content.length, Math.min(1000, memoryBudget));
    const safeContent = m.content.length > maxTake ? `${m.content.slice(0, maxTake)}…` : m.content;
    const line = `- ${title}${safeContent}`;
    memoryLines.push(line);
    memoryLineOwners.push(m);
    memoryBudget -= line.length;
  }

  // 5. 跨模式经历与私聊灵感提炼（参考块统一走 pushBlock，收据按最终序列化回填）

  // 通用主题过滤函数（按子句与行进行多主题鉴别过滤，杜绝不相关主题整句混入）
  const filterSummaryByTopic = (summaryText: string): string => {
    if (!summaryText || queryKeywords.length === 0) return summaryText;
    // 如果不是由 extractConversationFacts 生成的标准分条结构化事实，直接返回全文本
    if (!summaryText.includes('【会话事实与检查点】') && !summaryText.includes('- 关键约定与核心事实')) {
      return summaryText;
    }

    const lines = summaryText.split('\n');
    const filteredLines: string[] = [];

    for (const line of lines) {
      if (!line.startsWith('- ') || !line.includes('：')) {
        filteredLines.push(line);
        continue;
      }
      const colonIdx = line.indexOf('：');
      const prefix = line.slice(0, colonIdx + 1);
      const content = line.slice(colonIdx + 1);
      const clauses = content.split('；');

      const matchedClauses: string[] = [];
      for (const clause of clauses) {
        if (!clause.trim()) continue;
        const score = matchTopicRelevance(queryKeywords, clause);
        if (score > 0) {
          matchedClauses.push(clause.trim());
        }
      }

      if (matchedClauses.length > 0) {
        filteredLines.push(`${prefix}${matchedClauses.join('；')}`);
      } else {
        const score = matchTopicRelevance(queryKeywords, line);
        if (score > 0) {
          filteredLines.push(line);
        }
      }
    }

    return filteredLines.length > 1 ? filteredLines.join('\n') : summaryText;
  };

  // 跨模式直连私聊消息主题打分筛选
  const scoredDirectMsgs = authorizedDirectMessages.map((m) => ({
    msg: m,
    score: matchTopicRelevance(queryKeywords, m.text),
  }));
  const hasTopicMatches = scoredDirectMsgs.some((x) => x.score > 0);
  let candidateDirectMsgs: Message[] = [];
  if (hasTopicMatches) {
    // 跨模式讨论特定主题时，只带入与该主题真正相关的私聊原话记录（杜绝混入其他私密构想）
    candidateDirectMsgs = scoredDirectMsgs
      .filter((x) => x.score > 0)
      .map((x) => x.msg)
      .slice(-6);
  } else if (isDirect) {
    candidateDirectMsgs = authorizedDirectMessages.slice(-10);
  } else {
    candidateDirectMsgs = authorizedDirectMessages.slice(-2);
  }

  // 相关原话检索（工单 08-R2 B1）：从全部授权原始记录检索主题命中，两种模式都生效，
  // 不再只依赖检查点摘要与近期窗口；命中只取历史窗口之外的中段消息，避免与历史重复。
  const isAskingGroupConsensus =
    queryKeywords.some((k) => ['客厅', '共识', '群聊', '大家', '讨论', '早期'].includes(k)) ||
    /群|客厅|共识|大家|公开发言|讨论/.test(currentText) ||
    appData.agents.some((a) => a.id !== targetAgentId && currentText.includes(a.name));

  const windowCount = isDirect
    ? (profile?.contextLimit !== undefined && profile.contextLimit > 0 ? profile.contextLimit * 2 : 24)
    : 12;
  const lrWindowCount = isDirect ? 6 : 8;
  const dmExcludeCount = isDirect ? windowCount : 2;

  const buildRecallBlock = (
    msgs: Message[],
    excludeCount: number,
    sourceType: 'direct_history' | 'living_room_history',
    blockTitle: string,
  ): { text: string; metas: MemoryReferenceSource[] } | null => {
    if (queryKeywords.length === 0 || msgs.length === 0) return null;
    const scored = msgs
      .slice(0, Math.max(0, msgs.length - excludeCount))
      .map((m) => ({ m, score: matchTopicRelevance(queryKeywords, m.text) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || b.m.createdAt - a.m.createdAt)
      .slice(0, 6);
    if (scored.length === 0) return null;
    const lines = scored.map(({ m }) => {
      const speaker = m.agentId === 'agent_owner'
        ? '使用者'
        : (appData.agents.find((a) => a.id === m.agentId)?.name || '伙伴');
      const text = m.text.length > 600 ? `${m.text.slice(0, 600)}…` : m.text;
      const timeStr = getBeijingTime(m.editedAt || m.createdAt).formattedDateTime;
      return `【${timeStr}】[${speaker}]: ${text}`;
    });
    return {
      text: `${blockTitle}\n${lines.join('\n')}`,
      metas: scored.map(({ m }) => ({
        id: m.id,
        title: `相关原话：${m.text.slice(0, 24)}`,
        sourceType,
        sourceConversationId: m.conversationId,
        authorAgentId: m.agentId,
        timestamp: m.createdAt,
        injected: false,
        reason: `主题相关原话检索命中（得分 ${matchTopicRelevance(queryKeywords, m.text)}）`,
      })),
    };
  };

  const dmRecall = buildRecallBlock(
    authorizedDirectMessages,
    dmExcludeCount,
    'direct_history',
    '【相关私聊原话检索（你的个人记忆）】',
  );
  const lrRecall = buildRecallBlock(
    authorizedLivingRoomMessages,
    lrWindowCount,
    'living_room_history',
    '【相关客厅公开发言检索】',
  );

  // 1. 直连私聊模式下：若有前序已折叠检查点，注入会话历史检查点（保持历史连续）
  if (isDirect && dmCheckpoint) {
    pushBlock(
      {
        id: dmCheckpoint.id,
        title: '前序会话事实检查点',
        sourceType: 'checkpoint',
        sourceConversationId: dmCheckpoint.conversationId,
        timestamp: dmCheckpoint.createdAt,
        injected: false,
        reason: '私聊前序历史事实折叠摘要',
      },
      `【你与使用者的前序会话事实检查点】：\n${dmCheckpoint.summary}`,
    );
  }

  // 2. 客厅模式下注入私聊经历（灵感连续）
  if (!isDirect && authorizedDirectMessages.length > 0) {
    if (dmCheckpoint) {
      const filteredSummary = filterSummaryByTopic(dmCheckpoint.summary);
      if (filteredSummary.trim()) {
        pushBlock(
          {
            id: dmCheckpoint.id,
            title: '私聊个人经历检查点',
            sourceType: 'checkpoint',
            sourceConversationId: dmCheckpoint.conversationId,
            timestamp: dmCheckpoint.createdAt,
            injected: false,
            reason: '跨模式私聊记忆摘要',
          },
          `【你与使用者的私聊经历摘要（你的个人记忆，未在群内公开）】：\n${filteredSummary}`,
        );
      }
    }

    const privateRecent = candidateDirectMsgs
      .map((m) => {
        const speaker = m.agentId === 'agent_owner' ? '使用者' : targetAgentName;
        const timeStr = getBeijingTime(m.editedAt || m.createdAt).formattedDateTime;
        return `【${timeStr}】[${speaker}]: ${m.text}`;
      })
      .join('\n');

    if (privateRecent) {
      pushBlock(
        {
          id: targetDirectConv?.id || 'dm_history',
          title: '本人私聊灵感记录',
          sourceType: 'direct_history',
          sourceConversationId: targetDirectConv?.id,
          timestamp: Date.now(),
          injected: false,
          reason: '跨模式私聊历史回流',
        },
        `【你与使用者的私聊近期记录（你的个人记忆，未在群内公开）】：\n${privateRecent}`,
      );
    }
  }

  if (isDirect && profile?.providerType === 'codex-app-server') {
    const directRecentMsgs = authorizedDirectMessages.slice(-10);
    if (directRecentMsgs.length > 0) {
      const directRecent = directRecentMsgs
        .map((m) => {
          const speaker = m.agentId === 'agent_owner' ? '使用者' : targetAgentName;
          const speakerLabel = m.agentId === 'agent_owner' ? speaker : `${speaker}|${m.agentId}`;
          const timeStr = getBeijingTime(m.editedAt || m.createdAt).formattedDateTime;
          return `【${timeStr}】[${speakerLabel}]: ${m.text}`;
        })
        .join('\n');
      pushBlock(
        {
          id: targetDirectConv?.id || 'dm_recent_history',
          title: '私聊近期历史',
          sourceType: 'direct_history',
          sourceConversationId: targetDirectConv?.id,
          timestamp: Date.now(),
          injected: false,
          reason: '私聊历史记录',
        },
        `【你与使用者的近期私聊记录】：\n${directRecent}`,
      );
    }
  }

  // 3. 中段相关原话召回（两种模式都生效；来源按消息逐条登记）
  const dmRecallBlock = dmRecall && dmRecall.metas.length > 0 ? dmRecall : null;
  const lrRecallBlock = lrRecall && lrRecall.metas.length > 0 ? lrRecall : null;
  if (dmRecallBlock) {
    for (const meta of dmRecallBlock.metas) registerPrepared(meta);
    pushBlock(dmRecallBlock.metas[0]!, dmRecallBlock.text);
    referenceBlocks[referenceBlocks.length - 1]!.recallMetas = dmRecallBlock.metas;
  }
  if (lrRecallBlock) {
    for (const meta of lrRecallBlock.metas) registerPrepared(meta);
    pushBlock(lrRecallBlock.metas[0]!, lrRecallBlock.text);
    referenceBlocks[referenceBlocks.length - 1]!.recallMetas = lrRecallBlock.metas;
  }

  // 私聊模式下：若询问客厅共识或涉及群内公开发言，回流客厅共识与讨论记录
  if (isDirect && (isAskingGroupConsensus || authorizedLivingRoomMessages.length > 20)) {
    const lrCheckpoint = livingRoomDerive.activeCheckpoint || authorizedCheckpoints.find(
      (c) => livingRoomConv && c.conversationId === livingRoomConv.id && isCheckpointValid(c, authorizedLivingRoomMessages),
    );
    if (lrCheckpoint) {
      pushBlock(
        {
          id: lrCheckpoint.id,
          title: '客厅早期共识检查点',
          sourceType: 'checkpoint',
          sourceConversationId: lrCheckpoint.conversationId,
          timestamp: lrCheckpoint.createdAt,
          injected: false,
          reason: '客厅公开共识回流',
        },
        `【客厅公开讨论共识与检查点】：\n${filterSummaryByTopic(lrCheckpoint.summary)}`,
      );
    }
  }

  // 客厅公开讨论记录（低频参考）
  if (authorizedLivingRoomMessages.length > 0 && (!isDirect || isAskingGroupConsensus)) {
    const lrRecent = authorizedLivingRoomMessages
      .slice(-lrWindowCount)
      .map((m) => {
        const author = appData.agents.find((a) => a.id === m.agentId);
        const authorName = author?.name || (m.agentId === 'agent_owner' ? '使用者' : '伙伴');
        const timeStr = getBeijingTime(m.editedAt || m.createdAt).formattedDateTime;
        return `【${timeStr}】[${authorName}]: ${m.text}`;
      })
      .join('\n');
    if (lrRecent) {
      pushBlock(
        {
          id: 'living_room_highlights',
          title: '客厅近期公开讨论',
          sourceType: 'living_room_history',
          timestamp: Date.now(),
          injected: false,
          reason: '群聊公开上下文回流',
        },
        `【客厅近期公开讨论记录】：\n${lrRecent}`,
      );
    }
  }

  // 长时记忆块注入参考
  if (memoryLines.length > 0) {
    pushBlock(
      {
        id: 'memory_block',
        title: '长时记忆集合',
        sourceType: 'memory',
        timestamp: Date.now(),
        injected: false,
        reason: '相关长时记忆注入',
      },
      `【你的专属长时记忆】：\n${memoryLines.join('\n')}`,
    );
  }

  // 外部 MemoryGateway 旁路记忆
  const safeExtraMemories = extraMemoryGatewayMemories.filter((s) => s && s.trim());
  if (safeExtraMemories.length > 0) {
    pushBlock(
      {
        id: 'memoryGateway_extra',
        title: '外部记忆召回',
        sourceType: 'memoryGateway',
        timestamp: Date.now(),
        injected: false,
        reason: '外部旁路记忆（低信任参考）',
      },
      `【外部记忆召回（低信任参考资料）】：\n${safeExtraMemories.map((m) => `- ${m}`).join('\n')}`,
    );
  }

  let referenceMessageContent = referenceBlocks.map((b) => b.text).join('\n\n');

  /** 依据最终序列化实际包含的块构建收据：injected 只含真正写入 payload 的来源（工单 08-R2 B2/B3） */
  const buildReceipt = (
    includedBlocks: RefBlock[],
    usedChars: number,
    status: MemoryDeliveryReceipt['status'],
    error?: string,
  ): MemoryDeliveryReceipt => {
    const injectedSources: MemoryReferenceSource[] = [];
    for (const blk of includedBlocks) {
      // 工单 08-R3：召回检索块按行逐源登记——每条事实对应自己的片段 hash/chars，不借第一条表示整块
      const recallBlock = blk as RefBlock & { recallMetas?: MemoryReferenceSource[] };
      if (recallBlock.recallMetas && recallBlock.recallMetas.length > 0) {
        const lines = blk.text.split('\n').slice(1);
        recallBlock.recallMetas.forEach((meta, i) => {
          const line = lines[i] || '';
          injectedSources.push({
            ...meta,
            injected: true,
            injectedChars: line.length,
            payloadHash: contentHash(line),
          });
        });
        continue;
      }
      injectedSources.push({
        ...blk.meta,
        injected: true,
        injectedChars: blk.text.length,
        payloadHash: contentHash(blk.text),
      });
      if (blk.meta.id === 'memory_block') {
        memoryLineOwners.forEach((m, idx) => {
          injectedSources.push({
            id: m.id,
            title: m.title || m.content.slice(0, 30),
            sourceType: 'memory',
            authorAgentId: m.authorAgentId,
            timestamp: m.updatedAt || m.createdAt,
            injected: true,
            reason: reasons[m.id] || '相关长时记忆注入',
            injectedChars: (memoryLines[idx] || '').length,
            payloadHash: contentHash(memoryLines[idx] || ''),
          });
        });
      }
    }
    const injectedIds = new Set(injectedSources.map((s) => s.id));
    const prepared = preparedSources.map((p) => ({ ...p, injected: injectedIds.has(p.id) }));
    for (const m of authorizedMemories) {
      if (!injectedIds.has(m.id)) {
        prepared.push({
          id: m.id,
          title: m.title || m.content.slice(0, 30),
          sourceType: 'memory',
          authorAgentId: m.authorAgentId,
          timestamp: m.updatedAt || m.createdAt,
          injected: false,
          reason: reasons[m.id] || '候选长时记忆',
        });
      }
    }
    return {
      requestId,
      conversationId,
      targetAgentId,
      preparedSources: prepared,
      injectedSources,
      status,
      totalBudgetChars: MAX_TOTAL_BUDGET,
      usedChars,
      fallbackUsed,
      error,
      timestamp: Date.now(),
    };
  };

  // 构建当前在场者名单与模式原则
  const participants = isDirect
    ? ['使用者', targetAgentName]
    : ['使用者', ...appData.agents.map((a) => a.name)];

  const sceneBanner = isDirect
    ? `【当前模式：私聊直连 | 交流对象：使用者 | 原则：保持专属亲密与个人记忆连续】`
    : `【当前模式：客厅群聊 | 在场者：${participants.join('、')} | 原则：公开透明，可把个人私聊灵感带入群内交流】`;

  const MAX_TOTAL_BUDGET = 16000;

  const nowMs = Date.now();
  const bjNow = getBeijingTime(nowMs);
  const lastInteraction = findLastInteraction(
    appData.messages || [],
    appData.conversations || [],
    targetAgentId,
    {
      nowMs,
      cutoffTime: Number.isFinite(cutoffTime) ? cutoffTime : undefined,
      excludeIds: new Set(params.excludeMessageIds || []),
    },
  );
  const timeNotice = `【当前北京时间：${bjNow.formattedFull}。当前模式：${isDirect ? '私聊' : '客厅群聊'}。你与使用者上一次交流：${lastInteraction.description}。历史消息的时间属于当时，不代表现在；没有依据时不要编造早晚、离开多久或期间发生的事。】`;

  const activeSystemPrompt = targetAgent?.systemPrompt?.trim()
    ? `${targetAgent.systemPrompt.trim()}\n\n${sceneBanner}\n\n${timeNotice}`
    : `${profile?.developerInstructions || '你是一位温暖可靠的伙伴。'}\n\n${sceneBanner}\n\n${timeNotice}`;

  const messagesAfterCheckpoint = isDirect ? authorizedDirectMessages : authorizedLivingRoomMessages;

  // ==========================================
  // 6. Codex app-server 专属协议分支
  // ==========================================
  if (!isDemo && profile?.providerType === 'codex-app-server') {
    const scenePrinciple =
      '【场景与身份原则】：你仍是同一个成员，模式只改变在场者与表达场景；自己的私聊记忆可用于理解使用者要求，不无缘无故整段公开私人历史；使用者主动要求介绍刚才的灵感时，可把相关灵感带入当前讨论。';
    const customPrompt = targetAgent?.systemPrompt?.trim() || profile.developerInstructions || '';
    const effectiveDeveloperInstructions = customPrompt
      ? `${scenePrinciple}\n\n${customPrompt}`
      : scenePrinciple;

    const header = isDirect
      ? `【当前场景：私聊 | 交流对象：使用者】\n${timeNotice}`
      : `【当前场景：客厅群聊 | 在场者：${participants.join('、')}】\n${timeNotice}`;

    const buildCodexTurn = (blocks: RefBlock[]): string => {
      const codexReferenceContent = blocks.map((b) => b.text).join('\n\n');
      return codexReferenceContent
        ? `${header}\n\n${codexReferenceContent}\n\n[使用者]: ${currentText}`
        : `${header}\n\n[使用者]: ${currentText}`;
    };

    let includedCodexBlocks: RefBlock[] = referenceBlocks;
    let formattedTurnText = buildCodexTurn(includedCodexBlocks);
    let totalCodexBudget = effectiveDeveloperInstructions.length + formattedTurnText.length;

    // 工单 08-R2 A4：先削减全部参考资料（旧资料），完整保留授权人格与当前输入；仍超限才明确拒绝
    if (totalCodexBudget > MAX_TOTAL_BUDGET && includedCodexBlocks.length > 0) {
      includedCodexBlocks = [];
      formattedTurnText = buildCodexTurn(includedCodexBlocks);
      totalCodexBudget = effectiveDeveloperInstructions.length + formattedTurnText.length;
    }

    // 严格预算裁决（在最终序列化结果上计算）
    let configError: string | undefined = undefined;
    if (totalCodexBudget > MAX_TOTAL_BUDGET) {
      configError = `输入内容与系统人设总长度（共 ${totalCodexBudget} 字符）已超出单次最大预算上限（${MAX_TOTAL_BUDGET} 字符），请精简内容后发送`;
    }

    const receipt = configError
      ? buildReceipt([], totalCodexBudget, 'failed', configError)
      : buildReceipt(includedCodexBlocks, totalCodexBudget, 'injected');

    return {
      isDemo: false,
      profile: {
        ...profile,
        developerInstructions: effectiveDeveloperInstructions,
      },
      messages: [{ role: 'user' as const, content: formattedTurnText }],
      configError,
      deliveryReceipt: receipt,
      formattedTurnText,
      effectiveDeveloperInstructions,
      updatedCheckpoints: livingRoomDerive.updatedCheckpoints,
    };
  }

  // ==========================================
  // 7. 通用 API 模型分支（OpenAI compatible）与严格预算核算
  // ==========================================
  const totalFixedBudget = activeSystemPrompt.length + currentText.length + (referenceMessageContent ? referenceMessageContent.length : 0);

  let configError: string | undefined = undefined;
  if (totalFixedBudget > MAX_TOTAL_BUDGET) {
    configError = `输入内容、系统人设与参考资料（共 ${totalFixedBudget} 字符）已超出单次最大预算上限（${MAX_TOTAL_BUDGET} 字符），请精简内容后发送`;
    const allowedUserChars = Math.max(100, MAX_TOTAL_BUDGET - Math.min(activeSystemPrompt.length, 8000));
    const safeCurrentText = currentText.length > allowedUserChars ? currentText.slice(0, allowedUserChars) : currentText;
    const safeSystemPrompt = activeSystemPrompt.slice(0, MAX_TOTAL_BUDGET - safeCurrentText.length);
    const receipt = buildReceipt([], safeSystemPrompt.length + safeCurrentText.length, 'failed', configError);
    return {
      isDemo,
      profile,
      messages: [
        { role: 'system' as const, content: safeSystemPrompt },
        { role: 'user' as const, content: safeCurrentText },
      ],
      configError,
      deliveryReceipt: receipt,
      updatedCheckpoints: livingRoomDerive.updatedCheckpoints,
    };
  }

  const fixedChars = activeSystemPrompt.length + currentText.length;
  // 1. 预算内注入参考资料（记录实际注入的块，收据按实际回填）
  let availableBudget = MAX_TOTAL_BUDGET - fixedChars;
  let includedApiBlocks: RefBlock[] = [];
  let activeReferenceContent = '';
  if (referenceMessageContent && referenceMessageContent.length <= Math.min(4000, availableBudget)) {
    includedApiBlocks = referenceBlocks;
    activeReferenceContent = referenceMessageContent;
    availableBudget -= activeReferenceContent.length;
  } else if (referenceMessageContent) {
    const safeBlocks: RefBlock[] = [];
    let curRefLen = 0;
    const maxRefBudget = Math.min(3000, availableBudget);
    for (const blk of referenceBlocks) {
      if (curRefLen + blk.text.length + 2 <= maxRefBudget) {
        safeBlocks.push(blk);
        curRefLen += blk.text.length + 2;
      }
    }
    includedApiBlocks = safeBlocks;
    activeReferenceContent = safeBlocks.map((b) => b.text).join('\n\n');
    availableBudget -= activeReferenceContent.length;
  }

  // 2. 预算内逆向选取历史消息（按实际 wire 格式与发言者前缀逐字精确计算，杜绝估算误差）
  //    已通过相关原话检索块注入的中段消息不重复进入历史窗口。
  const recalledHistoryIds = new Set<string>([
    ...(dmRecallBlock && isDirect ? dmRecallBlock.metas.map((x) => x.id) : []),
    ...(lrRecallBlock && !isDirect ? lrRecallBlock.metas.map((x) => x.id) : []),
  ]);

  const maxHistoryCount =
    profile?.contextLimit !== undefined && profile.contextLimit > 0
      ? profile.contextLimit * 2
      : messagesAfterCheckpoint.length;

  const selectedWireMsgs: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [];
  let historyChars = 0;

  for (let i = messagesAfterCheckpoint.length - 1; i >= 0; i--) {
    if (selectedWireMsgs.length >= maxHistoryCount) break;
    const m = messagesAfterCheckpoint[i];
    if (!m) continue;
    if (recalledHistoryIds.has(m.id)) continue;

    let role: 'user' | 'assistant' = 'user';
    const timeStr = getBeijingTime(m.editedAt || m.createdAt).formattedDateTime;
    let prefix = '';

    if (m.agentId === 'agent_owner') {
      role = 'user';
    } else if (m.agentId === targetAgentId) {
      role = 'assistant';
    } else if (!isDirect) {
      const otherAgent = appData.agents.find((a) => a.id === m.agentId);
      prefix = otherAgent ? `[${otherAgent.name}|${m.agentId}] ` : '';
      role = 'user';
    }
    const wireContent = `【${timeStr}】${prefix}${m.text}`;

    const exactItemLen = wireContent.length;
    if (historyChars + exactItemLen <= availableBudget) {
      selectedWireMsgs.unshift({ role, content: wireContent });
      historyChars += exactItemLen;
    } else {
      break;
    }
  }

  // 3. 组装最终真实 wire 消息列表
  const contextMessages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [];
  contextMessages.push({ role: 'system', content: activeSystemPrompt });
  if (activeReferenceContent) {
    contextMessages.push({ role: 'user', content: activeReferenceContent });
  }
  contextMessages.push(...selectedWireMsgs);
  contextMessages.push({ role: 'user', content: currentText });

  // 4. 精确核算实际 wire 字符总数（与实际发出的 HTTP body 一致）
  const actualWireChars = contextMessages.reduce((sum, msg) => sum + msg.content.length, 0);

  const receipt = buildReceipt(includedApiBlocks, actualWireChars, 'injected');

  return {
    isDemo,
    profile,
    messages: contextMessages,
    configError: undefined,
    deliveryReceipt: receipt,
    updatedCheckpoints: livingRoomDerive.updatedCheckpoints,
  };
}
