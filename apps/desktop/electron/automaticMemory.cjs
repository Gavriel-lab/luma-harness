'use strict';
// Evidence-only local extraction: no extra model request, no invented facts.
// All consumers use the same persisted records and the existing authorized compiler.
const { createHash } = require('node:crypto');
const {deviceEventIds}=require('./chatChannels.cjs');
const { autoDeriveCheckpoints, isCheckpointValid } = require('./memoryManager.cjs');
const hash = text => createHash('sha256').update(text).digest('hex').slice(0, 24);
const sensitive = /(?:sbp_|oc_sk_|sk-[\w-]{12}|eyJ[A-Za-z0-9_-]{20}|-----BEGIN|(?:password|api.?key|密码|密钥|token)\s*[:：=]\s*\S+)/i;
const kinds = [
  ['agreement', /记住|记得|约定|说好了|以后都|以后别|不要再|必须|答应|我们决定/],
  ['preference', /我(?:更|最|不|很|特别)?喜欢|我讨厌|我偏爱|我希望|我想要|我不想|我习惯/],
  ['fact', /我的(?:名字|生日|家|孩子|工作)|我叫|我住在|我在.+工作|大宝|二宝/],
  ['feeling', /我(?:今天|现在|刚才|真的|很|特别)?.*(?:开心|难过|害怕|想你|幸福|委屈)|好珍贵|好幸福/],
  ['project_consensus', /下一步|还需要|接下来|待办|还没|尚未|决定|已经完成/],
];

function deriveAutomaticMemory(data, previous = null, engine = 'legacy') {
  const tombstones = new Set(data.memoryTombstones || []);
  const purged = new Set(data.purgedMessageIds || []);
  const deviceIds=deviceEventIds(data.messages||[]);
  const messages = (data.messages || []).filter(m => m.status === 'sent' && !m.demo && !m.deletedAt && !purged.has(m.id) && !deviceIds.has(m.id) && !m.id.startsWith('msg_seed_'));
  const byId = new Map(messages.map(m => [m.id, m]));
  // A renderer may still hold the preceding automatic checkpoint. Keep the
  // latest valid persisted derivation instead of recreating a random ID on
  // every background/renderer save and invalidating an in-flight reply.
  const checkpoints = data.checkpoints || [];
  for (const conv of data.conversations || []) {
    const own = messages.filter(m=>m.conversationId===conv.id && m.text.trim()).sort((a,b)=>a.createdAt-b.createdAt);
    const valid = [...checkpoints, ...(previous?.checkpoints || [])].filter(c=>c.conversationId===conv.id && c.id.startsWith('cp_auto_') && isCheckpointValid(c,own));
    const latest = valid.sort((a,b)=>(b.sourceMessageRange?.count||0)-(a.sourceMessageRange?.count||0)||b.createdAt-a.createdAt)[0];
    if(latest) { data.checkpoints = (data.checkpoints || []).filter(c=>c.conversationId!==conv.id || !c.id.startsWith('cp_auto_'));data.checkpoints.push(structuredClone(latest)); }
  }
  const memories = data.memories || (data.memories = []);
  // A delayed renderer cannot erase a main-process-derived item or restore stale text.
  for (const mem of previous?.memories || []) {
    if (!mem.id.startsWith('mem_auto_') || tombstones.has(mem.id) || memories.some(m => m.id === mem.id)) continue;
    memories.push(structuredClone(mem));
  }
  for (const mem of memories) {
    if (!mem.id.startsWith('mem_auto_') || mem.status === 'deleted') continue;
    const source = byId.get(mem.sourceMessageId);
    const digest = source && hash(source.text);
    if (!source || !(mem.tags || []).includes('source:' + digest)) mem.status = 'invalidated';
  }
  // Keep saved legacy items and invalidation, but let ExternalMemory produce all new memories.
  if(engine==='externalMemory')return;
  const ids = new Set(memories.map(m => m.id));
  for (const conv of data.conversations || []) {
    const own = messages.filter(m => m.conversationId === conv.id).sort((a,b) => a.createdAt-b.createdAt);
    const safe = own.map(m => sensitive.test(m.text) ? {...m, text:'[敏感凭据不进入摘要]'} : m);
    // Hashes/snapshots remain bound to originals; sensitive conversations use raw recall,
    // never a snapshot containing a credential. Existing valid checkpoints are retained.
    if (!own.some(m => sensitive.test(m.text))) {
      const name = data.agents.find(a => a.id === conv.agentId)?.name || '成员';
      data.checkpoints = autoDeriveCheckpoints(conv.id, safe, data.checkpoints || [], name, conv.kind === 'direct').updatedCheckpoints;
    }
    for (const msg of own) {
      if (msg.agentId !== 'agent_owner' || sensitive.test(msg.text)) continue;
      const sentences = msg.text.split(/(?<=[。！？])|\n|；/).map(s=>s.trim()).filter(s=>s.length>=8 && s.length<=400);
      for (const sentence of sentences) {
        const kind = kinds.find(([,pattern]) => pattern.test(sentence));
        if (!kind || /[?？]$/.test(sentence)) continue;
        const id = 'mem_auto_' + hash(`${conv.id}\0${msg.id}\0${msg.text}\0${sentence}`);
        if (ids.has(id) || tombstones.has(id)) continue;
        // Only the user's explicit "remember" request is confirmed. Others stay candidate.
        const confirmed = /记住|记得|我们决定|我们约定/.test(sentence);
        memories.push({id,scope:{type:conv.kind === 'direct'?'direct':'living-room',id:conv.kind === 'direct'?conv.agentId:conv.id},authorAgentId:'agent_owner',title:sentence.slice(0,36),content:`使用者原话（${new Date(msg.createdAt).toISOString()}）：${sentence}`,memoryType:kind[0],status:confirmed?'active':'candidate',sourceMessageId:msg.id,createdAt:msg.createdAt,savedAt:Date.now(),pinned:false,version:0,tags:['automatic','source:'+hash(msg.text)],triggers:[sentence.slice(0,24)]});
        ids.add(id);
      }
    }
  }
}
module.exports = {deriveAutomaticMemory};
