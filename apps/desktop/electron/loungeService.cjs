'use strict';

const crypto = require('node:crypto');

function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 解析群消息中的点名目标（AI 成员）
 * 排除发送者本人和真人用户（使用者）
 */
function parseMentions(text, authorAgentId, data) {
  if (typeof text !== 'string' || !text.includes('@')) return [];
  const agents = (data?.agents || []).filter(a => a.kind === 'ai' && !a.removed && a.id !== authorAgentId);
  if (!agents.length) return [];

  // 按名字长度倒序匹配，优先匹配较长名字，避免子串误匹配
  const sorted = [...agents].sort((a, b) => (b.name?.length || 0) - (a.name?.length || 0));
  const matched = [];
  const matchedIds = new Set();

  for (const agent of sorted) {
    if (matchedIds.has(agent.id)) continue;
    let hit = false;
    if (agent.name) {
      const namePattern = new RegExp(`@${escapeRegExp(agent.name)}(?:\\s|$|[，。！？,.!?:;\\n\\r])`, 'u');
      if (namePattern.test(text) || text.endsWith(`@${agent.name}`)) {
        hit = true;
      }
    }
    if (!hit && agent.id) {
      const idPattern = new RegExp(`@${escapeRegExp(agent.id)}(?:\\s|$|[，。！？,.!?:;\\n\\r])`, 'u');
      if (idPattern.test(text) || text.endsWith(`@${agent.id}`)) {
        hit = true;
      }
    }
    if (hit) {
      matched.push(agent);
      matchedIds.add(agent.id);
    }
  }

  return matched;
}

class LoungeService {
  constructor({
    userDataDir,
    getData,
    startChat,
    stopChat,
    publishMessage,
    isBusy = () => false,
    now = Date.now,
    maxChainDepth = 3,
    replyTimeoutMs = 240000
  }) {
    this.userDataDir = userDataDir;
    this.getData = getData;
    this.startChat = startChat;
    this.stopChat = stopChat;
    this.publishMessage = publishMessage;
    this.isBusy = isBusy;
    this.now = now;
    this.maxChainDepth = maxChainDepth;
    // 包含记忆检索准备，以及现有 Kiro 线路最多 180 秒的生成时间。
    this.replyTimeoutMs = replyTimeoutMs;

    this.handledKeys = new Set();
    this.pendingMentions = [];
    this.activeReplies = new Set();
  }

  getLivingRoomConversation() {
    const data = this.getData();
    return (data?.conversations || []).find(c => c.kind === 'living-room' || c.id === 'conv_living_room') || null;
  }

  /**
   * 获取最近客厅群聊上下文供心跳等读取
   */
  getLivingRoomContext(agentId, limit = 10) {
    const data = this.getData();
    const livingConv = this.getLivingRoomConversation();
    if (!livingConv) return [];

    const messages = (data?.messages || [])
      .filter(m => m.conversationId === livingConv.id && m.status === 'sent' && m.text && !m.demo)
      .slice(-limit)
      .map(m => {
        const author = (data?.agents || []).find(a => a.id === m.agentId);
        const authorName = m.agentId === 'agent_owner' ? '使用者' : (author?.name || '家人');
        return {
          id: m.id,
          authorId: m.agentId,
          authorName,
          text: m.text,
          createdAt: m.createdAt,
          timeStr: new Date(m.createdAt).toLocaleTimeString('zh-CN', { hour12: false })
        };
      });

    return messages;
  }

  /**
   * 自主心跳向客厅发言
   */
  async postLivingRoomMessage({ agentId, text, note, requestId }) {
    if (!text || !text.trim()) return { ok: false, reason: '发言内容为空' };
    const livingConv = this.getLivingRoomConversation();
    if (!livingConv) return { ok: false, reason: '客厅尚未建立' };

    const reqId = requestId || `lounge_post_${crypto.randomUUID()}`;
    const res = await this.publishMessage({
      requestId: reqId,
      conversationId: livingConv.id,
      agentId,
      text: text.trim(),
      medium: 'text'
    });

    if (res?.ok && res.messageId) {
      const data = this.getData();
      const savedMsg = (data?.messages || []).find(m => m.id === res.messageId);
      if (savedMsg) {
        // 自主心跳发到客厅后，如果里面点名了家人，触发接话
        void this.onLivingRoomMessage(savedMsg, 0).catch(err => {
          console.error('[LoungeService] 心跳发言后触发接话异常:', err.message);
        });
      }
    }

    return res;
  }

  /**
   * 客厅新消息入口：检查是否有家人点名并调度接话
   */
  async onLivingRoomMessage(message, chainDepth = 0) {
    if (!message || typeof message.text !== 'string' || !message.text.trim()) return { handled: false, reason: 'invalid_message' };
    const livingConv = this.getLivingRoomConversation();
    if (!livingConv || message.conversationId !== livingConv.id) return { handled: false, reason: 'not_living_room' };

    // 保存 ACK / broker 的重复通知不会携带递归深度；从已保存的父消息恢复，
    // 避免这些入口把每一条接话都当成新的第零轮。
    const data = this.getData();
    let ancestor = message, inheritedDepth = 0;
    while (ancestor && inheritedDepth < this.maxChainDepth) {
      const requestId = ancestor.requestId || '', suffix = '_' + ancestor.agentId;
      if (!requestId.startsWith('req_lounge_') || !requestId.endsWith(suffix)) break;
      inheritedDepth++;
      const parentId = requestId.slice('req_lounge_'.length, -suffix.length);
      ancestor = data.messages?.find(m => m.id === parentId && m.conversationId === livingConv.id);
    }
    chainDepth = Math.max(chainDepth, inheritedDepth);
    if (chainDepth >= this.maxChainDepth) {
      return { handled: false, reason: 'max_chain_depth_reached' };
    }

    const targets = parseMentions(message.text, message.agentId, data);
    if (!targets.length) {
      return { handled: false, reason: 'no_mentions' };
    }

    const results = [];
    for (const target of targets) {
      const replyKey = `${message.id}:${target.id}`;
      if (this.handledKeys.has(replyKey)) {
        results.push({ targetId: target.id, skipped: true, reason: 'already_handled' });
        continue;
      }

      // 重启或重复事件幂等防护：检查是否已有对应回复
      const existingReply = (data?.messages || []).some(m =>
        m.conversationId === livingConv.id &&
        m.agentId === target.id &&
        (m.requestId === `req_lounge_${message.id}_${target.id}` || m.requestId === `req_reply_${message.id}_${target.id}`)
      );
      if (existingReply) {
        this.handledKeys.add(replyKey);
        results.push({ targetId: target.id, skipped: true, reason: 'already_persisted' });
        continue;
      }

      this.handledKeys.add(replyKey);

      // 忙碌状态判定：若目标忙碌，暂存至等待队列，待其空闲后承接
      if (this.isBusy(target.id)) {
        this.pendingMentions.push({
          message,
          targetAgentId: target.id,
          chainDepth,
          createdAt: this.now()
        });
        results.push({ targetId: target.id, queued: true, reason: 'target_busy' });
        continue;
      }

      // 开始接话
      const replyResult = await this.dispatchReply(message, target, chainDepth);
      results.push(replyResult);
    }

    return { handled: true, results };
  }

  /**
   * 唤起被点名的 AI 成员进行接话回复
   */
  async dispatchReply(sourceMessage, targetAgent, chainDepth) {
    const data = this.getData();
    const livingConv = this.getLivingRoomConversation();
    if (!livingConv) return { ok: false, reason: '客厅不存在' };

    const reqHash = crypto.createHash('sha256').update(`${sourceMessage.id}_${targetAgent.id}`).digest('hex').slice(0, 24);
    const replyRequestId = `req_lounge_${sourceMessage.id}_${targetAgent.id}`;

    if (this.activeReplies.has(replyRequestId)) {
      return { ok: false, reason: 'reply_in_progress' };
    }
    this.activeReplies.add(replyRequestId);

    try {
      const sender = (data.agents || []).find(a => a.id === sourceMessage.agentId)?.name ||
        (sourceMessage.agentId === 'agent_owner' ? '使用者' : '家人');

      const promptText = `【小屋客厅群聊消息】
家人「${sender}」在小屋客厅对你说话/点名了你：
"${sourceMessage.text}"

这是家人在群聊中发来的消息，不是使用者在私聊里的新指令。请根据你的性格与当下家庭氛围自然回应。
你可以自然接话、闲聊、回答对方的问题，也可以在必要时 @ 另一位家人交流；如果觉得无须回复，可以回复纯空白或 "(不回应)"。`;

      let text = '';
      await new Promise((resolve, reject) => {
        let settled = false;
        const finish = err => {
          if (settled) return;
          settled = true;
          if (err) return reject(err);
          resolve(text);
        };
        const timer = setTimeout(() => {
          void this.stopChat?.(replyRequestId);
          finish(new Error('接话思考超时'));
        }, this.replyTimeoutMs);

        Promise.resolve(this.startChat({
          requestId: replyRequestId,
          conversationId: livingConv.id,
          targetAgentId: targetAgent.id,
          currentText: promptText
        }, (channel, event) => {
          if (channel === 'chat:stream-chunk') text += (event.delta || '');
          if (channel === 'chat:stream-done') {
            if (event.accumulatedText) text = event.accumulatedText;
            clearTimeout(timer);
            finish();
          }
          if (channel === 'chat:stream-error' || channel === 'chat:stream-stopped') {
            clearTimeout(timer);
            finish(new Error(event.error || '接话流中断'));
          }
        })).then(result => {
          if (!result?.ok) {
            clearTimeout(timer);
            finish(new Error(result?.reason || '启动接话线路失败'));
          }
        }).catch(err => {
          clearTimeout(timer);
          finish(err);
        });
      });

      const cleaned = text.trim();
      const isSilent = !cleaned || cleaned === '(不回应)' || cleaned === '（不回应）' || cleaned === '(安静)' || cleaned === '（安静）';

      if (isSilent) {
        return { ok: true, silent: true, agentId: targetAgent.id };
      }

      // 将回复通过 publishMessage 发布到客厅
      const pubResult = await this.publishMessage({
        requestId: replyRequestId,
        conversationId: livingConv.id,
        agentId: targetAgent.id,
        text: cleaned,
        medium: 'text'
      });

      if (pubResult?.ok && pubResult.messageId) {
        // 递归检查新回复中是否又点名了其他家人（chainDepth 递增）
        const updatedData = this.getData();
        const savedMsg = (updatedData?.messages || []).find(m => m.id === pubResult.messageId);
        if (savedMsg) {
          void this.onLivingRoomMessage(savedMsg, chainDepth + 1).catch(e => {
            console.error('[LoungeService] 级联接话异常:', e.message);
          });
        }
      }

      return { ok: true, published: true, agentId: targetAgent.id, text: cleaned };
    } catch (error) {
      console.warn(`[LoungeService] 成员 ${targetAgent.name || targetAgent.id} 接话失败:`, error.message);
      return { ok: false, error: error.message };
    } finally {
      this.activeReplies.delete(replyRequestId);
    }
  }

  /**
   * 成员恢复空闲后处理积压的被点名接话
   */
  async drainPendingMentions(agentId) {
    if (this.isBusy(agentId)) return;
    const pendingList = this.pendingMentions.filter(p => p.targetAgentId === agentId);
    if (!pendingList.length) return;

    // 清出该成员的待办
    this.pendingMentions = this.pendingMentions.filter(p => p.targetAgentId !== agentId);

    const data = this.getData();
    const targetAgent = (data.agents || []).find(a => a.id === agentId);
    if (!targetAgent || targetAgent.removed) return;

    for (const item of pendingList) {
      // 超过 30 分钟的点名视为过期，不再唤醒
      if (this.now() - item.createdAt > 30 * 60 * 1000) continue;
      await this.dispatchReply(item.message, targetAgent, item.chainDepth);
    }
  }
}

module.exports = { LoungeService, parseMentions };
