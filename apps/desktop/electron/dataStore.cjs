'use strict';

/**
 * 小屋 · 桌面存储层（主进程）
 *
 * 数据保护原则（返修单 A 段）：
 * 1. 任何失败路径都不得删除或改动既有主文件。替换失败 = 原文件字节不变。
 * 2. 只有通过完整 schema 校验的主文件才允许成为 backup 的内容；
 *    损坏/空文件不得覆盖已有的有效副本。
 * 3. 区分四种读取结果：missing（首次使用）/ ok / corrupt（存在但坏）/ unreadable（读不了）。
 *    unreadable 不等于用户同意覆盖。
 * 4. 写入严格串行，并以 session 为单位管理 revision：renderer 重载后是新 session，
 *    它的第一次修改必须能正常落盘；同一 session 内迟到的旧 revision 仍被拒绝。
 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { deriveAutomaticMemory } = require('./automaticMemory.cjs');

const DATA_DIR_NAME = 'xiaowu-data';
const DATA_FILE = 'data.v1.json';
const BACKUP_FILE = 'data.v1.backup.json';
const TEMP_FILE = 'data.v1.tmp.json';
const VALID_THEMES = ['fusion', 'day', 'night'];
/** 与 src/types.ts 的 STORAGE_VERSION 保持同步，改一处必须改两处 */
const SUPPORTED_VERSION = 1;

/* ------------------------------------------------------------------ *
 * 结构校验：与 src/store/storage.ts 的 validateData 对齐的关键检查。
 * 主进程无法 import TS，这里实现同一套判定，任何一侧放宽都要同步测试。
 * ------------------------------------------------------------------ */
function looksLikeValidAppData(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return false;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
  const d = parsed;
  const validAttachments = value => Array.isArray(value) && value.length <= 4 && value.every(a => a && typeof a === 'object' && /^att_[a-f0-9]{32}$/.test(a.id) && typeof a.name === 'string' && a.name.length <= 160 && ['image','text'].includes(a.kind) && typeof a.mimeType === 'string' && Number.isInteger(a.size) && a.size > 0 && a.size <= 10*1024*1024) && new Set(value.map(a => a.id)).size === value.length;
  if (Array.isArray(d.messages) && d.messages.some(m => m && m.attachments !== undefined && !validAttachments(m.attachments))) return false;
  if (d.attachmentDrafts !== undefined && (!d.attachmentDrafts || typeof d.attachmentDrafts !== 'object' || Array.isArray(d.attachmentDrafts) || !Object.values(d.attachmentDrafts).every(validAttachments))) return false;
  const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
  const isStr = (v) => typeof v === 'string';
  const isTime = (v) => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 8.64e15;
  const nullableId = (v) => v === null || isStr(v);
  const uniqueIds = (items) => new Set(items.map((item) => item.id)).size === items.length;

  if (typeof d.version !== 'number' || !Number.isInteger(d.version) || d.version < 1) return false;
  // 与 src/types.ts 的 STORAGE_VERSION 一致：更高版本的数据不能被低版本程序改写
  if (d.version > SUPPORTED_VERSION) return false;
  if (!Array.isArray(d.agents) || !Array.isArray(d.conversations)) return false;
  if (!Array.isArray(d.messages) || !Array.isArray(d.tickets)) return false;
  if (!isObj(d.preferences) || !VALID_THEMES.includes(d.preferences.theme)) return false;
  if (!isStr(d.activeConversationId) || d.activeConversationId.length === 0) return false;

  if (!d.agents.every((a) => isObj(a) && isStr(a.id) && isStr(a.name) && isStr(a.initial) && ['human', 'ai'].includes(a.kind) && typeof a.connected === 'boolean' && isStr(a.accent) && isStr(a.statusNote)) || !uniqueIds(d.agents)) {
    return false;
  }
  if (!d.conversations.every((c) => isObj(c) && isStr(c.id) && isStr(c.title) && ['living-room', 'direct'].includes(c.kind) && nullableId(c.agentId) && isTime(c.createdAt)) || !uniqueIds(d.conversations)) return false;
  if (!d.messages.every((m) => isObj(m) && isStr(m.id) && isStr(m.conversationId) && isStr(m.agentId) && isStr(m.text) && isTime(m.createdAt) && ['sent', 'streaming', 'stopped', 'error'].includes(m.status) && typeof m.demo === 'boolean' && nullableId(m.requestId)) || !uniqueIds(d.messages)) {
    return false;
  }
  if (
    !d.tickets.every(
      (t) =>
        isObj(t) &&
        isStr(t.id) &&
        isStr(t.title) &&
        isStr(t.goal) &&
        Array.isArray(t.participantIds) &&
        t.participantIds.every(isStr) &&
        Array.isArray(t.tasks) &&
        t.tasks.every((k) => isObj(k) && isStr(k.id) && isStr(k.title) && ['todo', 'doing', 'review', 'done'].includes(k.status) && nullableId(k.assigneeId)) &&
        uniqueIds(t.tasks) &&
        isObj(t.discussion) &&
        isStr(t.discussion.text) &&
        isTime(t.discussion.updatedAt) &&
        isObj(t.artifacts) &&
        isStr(t.artifacts.text) && isTime(t.artifacts.updatedAt) && isTime(t.updatedAt),
    ) || !uniqueIds(d.tickets)
  ) {
    return false;
  }
  if (d.drafts !== undefined && (!isObj(d.drafts) || !Object.values(d.drafts).every((v) => isStr(v)))) return false;
  if (d.chatProfiles !== undefined && (!Array.isArray(d.chatProfiles) || !d.chatProfiles.every((p) => {
    if (!isObj(p) || !isStr(p.id) || !isStr(p.name)) return false;
    if (p.providerType === 'codex-app-server') return true;
    return isStr(p.baseUrl) && isStr(p.model) && ['openai-compatible', 'demo'].includes(p.providerType);
  }))) return false;
  if (d.livingRoomSpeakerId !== undefined && d.livingRoomSpeakerId !== null && !isStr(d.livingRoomSpeakerId)) return false;
  if (d.memories !== undefined) {
    if (!Array.isArray(d.memories) || !d.memories.every((m) => isObj(m) && isStr(m.id) && isObj(m.scope) && isStr(m.scope.type) && ['direct', 'living-room', 'ticket'].includes(m.scope.type) && isStr(m.authorAgentId) && isStr(m.content) && isTime(m.createdAt)) || !uniqueIds(d.memories)) {
      return false;
    }
  }
  if (d.checkpoints !== undefined) {
    if (!Array.isArray(d.checkpoints) || !d.checkpoints.every((c) => isObj(c) && isStr(c.id) && isStr(c.conversationId) && isStr(c.summary) && isStr(c.createdBeforeMessageId) && isTime(c.createdAt)) || !uniqueIds(d.checkpoints)) {
      return false;
    }
  }
  if (d.memoryGatewayConfig !== undefined && d.memoryGatewayConfig !== null) {
    if (!isObj(d.memoryGatewayConfig) || typeof d.memoryGatewayConfig.enabled !== 'boolean' || !isStr(d.memoryGatewayConfig.baseUrl) || !isStr(d.memoryGatewayConfig.credentialRef)) {
      return false;
    }
  }
  if (d.memoryTombstones !== undefined && (!Array.isArray(d.memoryTombstones) || !d.memoryTombstones.every(isStr))) {
    return false;
  }
  if (d.memoryGatewayOutbox !== undefined && (!Array.isArray(d.memoryGatewayOutbox) || !d.memoryGatewayOutbox.every((item) => isObj(item) && isStr(item.id) && isStr(item.conversationId)))) {
    return false;
  }
  if (d.cloudSyncConfig !== undefined && d.cloudSyncConfig !== null) {
    if (!isObj(d.cloudSyncConfig) || typeof d.cloudSyncConfig.enabled !== 'boolean' || !isStr(d.cloudSyncConfig.url) || !isStr(d.cloudSyncConfig.homeId)) {
      return false;
    }
  }
  if (d.cloudSyncOutbox !== undefined && d.cloudSyncOutbox !== null) {
    if (!Array.isArray(d.cloudSyncOutbox) || !d.cloudSyncOutbox.every((item) => isObj(item) && isStr(item.operationId) && isStr(item.entityType) && isStr(item.entityId) && ['upsert', 'delete'].includes(item.opType))) {
      return false;
    }
  }
  if (d.cloudSyncSyncState !== undefined && d.cloudSyncSyncState !== null) {
    if (!isObj(d.cloudSyncSyncState) || !isStr(d.cloudSyncSyncState.status) || typeof d.cloudSyncSyncState.lastCommitSeq !== 'number') {
      return false;
    }
  }
  if (d.cloudSyncPartitions !== undefined && d.cloudSyncPartitions !== null) {
    if (!isObj(d.cloudSyncPartitions)) return false;
  }
  if (!d.conversations.some((c) => c.id === d.activeConversationId)) return false;
  if (!d.conversations.some((c) => c.id === 'conv_living_room') || !d.agents.some((a) => a.id === 'agent_owner')) return false;
  return true;
}

/** 净化数据：剔除已被永久删除墓碑记录的消息、派生记忆、受影响检查点快照与 outbox，以及已失效的 thread 绑定 */
function sanitizeAppDataWithPurgedIds(data, purgedSet, purgedThreadSet) {
  if (!data || typeof data !== 'object') return { data, modified: false };
  let modified = false;

  if (purgedSet && purgedSet.size > 0) {
    if (Array.isArray(data.messages)) {
      const origLen = data.messages.length;
      data.messages = data.messages.filter((m) => !purgedSet.has(m.id));
      if (data.messages.length !== origLen) modified = true;
    }
    if (Array.isArray(data.memories)) {
      const origLen = data.memories.length;
      data.memories = data.memories.filter((m) => !m.sourceMessageId || !purgedSet.has(m.sourceMessageId));
      if (data.memories.length !== origLen) modified = true;
    }
    if (Array.isArray(data.checkpoints)) {
      const origLen = data.checkpoints.length;
      data.checkpoints = data.checkpoints.filter((cp) => {
        if (Array.isArray(cp.sourceMessageSnapshots) && cp.sourceMessageSnapshots.some((s) => purgedSet.has(s.id))) {
          return false;
        }
        return true;
      });
      if (data.checkpoints.length !== origLen) modified = true;
    }
    if (Array.isArray(data.memoryGatewayOutbox)) {
      const origLen = data.memoryGatewayOutbox.length;
      data.memoryGatewayOutbox = data.memoryGatewayOutbox.filter((item) => {
        return !Array.isArray(item.messageIds) || !item.messageIds.some((id) => purgedSet.has(id));
      });
      if (data.memoryGatewayOutbox.length !== origLen) modified = true;
    }
    if (Array.isArray(data.cloudSyncOutbox)) {
      const origLen = data.cloudSyncOutbox.length;
      data.cloudSyncOutbox = data.cloudSyncOutbox.filter((item) => {
        if (item.entityType === 'message' && purgedSet.has(item.entityId) && item.opType !== 'delete') return false;
        return true;
      });
      if (data.cloudSyncOutbox.length !== origLen) modified = true;
    }
  }

  if (purgedThreadSet && purgedThreadSet.size > 0) {
    if (Array.isArray(data.agents)) {
      for (const ag of data.agents) {
        if (ag && ag.canonicalCodexThreadId && purgedThreadSet.has(ag.canonicalCodexThreadId)) {
          delete ag.canonicalCodexThreadId;
          modified = true;
        }
      }
    }
    if (Array.isArray(data.conversations)) {
      for (const c of data.conversations) {
        if (c && c.codexThreadId && purgedThreadSet.has(c.codexThreadId)) {
          delete c.codexThreadId;
          modified = true;
        }
      }
    }
    if (Array.isArray(data.chatProfiles)) {
      for (const p of data.chatProfiles) {
        if (p) {
          if (p.codexThreadId && purgedThreadSet.has(p.codexThreadId)) {
            delete p.codexThreadId;
            modified = true;
          }
          if (p.canonicalCodexThreadId && purgedThreadSet.has(p.canonicalCodexThreadId)) {
            delete p.canonicalCodexThreadId;
            modified = true;
          }
        }
      }
    }
  }

  return { data, modified };
}

/** 原子替换：临时文件 → rename。失败就失败，绝不删旧文件。
 * 工单 08-R3：Windows 下 rename 可能与并发读取（外部验收轮询/杀软扫描）发生瞬时锁冲突，
 * 对 EBUSY/EPERM/ EACCES 做有界重试（3 次 × 60ms），失败仍保持原文件字节不变。 */
const REPLACE_RETRY_DELAYS_MS = [60, 60, 60];

async function flushFile(file) {
  const handle = await fsp.open(file, 'r+');
  try { await handle.sync(); } finally { await handle.close(); }
}

async function replaceFile(dir, payload) {
  const target = path.join(dir, DATA_FILE);
  const temp = path.join(dir, TEMP_FILE);

  await fsp.mkdir(dir, { recursive: true });
  // Flush bytes before publishing the new filename; rename alone is not durable.
  await fsp.writeFile(temp, payload, { encoding: 'utf8', flush: true });

  let lastErr = null;
  for (let attempt = 0; attempt <= REPLACE_RETRY_DELAYS_MS.length; attempt++) {
    try {
      await fsp.rename(temp, target);
      return { ok: true };
    } catch (e) {
      lastErr = e;
      const code = e && e.code;
      const transient = attempt < REPLACE_RETRY_DELAYS_MS.length && (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES');
      if (!transient) break;
      await new Promise((r) => setTimeout(r, REPLACE_RETRY_DELAYS_MS[attempt]));
    }
  }
  try { await fsp.rm(temp, { force: true }); } catch { /* 忽略 */ }
  return { ok: false, reason: `写入失败，原数据文件未被改动：${lastErr && lastErr.message}` };
}

class DataStore {
  constructor(userDataRoot, options = {}) {
    this.memoryEngine = options.memoryEngine || 'legacy';
    this.dir = path.join(userDataRoot, DATA_DIR_NAME);
    this.file = path.join(this.dir, DATA_FILE);
    this.backupFile = path.join(this.dir, BACKUP_FILE);
    this.chain = Promise.resolve();
    /** sessionId -> { revision, seq } ；seq 用于判定谁是当前会话 */
    this.sessions = new Map();
    /** 主进程持有的当前活跃会话。重载后旧会话不得再写 */
    this.activeSession = null;
    this.sessionSeq = 0;
    /** conversationId(:agentId) -> { threadId, instructionSources, profileId, lastVerifiedAt, lastVerifiedStatus, lastVerifiedError, timestamp, generation } */
    this.authoritativeBindings = new Map();
    /** 绑定代次单调序号：新旧只比 generation，不用 Date.now（同毫秒确定序） */
    this.bindingSeq = 0;
    /** 工单 08-R3：失败状态与成功绑定分存——失败只改状态，不覆盖最后成功 thread/来源/代次 */
    this.bindingFailures = new Map();
    /** 工单 09：永久删除世代追踪与墓碑缓存，避免普通保存误删权威绑定 */
    this.lastPurgedEpoch = 0;
    this.knownPurgedIds = new Set();
    /** 工单 09-R1：持久追踪被永久删除作废的旧 thread 墓碑，彻底阻断迟到快照与绑定复活 */
    this.knownPurgedThreadIds = new Set();
    this.purgedSets = new Map();
    this.purgedThreadSets = new Map();
  }

  _getPartitionKey(data) {
    const userId = data?.cloudSyncConfig?.userId;
    const homeId = data?.cloudSyncConfig?.homeId;
    if (userId && homeId) return `${userId}:${homeId}`;
    return 'default';
  }

  _getPurgedSet(partitionKey) {
    if (!this.purgedSets) this.purgedSets = new Map();
    if (!this.purgedSets.has(partitionKey)) {
      this.purgedSets.set(partitionKey, new Set(this.knownPurgedIds));
    }
    return this.purgedSets.get(partitionKey);
  }

  _getPurgedThreadSet(partitionKey) {
    if (!this.purgedThreadSets) this.purgedThreadSets = new Map();
    if (!this.purgedThreadSets.has(partitionKey)) {
      this.purgedThreadSets.set(partitionKey, new Set(this.knownPurgedThreadIds));
    }
    return this.purgedThreadSets.get(partitionKey);
  }

  purgeThreadBindings(threadIds) {
    if (!threadIds) return;
    const ids = new Set(Array.isArray(threadIds) ? threadIds : [threadIds]);
    if (ids.size === 0) return;
    for (const id of ids) this.knownPurgedThreadIds.add(id);
    if (this.authoritativeBindings) {
      for (const [k, v] of Array.from(this.authoritativeBindings.entries())) {
        if (v && ids.has(v.threadId)) {
          this.authoritativeBindings.delete(k);
        }
      }
    }
    if (this.bindingFailures) {
      for (const [k, v] of Array.from(this.bindingFailures.entries())) {
        if (v && ids.has(v.threadId)) {
          this.bindingFailures.delete(k);
        }
      }
    }
  }

  purgeAgentBindings(agentIds) {
    if (!Array.isArray(agentIds) || agentIds.length === 0) return;
    const ids = new Set(agentIds);
    if (this.authoritativeBindings) {
      for (const [k, v] of Array.from(this.authoritativeBindings.entries())) {
        if (v && ids.has(v.agentId)) {
          this.authoritativeBindings.delete(k);
        }
      }
    }
    if (this.bindingFailures) {
      for (const [k, v] of Array.from(this.bindingFailures.entries())) {
        if (v && ids.has(v.agentId)) {
          this.bindingFailures.delete(k);
        }
      }
    }
  }

  paths() {
    return { dir: this.dir, dataFile: this.file, backupFile: this.backupFile };
  }

  /** 当前主文件内容是否通过完整校验；每次都真读，不依赖缓存标志 */
  primaryIsValid() {
    try {
      return looksLikeValidAppData(fs.readFileSync(this.file, 'utf8'));
    } catch {
      return false;
    }
  }

  /**
   * 读取主文件，四态区分：
   * - missing: 文件不存在 = 真正的首次使用
   * - ok: 内容通过校验
   * - corrupt: 文件存在但损坏或为空
   * - unreadable: 存在但读不了（权限/占用），绝不当作同意覆盖
   */
  read() {
    let raw;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch (e) {
      if (e && e.code === 'ENOENT') return { ok: true, state: 'missing', raw: null };
      return { ok: false, state: 'unreadable', raw: null, reason: `无法读取数据文件：${e && e.message}` };
    }
    if (looksLikeValidAppData(raw)) return { ok: true, state: 'ok', raw };
    return { ok: true, state: 'corrupt', raw };
  }

  /**
   * 便捷读取并解析当前落盘数据对象
   * @returns {Object|null}
   */
  readCurrent() {
    const res = this.read();
    if (!res.ok || !res.raw) return null;
    try {
      return JSON.parse(res.raw);
    } catch {
      return null;
    }
  }

  /**
   * renderer 报告本 session 身份。
   * 每次 beginSession 都把它设为当前活跃会话：旧 renderer 的迟到写入会被拒。
   */
  beginSession(sessionId) {
    if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 128) {
      return { ok: false, reason: '会话标识不合法' };
    }
    this.sessionSeq += 1;
    this.activeSession = sessionId;
    if (!this.sessions.has(sessionId)) this.sessions.set(sessionId, { revision: -1, seq: this.sessionSeq });
    return { ok: true, sessionId, seq: this.sessionSeq };
  }

  /**
   * 权威持久化 Codex thread 绑定事务
   */
  bindThread(conversationId, profileId, threadId, instructionSources, verifiedAt, targetAgentId) {
    if (!conversationId || !threadId) {
      return Promise.resolve({ ok: false, applied: false, reason: '缺少 conversationId 或 threadId' });
    }
    if (this.knownPurgedThreadIds && this.knownPurgedThreadIds.has(threadId)) {
      return Promise.resolve({ ok: false, applied: false, reason: `Thread ${threadId} 已因消息永久删除而作废，拒绝绑定` });
    }
    const sources = Array.isArray(instructionSources) ? instructionSources : [];
    const vTime = typeof verifiedAt === 'string' && verifiedAt ? verifiedAt : new Date().toISOString();

    this.chain = this.chain
      .then(async () => {
        const readRes = this.read();
        if (!readRes.ok || !readRes.raw) {
          return { ok: false, applied: false, reason: readRes.reason || '数据文件未就绪或损坏，无法持久化会话绑定' };
        }
        let currentData;
        try {
          currentData = JSON.parse(readRes.raw);
        } catch (e) {
          return { ok: false, applied: false, reason: '解析数据 JSON 失败' };
        }

        const diskPurgedThreads = Array.isArray(currentData.purgedThreadIds) ? currentData.purgedThreadIds : [];
        for (const pt of diskPurgedThreads) this.knownPurgedThreadIds.add(pt);
        if (this.knownPurgedThreadIds.has(threadId)) {
          return { ok: false, applied: false, reason: `Thread ${threadId} 已因消息永久删除而作废，拒绝绑定` };
        }

        const targetConv = Array.isArray(currentData.conversations)
          ? currentData.conversations.find((c) => c.id === conversationId)
          : null;
        if (!targetConv) {
          return { ok: false, applied: false, reason: `目标会话 ${conversationId} 不存在，无法绑定` };
        }

        // 重新核验：目标 profile 是否仍存在
        let targetProf = null;
        if (Array.isArray(currentData.chatProfiles) && profileId) {
          targetProf = currentData.chatProfiles.find((p) => p.id === profileId);
        }
        if (profileId && !targetProf) {
          return { ok: false, applied: false, reason: `目标配置 ${profileId} 已被删除，拒绝绑定` };
        }

        // 检查成员归属：如果目标会话关联了 agent，该 agent 的 profileId 是否与 profileId 一致
        const agentIdToBind = targetAgentId || targetConv.agentId;
        if (agentIdToBind && Array.isArray(currentData.agents)) {
          const agent = currentData.agents.find((a) => a.id === agentIdToBind);
          if (agent && profileId && agent.profileId && agent.profileId !== profileId) {
            return { ok: false, applied: false, reason: `成员 ${agentIdToBind} 已换绑至其他配置，拒绝绑定` };
          }
          if (agent) {
            agent.canonicalCodexThreadId = threadId;
            agent.instructionSources = sources;
          }
        }

        // 仅对非客厅专属会话更新会话自身的 codexThreadId
        // 客厅会话属于多人共享空间，绝不能被单一成员的私聊 thread 绑死
        if (targetConv.kind !== 'living-room') {
          targetConv.codexThreadId = threadId;
          targetConv.instructionSources = sources;
        }

        // 如果是客厅会话绑定，将该成员的直连私聊会话也同步指向同一 canonical thread
        if (targetConv.kind === 'living-room' && agentIdToBind && Array.isArray(currentData.conversations)) {
          const directConv = currentData.conversations.find((c) => c.kind === 'direct' && c.agentId === agentIdToBind);
          if (directConv) {
            directConv.codexThreadId = threadId;
            directConv.instructionSources = sources;
          }
        }

        if (targetProf) {
          targetProf.codexThreadId = threadId;
          targetProf.canonicalCodexThreadId = threadId;
          targetProf.instructionSources = sources;
          targetProf.lastVerifiedAt = vTime;
          targetProf.lastVerifiedStatus = 'success';
          targetProf.lastVerifiedError = null;
        }

        const newPayload = JSON.stringify(currentData, null, 2);
        if (!looksLikeValidAppData(newPayload)) {
          return { ok: false, applied: false, reason: '绑定后的数据未通过校验，已拒绝写入' };
        }

        if (this.primaryIsValid()) {
          try {
            const tmpBackup = `${this.backupFile}.part`;
            await fsp.copyFile(this.file, tmpBackup);
            await flushFile(tmpBackup);
            await fsp.rename(tmpBackup, this.backupFile);
          } catch {}
        }

        const r = await replaceFile(this.dir, newPayload);
        if (!r.ok) {
          return { ok: false, applied: false, reason: r.reason };
        }

        // 记录权威绑定，防止随后到来的旧 snapshot 抹掉该 thread 和 sources
        // 客厅中每个成员拥有独立的权威记录，避免相互覆盖
        const isLivingRoom = targetConv.kind === 'living-room';
        const bindingKey = (isLivingRoom && agentIdToBind)
          ? `${conversationId}:${agentIdToBind}`
          : (conversationId || (agentIdToBind ? `agent:${agentIdToBind}` : 'unknown'));

        this.authoritativeBindings.set(bindingKey, {
          bindingKey,
          conversationId,
          isLivingRoom,
          threadId,
          instructionSources: sources,
          profileId: targetProf ? targetProf.id : profileId,
          agentId: agentIdToBind,
          lastVerifiedAt: vTime,
          lastVerifiedStatus: 'success',
          lastVerifiedError: null,
          timestamp: Date.now(),
          generation: ++this.bindingSeq,
        });

        // 递增当前 session revision（如果存在当前活跃 session）
        if (this.activeSession && this.sessions.has(this.activeSession)) {
          const entry = this.sessions.get(this.activeSession);
          this.sessions.set(this.activeSession, { revision: entry.revision + 1, seq: entry.seq });
        }

        return { ok: true, applied: true, threadId, instructionSources: sources, lastVerifiedAt: vTime };
      })
      .catch((e) => ({ ok: false, applied: false, reason: e && e.message ? e.message : '写入绑定失败' }));

    return this.chain;
  }

  /**
   * 记录会话/配置的当前验证失败，同时保留原 threadId 与历史已验证来源
   */
  recordVerificationFailure(conversationId, profileId, errorMessage, nowIso, targetAgentId) {
    const vTime = typeof nowIso === 'string' && nowIso ? nowIso : new Date().toISOString();
    const errMsg = typeof errorMessage === 'string' && errorMessage ? errorMessage : '验证失败';

    this.chain = this.chain
      .then(async () => {
        const readRes = this.read();
        if (!readRes.ok || !readRes.raw) {
          return { ok: false, applied: false, reason: '数据未就绪' };
        }
        let currentData;
        try {
          currentData = JSON.parse(readRes.raw);
        } catch (e) {
          return { ok: false, applied: false, reason: '解析数据 JSON 失败' };
        }

        let mutated = false;
        let targetProf = null;
        if (Array.isArray(currentData.chatProfiles) && profileId) {
          targetProf = currentData.chatProfiles.find((p) => p.id === profileId);
        }

        const targetConv = Array.isArray(currentData.conversations)
          ? currentData.conversations.find((c) => c.id === conversationId)
          : null;
        const isLivingRoom = targetConv?.kind === 'living-room';

        // 权威确定 agentId：优先 targetAgentId；否则若是 direct 会话取 targetConv.agentId；
        // 若在客厅且未传 targetAgentId，严禁从 profile 盲目推测成员！但可从 errMsg 提取明确成员标识（如 "B RESUME"）
        let agentId = targetAgentId || null;
        if (!agentId) {
          if (targetConv && !isLivingRoom && targetConv.agentId) {
            agentId = targetConv.agentId;
          } else if (errMsg && Array.isArray(currentData.agents)) {
            const matched = currentData.agents.find((a) => a.id && (
              errMsg.startsWith(`${a.id} `) ||
              errMsg.includes(` ${a.id} `) ||
              errMsg.includes(`[${a.id}]`) ||
              errMsg.includes(`成员${a.id}`) ||
              errMsg.includes(`agent:${a.id}`)
            ));
            if (matched) {
              agentId = matched.id;
            }
          }
        }

        // 仅在明确知道 agentId 时，才查询该成员自身的既有权威绑定（只读参考）；
        // 工单 08-R2：失败回调只记录"当前请求/绑定代次失败"，绝不选择另一个旧 thread 回写。
        const targetAgent = agentId && Array.isArray(currentData.agents)
          ? currentData.agents.find((a) => a.id === agentId)
          : null;
        void targetConv;
        void targetAgent;

        // 只有当 targetProf 不被多个成员共享，或者明确指明针对 targetProf 时更新其状态
        const agentsSharingProfile = targetProf && Array.isArray(currentData.agents)
          ? currentData.agents.filter((a) => a.profileId === targetProf.id)
          : [];
        if (targetProf && (agentsSharingProfile.length <= 1 || !agentId)) {
          targetProf.lastVerifiedStatus = 'error';
          targetProf.lastVerifiedError = errMsg;
          targetProf.lastVerifiedAt = vTime;
          mutated = true;
        }

        if (mutated) {
          const newPayload = JSON.stringify(currentData, null, 2);
          if (!looksLikeValidAppData(newPayload)) {
            return { ok: false, applied: false, reason: '更新验证失败后的数据未通过校验，已拒绝写入' };
          }
          if (this.primaryIsValid()) {
            try {
              const tmpBackup = `${this.backupFile}.part`;
              await fsp.copyFile(this.file, tmpBackup);
              await flushFile(tmpBackup);
              await fsp.rename(tmpBackup, this.backupFile);
            } catch {}
          }
          const r = await replaceFile(this.dir, newPayload);
          if (!r.ok) {
            return { ok: false, applied: false, reason: r.reason };
          }
        }

        // 仅在有明确绑定键且存在归属成员时记录失败状态；绝不能把 B 的失败写到 A 的缓存上。
        // 工单 08-R3：失败状态存入独立的 bindingFailures，绝不覆盖 authoritativeBindings 中的
        // 最后成功绑定（thread/来源/代次原样保留），后续 save() 的线程合并仍能取到最后成功 thread。
        const bindingKey = (isLivingRoom && agentId)
          ? `${conversationId}:${agentId}`
          : (conversationId || (agentId ? `agent:${agentId}` : null));

        if (bindingKey && agentId) {
          this.bindingFailures.set(bindingKey, {
            bindingKey,
            conversationId,
            isLivingRoom,
            profileId: targetProf ? targetProf.id : profileId,
            agentId,
            lastVerifiedAt: vTime,
            lastVerifiedStatus: 'error',
            lastVerifiedError: errMsg,
            timestamp: Date.now(),
            generation: ++this.bindingSeq,
          });
        }

        return { ok: true, applied: mutated };
      })
      .catch((e) => ({ ok: false, applied: false, reason: e?.message || '记录验证失败异常' }));

    return this.chain;
  }

  /**
   * 串行写入。
   * @param {string} payload 完整 JSON 文本
   * @param {number} revision
   * @param {string} sessionId
   */
  save(payload, revision, sessionId, options = {}) {
    const sid = typeof sessionId === 'string' && sessionId ? sessionId : 'default';
    let rev = Number.isInteger(revision) ? revision : 0;
    const isRemoteSync = Boolean(options && (options.source === 'remote_sync' || options.isRemoteSync));

    this.chain = this.chain
      .then(async () => {
        // 旧 renderer（重载前的会话）不得再写：它已经不是当前会话
        if (sid !== this.activeSession) {
          return { ok: true, skipped: true, applied: false, reason: '来自已失效的会话，未写入' };
        }
        const entry = this.sessions.get(sid) ?? { revision: -1, seq: 0 };
        if (typeof options.mutator === 'function') {
          const current = this.read();
          if (!current.ok || !current.raw) return {ok:false,applied:false,reason:'无法读取数据以执行修改'};
          try {
            const fresh = JSON.parse(current.raw);
            options.mutator(fresh);
            payload = JSON.stringify(fresh, null, 2);
            rev = entry.revision + 1;
          } catch (e) { return {ok:false,applied:false,reason:e.message}; }
        }
        if (typeof options.mutator !== 'function' && rev <= entry.revision) {
          // 同一会话内迟到的旧状态：丢弃，但不能谎称“当前状态已保存”
          return { ok: true, skipped: true, applied: false, reason: '被更新的版本取代，未写入' };
        }

        // 保护权威绑定：若快照产生于绑定之前或缺失了已确认的 thread/sources/验证状态，进行原子合并保全
        let effectivePayload = payload;
        let purgedSet = new Set();
        let purgedThreadSet = new Set();
        try {
          const parsed = JSON.parse(payload);
          let mutated = false;

          let isNewPurgeEvent = false;
          const currentEpoch = typeof parsed.purgedMessageEpoch === 'number' ? parsed.purgedMessageEpoch : 0;

          // 1. 读取主文件已有墓碑并与内存墓碑合并
          let diskParsed = null;
          try {
            const disk = this.read();
            if (disk.ok && disk.raw) {
              diskParsed = JSON.parse(disk.raw);
              if (Array.isArray(diskParsed.purgedMessageIds)) {
                for (const id of diskParsed.purgedMessageIds) this.knownPurgedIds.add(id);
              }
              if (Array.isArray(diskParsed.purgedThreadIds)) {
                for (const id of diskParsed.purgedThreadIds) this.knownPurgedThreadIds.add(id);
              }
            }
          } catch {}

          if (Array.isArray(parsed.purgedMessageIds)) {
            for (const id of parsed.purgedMessageIds) {
              if (!this.knownPurgedIds.has(id)) {
                isNewPurgeEvent = true;
                this.knownPurgedIds.add(id);
              }
            }
          }
          if (Array.isArray(parsed.purgedThreadIds)) {
            for (const id of parsed.purgedThreadIds) {
              if (!this.knownPurgedThreadIds.has(id)) {
                isNewPurgeEvent = true;
                this.knownPurgedThreadIds.add(id);
              }
            }
          }
          if (currentEpoch > this.lastPurgedEpoch) {
            isNewPurgeEvent = true;
            this.lastPurgedEpoch = currentEpoch;
          }

          // 2. 使用全部已知墓碑净化当前快照（防止迟到快照或旧版本快照复活已删消息与旧 thread）
          purgedSet = new Set(this.knownPurgedIds);
          purgedThreadSet = new Set(this.knownPurgedThreadIds);
          if (purgedSet.size > 0 || purgedThreadSet.size > 0) {
            const sanitized = sanitizeAppDataWithPurgedIds(parsed, purgedSet, purgedThreadSet);
            if (sanitized.modified) mutated = true;

            const curPurgedList = Array.isArray(parsed.purgedMessageIds) ? parsed.purgedMessageIds : [];
            if (curPurgedList.length !== purgedSet.size) {
              parsed.purgedMessageIds = Array.from(purgedSet);
              mutated = true;
            }
            const curPurgedThreads = Array.isArray(parsed.purgedThreadIds) ? parsed.purgedThreadIds : [];
            if (curPurgedThreads.length !== purgedThreadSet.size) {
              parsed.purgedThreadIds = Array.from(purgedThreadSet);
              mutated = true;
            }
          }

          // 清除已被永久作废的 thread 权威绑定
          if (purgedThreadSet.size > 0) {
            this.purgeThreadBindings(Array.from(purgedThreadSet));
          }

          // 仅在真实发生永久删除事件时，若某成员在本次删除中被重置了专属 thread，才抹除权威绑定缓存
          if (isNewPurgeEvent && Array.isArray(parsed.agents)) {
            for (const ag of parsed.agents) {
              if (ag && (ag.canonicalCodexThreadId === undefined || ag.canonicalCodexThreadId === null)) {
                this.purgeAgentBindings([ag.id]);
              }
            }
          }

          if ((this.authoritativeBindings && this.authoritativeBindings.size > 0) || (this.bindingFailures && this.bindingFailures.size > 0)) {
            // 1. 按 agentId 与 profileId 归集最新记录（按绑定代次单调比较，同毫秒也有确定序）。
            //    工单 08-R3：thread/sources 只从成功绑定归集；验证状态从成功绑定+失败记录共同归集，
            //    失败记录永远无法删除或刷新最后成功 thread。
            const genOf = (b) => (typeof b.generation === 'number'
              ? b.generation
              : (b.timestamp || (b.lastVerifiedAt ? new Date(b.lastVerifiedAt).getTime() : 0)));
            const agentLatestThread = new Map();   // thread/sources 来源：仅成功绑定
            const agentLatestStatus = new Map();   // 验证状态来源：成功绑定 + 失败记录
            const profLatestThread = new Map();
            const profLatestStatus = new Map();
            const mergeBinding = (binding) => {
              const g = genOf(binding);
              if (binding.agentId) {
                if (binding.threadId && !purgedThreadSet.has(binding.threadId)) {
                  const cur = agentLatestThread.get(binding.agentId);
                  if (!cur || g > genOf(cur)) agentLatestThread.set(binding.agentId, binding);
                }
                const cs = agentLatestStatus.get(binding.agentId);
                if (!cs || g > genOf(cs)) agentLatestStatus.set(binding.agentId, binding);
              }
              if (binding.profileId) {
                if (binding.threadId && !purgedThreadSet.has(binding.threadId)) {
                  const cur = profLatestThread.get(binding.profileId);
                  if (!cur || g > genOf(cur)) profLatestThread.set(binding.profileId, binding);
                }
                const cs = profLatestStatus.get(binding.profileId);
                if (!cs || g > genOf(cs)) profLatestStatus.set(binding.profileId, binding);
              }
            };
            for (const binding of this.authoritativeBindings.values()) mergeBinding(binding);
            for (const failure of this.bindingFailures.values()) mergeBinding(failure);

            // 对每个成员更新其 canonicalCodexThreadId 与 instructionSources（严格使用该成员最新绑定）
            if (Array.isArray(parsed.agents)) {
              for (const ag of parsed.agents) {
                const latest = agentLatestThread.get(ag.id);
                if (latest && latest.threadId && !purgedThreadSet.has(latest.threadId)) {
                  const threadDiffers = ag.canonicalCodexThreadId !== latest.threadId;
                  const sourcesDiffer = JSON.stringify(ag.instructionSources || []) !== JSON.stringify(latest.instructionSources || []);
                  if (threadDiffers || sourcesDiffer) {
                    ag.canonicalCodexThreadId = latest.threadId;
                    ag.instructionSources = latest.instructionSources;
                    mutated = true;
                  }
                }
              }
            }

            // 2. direct 会话是成员权威绑定的派生视图：始终镜像该成员最新 thread（按代次），
            //    不再优先旧 direct 会话缓存，失败记录（threadId=null）也不会被选中。
            if (Array.isArray(parsed.conversations)) {
              for (const c of parsed.conversations) {
                if (c.kind === 'direct') {
                  const effectiveBinding = c.agentId ? agentLatestThread.get(c.agentId) : null;
                  if (effectiveBinding && effectiveBinding.threadId && !purgedThreadSet.has(effectiveBinding.threadId)) {
                    const threadDiffers = c.codexThreadId !== effectiveBinding.threadId;
                    const sourcesDiffer = JSON.stringify(c.instructionSources || []) !== JSON.stringify(effectiveBinding.instructionSources || []);
                    if (threadDiffers || sourcesDiffer) {
                      c.codexThreadId = effectiveBinding.threadId;
                      c.instructionSources = effectiveBinding.instructionSources;
                      mutated = true;
                    }
                  }
                } else if (c.kind === 'living-room') {
                  // 客厅公共会话绝不被任何单成员 threadId 绑定
                  if (c.codexThreadId !== undefined) {
                    delete c.codexThreadId;
                    mutated = true;
                  }
                }
              }
            }

            // 3. 保护 profile 验证状态与专属 thread（状态按代次取最新，成功与失败记录都参与）
            if (Array.isArray(parsed.chatProfiles)) {
              for (const p of parsed.chatProfiles) {
                const latestProfStatus = profLatestStatus.get(p.id);
                if (latestProfStatus && latestProfStatus.lastVerifiedStatus !== undefined) {
                  if (p.lastVerifiedStatus !== latestProfStatus.lastVerifiedStatus || p.lastVerifiedError !== latestProfStatus.lastVerifiedError) {
                    p.lastVerifiedStatus = latestProfStatus.lastVerifiedStatus;
                    p.lastVerifiedError = latestProfStatus.lastVerifiedError;
                    p.lastVerifiedAt = latestProfStatus.lastVerifiedAt;
                    mutated = true;
                  }
                }

                const sharingAgents = (parsed.agents || []).filter((a) => a.profileId === p.id);
                // 仅当 profile 专属唯一单成员时，才镜像 threadId；多成员共享 profile 严禁绑定单一成员 thread
                if (sharingAgents.length === 1) {
                  const singleAgent = sharingAgents[0];
                  const latest = agentLatestThread.get(singleAgent.id);
                  if (latest && latest.threadId && !purgedThreadSet.has(latest.threadId)) {
                    if (p.codexThreadId !== latest.threadId || p.canonicalCodexThreadId !== latest.threadId) {
                      p.codexThreadId = latest.threadId;
                      p.canonicalCodexThreadId = latest.threadId;
                      p.instructionSources = latest.instructionSources;
                      mutated = true;
                    }
                  }
                } else if (sharingAgents.length > 1) {
                  // 共享 profile 清除单一 thread 绑定，杜绝串线
                  if (p.codexThreadId || p.canonicalCodexThreadId) {
                    delete p.codexThreadId;
                    delete p.canonicalCodexThreadId;
                    mutated = true;
                  }
                }
              }
            }
          }

          // CloudSync 配置与待同步队列的合并与保全（仅非 remote_sync 写入时防止渲染端无意识抹除）
          if (!isRemoteSync && diskParsed && diskParsed.cloudSyncConfig && !parsed.cloudSyncConfig) {
            parsed.cloudSyncConfig = diskParsed.cloudSyncConfig;
            mutated = true;
          }
          if (!isRemoteSync && diskParsed && Array.isArray(diskParsed.cloudSyncOutbox) && diskParsed.cloudSyncOutbox.length > 0) {
            if (!Array.isArray(parsed.cloudSyncOutbox)) parsed.cloudSyncOutbox = [];
            const curOutboxIds = new Set(parsed.cloudSyncOutbox.map((x) => x.operationId));
            for (const item of diskParsed.cloudSyncOutbox) {
              if (!curOutboxIds.has(item.operationId)) {
                parsed.cloudSyncOutbox.push(item);
                curOutboxIds.add(item.operationId);
                mutated = true;
              }
            }
          }
          if (!isRemoteSync && diskParsed && diskParsed.cloudSyncSyncState && !parsed.cloudSyncSyncState) {
            parsed.cloudSyncSyncState = diskParsed.cloudSyncSyncState;
            mutated = true;
          }

          if (!isRemoteSync) {
            deriveAutomaticMemory(parsed, diskParsed, this.memoryEngine);
            mutated = true;
            if (diskParsed?.cloudSyncConfig && parsed.cloudSyncConfig?.homeId === diskParsed.cloudSyncConfig.homeId) {
              parsed.cloudSyncConfig.lastCommitSeq = Math.max(parsed.cloudSyncConfig.lastCommitSeq || 0, diskParsed.cloudSyncConfig.lastCommitSeq || 0);
              for (const field of ['messages', 'memories', 'checkpoints', 'conversations']) {
                const key = field === 'messages' ? 'revision' : field === 'conversations' ? 'syncVersion' : 'version';
                const oldById = new Map((diskParsed[field] || []).map(x => [x.id,x]));
                for (const item of parsed[field] || []) item[key] = Math.max(item[key] || 0, oldById.get(item.id)?.[key] || 0);
              }
              // ACKed operations from a stale renderer must not return to the outbox.
              parsed.cloudSyncOutbox = (parsed.cloudSyncOutbox || []).filter(op => {
                if (op.status !== 'pending' || !['message','memory','checkpoint'].includes(op.entityType)) return true;
                const field = {message:'messages',memory:'memories',checkpoint:'checkpoints'}[op.entityType];
                const old = (diskParsed[field] || []).find(x=>x.id===op.entityId);
                return !old || (old.revision || old.version || 0) <= (op.expectedVersion || 0);
              });
            }
          }

          // 本地写入触发 CloudSync 待同步队列对比（非 remote_sync 写入时）
          if (!isRemoteSync && parsed.cloudSyncConfig && parsed.cloudSyncConfig.enabled && diskParsed) {
            if (!Array.isArray(parsed.cloudSyncOutbox)) parsed.cloudSyncOutbox = [];
            const outboxSet = new Set(parsed.cloudSyncOutbox.map((x) => x.operationId));
            for (const conv of parsed.conversations || []) {
              if (conv.syncVersion || parsed.cloudSyncOutbox.some(op=>op.entityType==='conversation'&&op.entityId===conv.id)) continue;
              const operationId = `op_conv_${conv.id}_initial`;
              parsed.cloudSyncOutbox.push({operationId,entityType:'conversation',entityId:conv.id,opType:'upsert',payload:{kind:conv.kind,direct_member_id:conv.agentId,title:conv.title,created_at_ms:conv.createdAt},expectedVersion:0,createdAt:Date.now(),attempts:0,status:'pending'});
              outboxSet.add(operationId);
              mutated = true;
            }

            const getNextExpectedVersion = (entityId, baseVersion) => {
              const pendingOps = parsed.cloudSyncOutbox.filter((op) => op.entityId === entityId && op.status === 'pending');
              if (pendingOps.length > 0) {
                const last = pendingOps[pendingOps.length - 1];
                if (last.expectedVersion !== null && last.expectedVersion !== undefined) {
                  return last.expectedVersion + 1;
                }
              }
              return baseVersion;
            };

            // 1. 对比 messages (增、改、删)
            const oldMsgMap = new Map((diskParsed.messages || []).map((m) => [m.id, m]));
            const newMsgMap = new Map((parsed.messages || []).map((m) => [m.id, m]));

            for (const m of (parsed.messages || [])) {
              if (m.demo) continue;
              const old = oldMsgMap.get(m.id);
              if (!old || (!m.revision && !parsed.cloudSyncOutbox.some(op=>op.entityType==='message' && op.entityId===m.id))) {
                const opId = `op_msg_${m.id}_1`;
                if (!outboxSet.has(opId)) {
                  parsed.cloudSyncOutbox.push({
                    operationId: opId,
                    entityType: 'message',
                    entityId: m.id,
                    opType: 'upsert',
                    payload: {
                      conversation_id: m.conversationId,
                      speaker_id: m.agentId,
                      text: m.text,
                      status: m.status,
                      demo: m.demo,
                      request_id: m.requestId,
                      occurred_at: m.createdAt,
                      saved_at: m.createdAt,
                      edited_at: m.editedAt,
                      target_agent_id: m.targetAgentId,
                    },
                    expectedVersion: getNextExpectedVersion(m.id, 0),
                    createdAt: Date.now(),
                    attempts: 0,
                    status: 'pending',
                  });
                  outboxSet.add(opId);
                  mutated = true;
                }
              } else if (m.text !== old.text || m.editedAt !== old.editedAt || m.status !== old.status || (()=>{
                const pending=parsed.cloudSyncOutbox.filter(op=>op.entityType==='message'&&op.entityId===m.id&&op.status==='pending'&&op.opType==='upsert').at(-1);
                return pending && (pending.payload.text!==m.text || pending.payload.status!==m.status);
              })()) {
                if ((m.revision || 0) >= (old.revision || 0)) {
                  const opId = `op_msg_${m.id}_${randomUUID()}`;
                  if (!outboxSet.has(opId)) {
                    parsed.cloudSyncOutbox.push({
                      operationId: opId,
                      entityType: 'message',
                      entityId: m.id,
                      opType: 'upsert',
                      payload: {
                        conversation_id: m.conversationId,
                        speaker_id: m.agentId,
                        text: m.text,
                        status: m.status,
                        demo: m.demo,
                        request_id: m.requestId,
                        occurred_at: m.createdAt,
                        saved_at: Date.now(),
                        edited_at: m.editedAt || Date.now(),
                        target_agent_id: m.targetAgentId,
                      },
                      expectedVersion: getNextExpectedVersion(m.id, old.revision || 1),
                      createdAt: Date.now(),
                      attempts: 0,
                      status: 'pending',
                    });
                    outboxSet.add(opId);
                    mutated = true;
                  }
                }
              }
            }

            for (const [oldId, oldM] of oldMsgMap.entries()) {
              if (!newMsgMap.has(oldId) || (Array.isArray(parsed.purgedMessageIds) && parsed.purgedMessageIds.includes(oldId))) {
                const opId = `op_msg_del_${oldId}`;
                if (!outboxSet.has(opId)) {
                  parsed.cloudSyncOutbox.push({
                    operationId: opId,
                    entityType: 'message',
                    entityId: oldId,
                    opType: 'delete',
                    payload: { deleted_at: Date.now() },
                    expectedVersion: getNextExpectedVersion(oldId, oldM.revision || 1),
                    createdAt: Date.now(),
                    attempts: 0,
                    status: 'pending',
                  });
                  outboxSet.add(opId);
                  mutated = true;
                }
              }
            }

            // 若原话被删除、净化或修改，级联使派生记忆失效（真传播）
            const invalidatedMsgIds = new Set();
            for (const [oldId, oldM] of oldMsgMap.entries()) {
              const newM = newMsgMap.get(oldId);
              const isDel = !newM || (Array.isArray(parsed.purgedMessageIds) && parsed.purgedMessageIds.includes(oldId)) || newM.deletedAt || newM.status === 'deleted';
              const isEdit = newM && (newM.text !== oldM.text || newM.editedAt !== oldM.editedAt);
              if (isDel || isEdit) {
                invalidatedMsgIds.add(oldId);
              }
            }

            if (invalidatedMsgIds.size > 0 && Array.isArray(parsed.memories)) {
              for (const mem of parsed.memories) {
                const srcId = mem.sourceMessageId;
                const srcIds = Array.isArray(mem.sourceMessageIds) ? mem.sourceMessageIds : [];
                if ((srcId && invalidatedMsgIds.has(srcId)) || srcIds.some((id) => invalidatedMsgIds.has(id))) {
                  if (mem.status !== 'invalidated') {
                    mem.status = 'invalidated';
                    mem.revisionReason = 'source_message_invalidated';
                    mutated = true;
                  }
                }
              }
            }

            // 2. 对比 memories (增、改、删)
            const oldMemMap = new Map((diskParsed.memories || []).map((mem) => [mem.id, mem]));
            const newMemMap = new Map((parsed.memories || []).map((mem) => [mem.id, mem]));

            const ensureSourceMessageEnqueued = (srcId) => {
              if (!srcId || !Array.isArray(parsed.messages)) return;
              const srcMsg = parsed.messages.find((m) => m.id === srcId);
              if (srcMsg && !srcMsg.revision) {
                const srcOpId = `op_msg_${srcId}_1`;
                if (!outboxSet.has(srcOpId)) {
                  parsed.cloudSyncOutbox.push({
                    operationId: srcOpId,
                    entityType: 'message',
                    entityId: srcMsg.id,
                    opType: 'upsert',
                    payload: {
                      conversation_id: srcMsg.conversationId,
                      speaker_id: srcMsg.agentId,
                      text: srcMsg.text,
                      status: srcMsg.status || 'sent',
                      demo: Boolean(srcMsg.demo),
                      request_id: srcMsg.requestId,
                      occurred_at: srcMsg.createdAt,
                      saved_at: srcMsg.createdAt,
                      edited_at: srcMsg.editedAt,
                      target_agent_id: srcMsg.targetAgentId,
                    },
                    expectedVersion: getNextExpectedVersion(srcMsg.id, 0),
                    createdAt: Date.now(),
                    attempts: 0,
                    status: 'pending',
                  });
                  outboxSet.add(srcOpId);
                  mutated = true;
                }
              }
            };

            for (const mem of (parsed.memories || [])) {
              const old = oldMemMap.get(mem.id);
              if (!old || (!mem.version && !parsed.cloudSyncOutbox.some(op=>op.entityType==='memory' && op.entityId===mem.id))) {
                for(const sourceId of (mem.sourceMessageIds||[mem.sourceMessageId]).filter(Boolean)) ensureSourceMessageEnqueued(sourceId);
                const opId = `op_mem_${mem.id}_1`;
                if (!outboxSet.has(opId)) {
                  parsed.cloudSyncOutbox.push({
                    operationId: opId,
                    entityType: 'memory',
                    entityId: mem.id,
                    opType: 'upsert',
                    payload: {
                      scope_type: mem.scope?.type || 'direct',
                      scope_id: mem.scope?.id || null,
                      author_member_id: mem.authorAgentId || 'agent_owner',
                      title: mem.title,
                      content: mem.content,
                      memory_type: mem.memoryType === 'inference' ? 'model_inference' : (mem.memoryType || 'experience'),
                      status: mem.status === 'confirmed' ? 'active' : (mem.status || 'active'),
                      source_message_ids: mem.sourceMessageIds || (mem.sourceMessageId ? [mem.sourceMessageId] : []),
                      occurred_at: mem.createdAt,
                      saved_at: mem.savedAt || mem.createdAt,
                      pinned: mem.pinned || false,
                      tags: mem.tags,
                      triggers: mem.triggers,
                      review_at: mem.reviewAt,
                      valid_until: mem.validUntil,
                      superseded_by: mem.supersededBy,
                      revision_reason: mem.revisionReason,
                      resolved_by: mem.resolvedBy,
                      resolved_at: mem.resolvedAt,
                      share_basis: mem.shareBasis,
                      share_granted_at: mem.shareGrantedAt,
                    },
                    expectedVersion: getNextExpectedVersion(mem.id, 0),
                    createdAt: Date.now(),
                    attempts: 0,
                    status: 'pending',
                  });
                  outboxSet.add(opId);
                  mutated = true;
                }
              } else {
                // 普通编辑保留冲突：如果原本处于冲突状态，而新保存未附带明确裁决，则冲突状态必须保留
                if (old.conflict && !mem.conflict) {
                  mem.conflict = old.conflict;
                  mutated = true;
                }
                if (
                  mem.content !== old.content ||
                  mem.status !== old.status ||
                  mem.title !== old.title ||
                  (Boolean(old.conflict) && !mem.conflict) ||
                  (Array.isArray(parsed.cloudSyncOutbox) && parsed.cloudSyncOutbox.some((o) => o.entityId === mem.id && o.entityType === 'memory' && o.status === 'conflict' && !mem.conflict))
                ) {
                  const opId = `op_mem_${mem.id}_${Date.now()}`;
                  const isConflict = Boolean(mem.conflict);

                  let oldConflictVer = null;
                  if (!isConflict && Array.isArray(parsed.cloudSyncOutbox)) {
                    const oldConflictOp = parsed.cloudSyncOutbox.find(
                      (o) => o.entityId === mem.id && o.entityType === 'memory' && o.status === 'conflict'
                    );
                    if (oldConflictOp) {
                      oldConflictVer = oldConflictOp.expectedVersion || oldConflictOp.conflict?.remoteVersion;
                    }
                    parsed.cloudSyncOutbox = parsed.cloudSyncOutbox.filter(
                      (o) => !(o.entityId === mem.id && o.entityType === 'memory' && o.status === 'conflict')
                    );
                  }

                  if (!outboxSet.has(opId)) {
                    for(const sourceId of (mem.sourceMessageIds||[mem.sourceMessageId]).filter(Boolean)) ensureSourceMessageEnqueued(sourceId);
                    const fallbackExpectedVer = oldConflictVer || (mem.version ? mem.version - 1 : old.version || 1);
                    const expVer = isConflict
                      ? (mem.conflict.baseVersion || 1)
                      : Math.max(old.version || 1, fallbackExpectedVer, getNextExpectedVersion(mem.id, fallbackExpectedVer));
                    parsed.cloudSyncOutbox.push({
                      operationId: opId,
                      entityType: 'memory',
                      entityId: mem.id,
                      opType: mem.status === 'deleted' ? 'delete' : 'upsert',
                      payload: {
                        scope_type: mem.scope?.type || 'direct',
                        scope_id: mem.scope?.id || null,
                        author_member_id: mem.authorAgentId || 'agent_owner',
                        title: mem.title,
                        content: mem.content,
                        memory_type: mem.memoryType === 'inference' ? 'model_inference' : (mem.memoryType || 'experience'),
                        status: mem.status === 'confirmed' ? 'active' : (mem.status || 'active'),
                        source_message_ids: mem.sourceMessageIds || (mem.sourceMessageId ? [mem.sourceMessageId] : []),
                        occurred_at: mem.createdAt,
                        saved_at: Date.now(),
                        pinned: mem.pinned || false,
                        tags: mem.tags,
                        triggers: mem.triggers,
                        review_at: mem.reviewAt,
                        valid_until: mem.validUntil,
                        superseded_by: mem.supersededBy,
                        revision_reason: mem.revisionReason,
                        resolved_by: mem.resolvedBy,
                        resolved_at: mem.resolvedAt,
                        share_basis: mem.shareBasis,
                        share_granted_at: mem.shareGrantedAt,
                      },
                      expectedVersion: expVer,
                      createdAt: Date.now(),
                      attempts: 0,
                      status: isConflict ? 'conflict' : 'pending',
                      conflictReason: isConflict ? 'concurrent_remote_and_local_modification' : undefined,
                      conflict: mem.conflict,
                    });
                    outboxSet.add(opId);
                    mutated = true;
                  }
                }
              }
            }

            for (const [oldId, oldMem] of oldMemMap.entries()) {
              const isTombstoned = Array.isArray(parsed.memoryTombstones) && parsed.memoryTombstones.includes(oldId);
              const isMarkedDeleted = newMemMap.has(oldId) && newMemMap.get(oldId).status === 'deleted';
              if (isTombstoned || isMarkedDeleted) {
                const opId = `op_mem_del_${oldId}`;
                if (!outboxSet.has(opId)) {
                  parsed.cloudSyncOutbox.push({
                    operationId: opId,
                    entityType: 'memory',
                    entityId: oldId,
                    opType: 'delete',
                    payload: { deleted_at: Date.now() },
                    expectedVersion: getNextExpectedVersion(oldId, oldMem.version || 1),
                    createdAt: Date.now(),
                    attempts: 0,
                    status: 'pending',
                  });
                  outboxSet.add(opId);
                  mutated = true;
                }
              }
            }

            // 3. 对比 checkpoints (增、删)
            const oldCpMap = new Map((diskParsed.checkpoints || []).map((cp) => [cp.id, cp]));
            const newCpMap = new Map((parsed.checkpoints || []).map((cp) => [cp.id, cp]));

            for (const cp of (parsed.checkpoints || [])) {
              const old = oldCpMap.get(cp.id);
              if (!old || (!cp.version && !parsed.cloudSyncOutbox.some(op=>op.entityType==='checkpoint' && op.entityId===cp.id))) {
                const opId = `op_cp_${cp.id}_1`;
                if (!outboxSet.has(opId)) {
                  parsed.cloudSyncOutbox.push({
                    operationId: opId,
                    entityType: 'checkpoint',
                    entityId: cp.id,
                    opType: 'upsert',
                    payload: {
                      conversation_id: cp.conversationId,
                      summary: cp.summary,
                      created_before_message_id: cp.createdBeforeMessageId,
                      source_message_range: cp.sourceMessageRange,
                      source_messages_hash: cp.sourceMessagesHash,
                      source_message_snapshots: cp.sourceMessageSnapshots,
                      status: cp.status || 'active',
                      created_at_ms: cp.createdAt,
                    },
                    expectedVersion: getNextExpectedVersion(cp.id, 0),
                    createdAt: Date.now(),
                    attempts: 0,
                    status: 'pending',
                  });
                  outboxSet.add(opId);
                  mutated = true;
                }
              }
            }

            for (const [oldId, oldCp] of oldCpMap.entries()) {
              if (!newCpMap.has(oldId) || (newCpMap.get(oldId).status === 'invalidated' && oldCp.status !== 'invalidated')) {
                const opId = `op_cp_del_${oldId}`;
                if (!outboxSet.has(opId)) {
                  parsed.cloudSyncOutbox.push({
                    operationId: opId,
                    entityType: 'checkpoint',
                    entityId: oldId,
                    opType: 'delete',
                    payload: { deleted_at: Date.now() },
                    expectedVersion: getNextExpectedVersion(oldId, oldCp.version || 1),
                    createdAt: Date.now(),
                    attempts: 0,
                    status: 'pending',
                  });
                  outboxSet.add(opId);
                  mutated = true;
                }
              }
            }
          }

          if (mutated) {
            effectivePayload = JSON.stringify(parsed, null, 2);
          }
        } catch {}

        // 新 payload 必须通过完整 schema 校验，不接受任意 JSON 或不支持的版本
        if (!looksLikeValidAppData(effectivePayload)) {
          return { ok: false, applied: false, reason: '数据未通过校验，已拒绝写入（原文件未改动）' };
        }

        // 备份只用「当前经校验的有效主文件」，每次真读判断，不靠缓存标志
        let backupFailed = false;
        let backupWritten = false;
        if (this.primaryIsValid()) {
          try {
            // 先写临时副本再替换，避免半截文件盖掉有效副本
            const tmpBackup = `${this.backupFile}.part`;
            await fsp.copyFile(this.file, tmpBackup);
            await flushFile(tmpBackup);
            await fsp.rename(tmpBackup, this.backupFile);
            backupWritten = true;
            // 备份同等净化：若存在墓碑，必须同步从 backup 中抹除已永久删除的消息正文与派生，以及已作废的 thread 绑定
            if ((purgedSet.size > 0 || purgedThreadSet.size > 0) && fs.existsSync(this.backupFile)) {
              try {
                const bRaw = await fsp.readFile(this.backupFile, 'utf8');
                const bParsed = JSON.parse(bRaw);
                const { data: bClean, modified } = sanitizeAppDataWithPurgedIds(bParsed, purgedSet, purgedThreadSet);
                if (modified || purgedSet.size > 0 || purgedThreadSet.size > 0) {
                  if (purgedSet.size > 0) {
                    bClean.purgedMessageIds = Array.from(new Set([...(bClean.purgedMessageIds || []), ...purgedSet]));
                  }
                  if (purgedThreadSet.size > 0) {
                    bClean.purgedThreadIds = Array.from(new Set([...(bClean.purgedThreadIds || []), ...purgedThreadSet]));
                  }
                  await fsp.writeFile(tmpBackup, JSON.stringify(bClean, null, 2), { encoding: 'utf8', flush: true });
                  await fsp.rename(tmpBackup, this.backupFile);
                }
              } catch {}
            }
          } catch {
            backupFailed = true;
            try { await fsp.rm(`${this.backupFile}.part`, { force: true }); } catch { /* 忽略 */ }
          }
        }

        const r = await replaceFile(this.dir, effectivePayload);
        if (!r.ok) {
          // 失败后队列必须恢复可用，调用方可重试
          return { ok: false, applied: false, reason: r.reason };
        }
        this.sessions.set(sid, { revision: typeof options.mutator === 'function' ? entry.revision : rev, seq: entry.seq });
        return { ok: true, applied: true, skipped: false, backupWritten, backupFailed };
      })
      // 单次失败不拖垮整条链：返回失败结果，后续操作照常排队
      .catch((e) => ({ ok: false, applied: false, reason: e && e.message ? e.message : '写入失败' }));

    return this.chain;
  }

  flush() {
    return this.chain.catch(() => undefined);
  }

  /** 损坏原文另存为 recovery 文件；先写临时文件再改名，失败不覆盖任何东西 */
  backupRaw(raw, stamp) {
    const name = `recovery.${stamp || Date.now()}.json`;
    const target = path.join(this.dir, name);
    const temp = `${target}.part`;
    // 注意：这里挂在链上，但失败会被 .catch 吃掉，不会让后续操作被跳过
    this.chain = this.chain
      .then(async () => {
        await fsp.mkdir(this.dir, { recursive: true });
        await fsp.writeFile(temp, typeof raw === 'string' ? raw : '', { encoding: 'utf8', flush: true });
        await fsp.rename(temp, target);
        return { ok: true, applied: true, path: target };
      })
      .catch(async (e) => {
        try { await fsp.rm(temp, { force: true }); } catch { /* 忽略 */ }
        return { ok: false, applied: false, reason: `原文备份失败，未替换任何数据：${e && e.message}` };
      });
    return this.chain;
  }

  /**
   * 读取最近一次有效副本。只有通过完整校验才算可用。
   * 恢复动作本身由 renderer 在确认后调用 restoreBackupToPrimary。
   */
  readBackup() {
    let raw;
    try {
      raw = fs.readFileSync(this.backupFile, 'utf8');
    } catch (e) {
      if (e && e.code === 'ENOENT') return { ok: false, usable: false, raw: null, reason: '没有可用的历史副本' };
      return { ok: false, usable: false, raw: null, reason: `副本无法读取：${e && e.message}` };
    }
    if (!looksLikeValidAppData(raw)) {
      return { ok: false, usable: false, raw, reason: '历史副本未通过校验，不能用于恢复' };
    }
    return { ok: true, usable: true, raw };
  }

  /** 用有效副本恢复主文件；副本本身保留，不销毁 */
  restoreBackupToPrimary(sessionId, revision) {
    const sid = typeof sessionId === 'string' && sessionId ? sessionId : 'default';
    this.chain = this.chain
      .then(async () => {
        const rev = Number.isInteger(revision) ? revision : 0;
        const entry = this.sessions.get(sid) ?? { revision: -1, seq: 0 };
        if (sid !== this.activeSession || rev <= entry.revision) {
          return { ok: true, applied: false, skipped: true, reason: '来自失效会话或旧版本，未恢复' };
        }
        const backup = this.readBackup();
        if (!backup.usable) return { ok: false, applied: false, reason: backup.reason ?? '副本不可用' };

        let restoreRaw = backup.raw;
        try {
          const purgedSet = new Set(this.knownPurgedIds);
          const purgedThreadSet = new Set(this.knownPurgedThreadIds);
          try {
            const currentPrimary = this.read();
            if (currentPrimary && currentPrimary.ok && currentPrimary.raw) {
              const curParsed = JSON.parse(currentPrimary.raw);
              if (Array.isArray(curParsed.purgedMessageIds)) {
                for (const id of curParsed.purgedMessageIds) purgedSet.add(id);
              }
              if (Array.isArray(curParsed.purgedThreadIds)) {
                for (const id of curParsed.purgedThreadIds) purgedThreadSet.add(id);
              }
            }
          } catch {}
          const bParsed = JSON.parse(backup.raw);
          if (Array.isArray(bParsed.purgedMessageIds)) {
            for (const id of bParsed.purgedMessageIds) purgedSet.add(id);
          }
          if (Array.isArray(bParsed.purgedThreadIds)) {
            for (const id of bParsed.purgedThreadIds) purgedThreadSet.add(id);
          }
          if (purgedSet.size > 0 || purgedThreadSet.size > 0) {
            const { data: bClean } = sanitizeAppDataWithPurgedIds(bParsed, purgedSet, purgedThreadSet);
            if (purgedSet.size > 0) {
              bClean.purgedMessageIds = Array.from(new Set([...(bClean.purgedMessageIds || []), ...purgedSet]));
            }
            if (purgedThreadSet.size > 0) {
              bClean.purgedThreadIds = Array.from(new Set([...(bClean.purgedThreadIds || []), ...purgedThreadSet]));
            }
            restoreRaw = JSON.stringify(bClean, null, 2);
          }
        } catch {}

        const result = await replaceFile(this.dir, restoreRaw);
        if (!result.ok) return { ok: false, applied: false, reason: result.reason };
        this.sessions.set(sid, { revision: rev, seq: entry.seq });
        return { ok: true, applied: true };
      })
      .catch((e) => {
        return { ok: false, applied: false, reason: `恢复失败，原文件未被改动：${e && e.message}` };
      });
    return this.chain;
  }

  /**
   * 原子修改数据（主进程各服务共享）
   * @param {(data: Object) => void} mutator 修改函数
   * @param {Object} [options] 写入选项
   */
  modify(mutator, options = {}) {
    if (!this.activeSession) {
      this.beginSession('default');
    }
    const sid = this.activeSession || 'default';
    // Read AND mutate inside the serialized save queue, not before it.
    return this.save(null, 0, sid, {...options, mutator});
  }

  /**
   * 写入新版本数据
   * @param {string} payload
   * @param {number} revision
   * @param {Object} [options]
   */
  write(payload, revision, options = {}) {
    if (!this.activeSession) {
      this.beginSession('default');
    }
    const sid = this.activeSession || 'default';
    return this.save(payload, revision, sid, options);
  }
}

module.exports = {
  DataStore,
  DATA_DIR_NAME,
  DATA_FILE,
  BACKUP_FILE,
  TEMP_FILE,
  looksLikeValidAppData,
  replaceFile,
};
