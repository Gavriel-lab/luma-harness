'use strict';
// One main-process owner. HTTP can only claim registered, explicitly dispatched jobs.
// User data is read through DataStore; adapter reports never rewrite chat/persona data.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { assembleAuthoritativeTurn, filterAuthorizedData } = require('./memoryManager.cjs');
const { replyInstructions } = require('./chatReplies.cjs');
const id = prefix => `${prefix}_${crypto.randomUUID()}`;
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));
// Cloud ACK metadata does not alter the authorized content a model received.
// Text, ownership, deletion and invalidation fields remain part of the hash.
const contentAuthority = value => JSON.parse(JSON.stringify(value, (key, item) =>
  ['revision','version','syncVersion'].includes(key) ? undefined : item));
const ACTIVE = new Set(['queued','doing','offline','blocked','question','permission_required','cancelling']);
const EVENTS = new Set(['started','progress','question','permission_required','blocked','failed']);
const DISPATCH_EXECUTORS = new Set(['kiro', 'antigravity-adapter']);
function error(code, message, retryable = false) { return Object.assign(new Error(message), { code, retryable }); }
function inside(child, parent) { const rel = path.relative(parent, child); return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel)); }
function realDirectory(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw error('forbidden','必须指定绝对工作目录');
  const real = fs.realpathSync(value);
  if (!fs.statSync(real).isDirectory()) throw error('forbidden','工作目录不存在');
  return real;
}
function privateDirectory(dir) {
  fs.mkdirSync(dir, { recursive:true, mode:0o700 });
  if (process.platform === 'win32') {
    const sid = execFileSync('whoami', ['/user','/fo','csv','/nh'], { windowsHide:true, encoding:'utf8' }).match(/S-1-\d+(?:-\d+)+/)?.[0];
    if (!sid) throw error('executor_unavailable','无法保护本机会话凭据目录');
    execFileSync('icacls', [dir,'/inheritance:r','/grant:r',`*${sid}:(OI)(CI)F`], { windowsHide:true, stdio:'ignore' });
  } else fs.chmodSync(dir, 0o700);
}
function sanitizeSecretPaths(text) {
  if (typeof text !== 'string') return '';
  return text
    .replace(/[A-Za-z]:[\\/][^\s"'`<>|\r\n\t]+/g, '[受保护路径]')
    .replace(/\\\\(?:[^\s"'`<>|\r\n\t]+)/g, '[受保护路径]')
    .replace(/\/(?:Users|home|root|var|etc|opt|tmp|usr|private)[\\/][^\s"'`<>|\r\n\t]+/g, '[受保护路径]')
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [已脱敏]')
    .replace(/(?:token|key|secret)[=:]\s*['"]?[A-Za-z0-9_-]{16,}['"]?/gi, 'token=[已脱敏]');
}
class BridgeBroker {
  constructor({ dir, getData, mutateTickets = null, notify = () => {}, onContext = () => {}, launchExecutor = null, now = Date.now }) {
    this.dir = dir; this.getData = getData; this.notify = notify; this.now = now;
    this.onContext = onContext;
    this.launchExecutor = launchExecutor;
    // The renderer/DataStore owner applies these bounded commands and ACKs only
    // after its normal serialized save. Never write a second AppData here.
    this.mutateTickets = mutateTickets; this.pendingTicketMutations = new Set();
    this.file = path.join(dir,'bridge.v1.json'); this.sessions = new Map(); this.chatWaiters = new Map();
    fs.mkdirSync(dir,{recursive:true});
    this.data = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file,'utf8')) : {schemaVersion:1,homeId:id('home'),generation:0,registrations:{},jobs:[],feed:[]};
    if (this.data.schemaVersion !== 1 || !Array.isArray(this.data.jobs) || !this.data.registrations) throw error('unsupported_schema','调度记录损坏，保留现场并停止');
    this.data.pendingDispatches = Array.isArray(this.data.pendingDispatches) ? this.data.pendingDispatches : [];
    this.data.reportedTicketOrigins = Array.isArray(this.data.reportedTicketOrigins) ? this.data.reportedTicketOrigins : [];
    this.data.dispatchChannelEnabled = this.data.dispatchChannelEnabled !== false;
    this.dispatchHistory = new Map();
    this.data.generation++;
    for(const job of this.data.jobs)if(job.kind==='chat'&&ACTIVE.has(job.state)){
      // A closed renderer cannot own this old reply. Retire its delivery lock,
      // without claiming the old client was stopped or starting it again.
      job.state='interrupted';job.cancelRequested=true;
    }
    for (const job of this.data.jobs) if (ACTIVE.has(job.state) && job.attemptId) job.state = job.cancelRequested ? 'cancelling' : 'offline';
    this.persist();
  }
  setDispatchChannelEnabled(enabled) {
    this.data.dispatchChannelEnabled = enabled === true;
    this.change();
    return { ok: true, dispatchChannelEnabled: this.data.dispatchChannelEnabled };
  }
  persist() { const tmp = this.file + '.tmp'; fs.writeFileSync(tmp,JSON.stringify(this.data,null,2)); fs.renameSync(tmp,this.file); }
  change() { this.persist(); this.notify(this.snapshot()); }
  authoritative() { const d = this.getData(); if (!d) throw error('executor_unavailable','小屋权威数据未就绪'); return d; }
  member(agentId) { const a = this.authoritative().agents.find(a=>a.id===agentId && a.kind==='ai' && !a.removed); if (!a) throw error('forbidden','成员未注册或已移除'); return a; }
  async start() {
    this.server = http.createServer((req,res)=>this.handle(req,res));
    await new Promise((resolve,reject)=>{this.server.once('error',reject);this.server.listen(0,'127.0.0.1',resolve);});
    this.url = `http://127.0.0.1:${this.server.address().port}`;
    this.timer = setInterval(()=>this.expire(),1000); this.timer.unref();
    // Rotate ephemeral credentials on restart; old tokens and old instance manifests fail.
    for (const reg of Object.values(this.data.registrations)) this.issue(reg);
    this.issueCoordinator();
    return this.snapshot();
  }
  async stop() { clearInterval(this.timer); for (const waiter of this.chatWaiters.values()) waiter.reject(error('executor_unavailable','小屋已关闭')); this.chatWaiters.clear(); this.sessions.clear();
    // Called after managed executors stop. Explicitly close our HTTP sockets so
    // a client's keep-alive pool cannot keep a windowless Electron alive.
    if(this.server)await new Promise(r=>{this.server.close(r);this.server.closeAllConnections?.();});
  }
  issue(reg) {
    const token = crypto.randomBytes(32).toString('hex');
    const sessionDir = path.join(this.dir,'sessions',hash(reg.agentId).slice(0,24));
    privateDirectory(sessionDir);
    const tokenFile = path.join(sessionDir,'session.token');
    fs.writeFileSync(tokenFile, token,{mode:0o600});
    const manifestPath = path.join(sessionDir,'manifest.v1.json');
    const manifest = {schemaVersion:1,bridgeUrl:this.url,brokerUrl:this.url,generation:this.data.generation,instanceGeneration:this.data.generation,homeId:this.data.homeId,agentId:reg.agentId,executorId:reg.executorId,executor:reg.executorId === 'kiro' ? 'kiro-cli':reg.executorId === 'zcode' ? 'zcode-app-server':reg.executorId === 'opencode' ? 'opencode':'antigravity',...(reg.executorId==='kiro'?{model:reg.model||process.env.LUMA_KIRO_MODEL||undefined}:{}),workspace:reg.workspace,tokenFile,issuedAt:new Date(this.now()).toISOString()};
    fs.writeFileSync(manifestPath,JSON.stringify(manifest,null,2));
    this.sessions.set(reg.agentId,{ token, manifestPath, lastSeen:null });
    return manifestPath;
  }
  issueCoordinator() {
    if(this.sessions.has('coordinator'))return this.sessions.get('coordinator').manifestPath;
    // Coordinator is an explicit protocol role, independent of display names and worker count.
    // never infer this capability from a display name or adapter-supplied ID.
    if(!this.getData()?.agents?.some(a=>a.id==='agent_coordinator'&&a.kind==='ai'&&!a.removed))return;
    const dir=path.join(this.dir,'sessions','coordinator');privateDirectory(dir);
    const token=crypto.randomBytes(32).toString('hex'),tokenFile=path.join(dir,'session.token'),manifestPath=path.join(dir,'manifest.v1.json');
    fs.writeFileSync(tokenFile,token,{mode:0o600});
    fs.writeFileSync(manifestPath,JSON.stringify({schemaVersion:1,brokerUrl:this.url,homeId:this.data.homeId,generation:this.data.generation,agentId:'agent_coordinator',executorId:'xiaowu-coordinator',tokenFile},null,2));
    this.sessions.set('coordinator',{token,manifestPath,coordinator:true,lastSeen:null});
    return manifestPath;
  }
  coordinationSnapshot() {
    const d=this.authoritative();
    return {
      homeId:this.data.homeId,
      tickets:d.tickets.map(t=>({id:t.id,title:t.title,goal:t.goal,participantIds:t.participantIds,tasks:t.tasks,discussion:t.discussion.text,origin:t.origin,originReported:t.originReported})),
      jobs:this.snapshot().jobs.filter(j=>j.kind==='work'),
      feed:this.data.feed,
      pendingDispatches:this.data.pendingDispatches||[],
      dispatchChannelEnabled:this.data.dispatchChannelEnabled!==false
    };
  }
  register({agentId,executorId,workspace}) {
    this.member(agentId);
    if (!['zcode','antigravity-adapter','opencode','kiro'].includes(executorId)) throw error('executor_unavailable','未支持的客户端');
    if (this.data.jobs.some(j=>j.agentId===agentId && ACTIVE.has(j.state))) throw error('permission_required','先停止并确认当前执行，再更换登记');
    const reg = {agentId,executorId,workspace:realDirectory(workspace),chatEnabled:false};
    this.data.registrations[agentId] = reg;
    const manifestPath = this.issue(reg); this.change(); return {ok:true,manifestPath};
  }
  enableChat(agentId,enabled) { this.member(agentId); const reg = this.data.registrations[agentId]; if (!reg) throw error('executor_unavailable','先登记客户端'); reg.chatEnabled = enabled === true; this.change(); return {ok:true}; }
  coordinatorDecision(body) {
    if(body.explicit!==true)throw error('permission_required','统筹写入需要明确决定');
    if(typeof body.requestId!=='string'||!body.requestId.trim()||body.requestId.length>160)throw error('forbidden','缺少合法 requestId');
  }
  async applyTicketMutation(command,verify) {
    if(!this.mutateTickets)throw error('executor_unavailable','当前实例尚未接入权威工单写入通道');
    const result=await this.mutateTickets(clone(command));
    if(!result?.ok||result.applied!==true)throw error('executor_unavailable',result?.reason||'工单未持久保存，不能报告成功');
    if(!verify(this.authoritative()))throw error('executor_unavailable','权威工单保存未得到验证');
  }
  async createTicket(body) {
    this.coordinatorDecision(body);
    const allowed=new Set(['schemaVersion','explicit','requestId','ticketId','title','goal','tasks','origin']);
    if(Object.keys(body).some(k=>!allowed.has(k)))throw error('forbidden','新建工单不能修改其他授权数据');
    if(typeof body.ticketId!=='string'||!/^ticket_[A-Za-z0-9_-]{1,150}$/.test(body.ticketId))throw error('forbidden','工单 ID 无效');
    const text=(value,max)=>typeof value==='string'&&value.trim()&&value.length<=max;
    if(!text(body.title,240)||!text(body.goal,5000)||!Array.isArray(body.tasks)||!body.tasks.length||body.tasks.length>12)throw error('forbidden','工单标题、目标或任务无效');
    let originData = null;
    if (body.origin !== undefined) {
      if (!body.origin || typeof body.origin !== 'object' || Array.isArray(body.origin)) throw error('forbidden', '工单来源格式无效');
      const reqId = typeof body.origin.requestId === 'string' && body.origin.requestId.trim() ? body.origin.requestId.trim() : null;
      const pending = reqId ? this.data.pendingDispatches?.find(p => p.requestId === reqId) : null;
      if (pending) {
        originData = { conversationId: pending.fromConversationId, agentId: pending.fromAgentId, requestId: pending.requestId };
      } else if (typeof body.origin.conversationId === 'string' && body.origin.conversationId.trim()) {
        const convId = body.origin.conversationId.trim();
        const conv = this.authoritative().conversations?.find(c => c.id === convId);
        if (!conv) throw error('forbidden', '工单来源会话不存在');
        const targetAgentId = typeof body.origin.agentId === 'string' && body.origin.agentId.trim() ? body.origin.agentId.trim() : (conv.agentId || 'agent_coordinator');
        const finalReqId = reqId || ('req_direct_' + crypto.randomUUID().slice(0, 8));
        originData = { conversationId: conv.id, agentId: targetAgentId, requestId: finalReqId };
      } else {
        throw error('forbidden', '未找到匹配的待开单请求或会话');
      }
    }
    const tasks=body.tasks.map(t=>{
      if(!t||typeof t!=='object'||Array.isArray(t)||Object.keys(t).some(k=>!['id','title','assigneeId','acceptance','execution'].includes(k))||typeof t.id!=='string'||!/^task_[A-Za-z0-9_-]{1,150}$/.test(t.id)||!text(t.title,240)||!text(t.acceptance,3000))throw error('forbidden','任务 ID、标题或验收要求无效');
      this.member(t.assigneeId);
      if(!this.data.registrations[t.assigneeId])throw error('executor_unavailable','负责人尚未登记客户端');
      return {id:t.id,title:t.title.trim(),assigneeId:t.assigneeId,status:'todo',acceptance:t.acceptance.trim(),...(t.execution===undefined?{}:{execution:this.executionOptions(t)})};
    });
    if(new Set(tasks.map(t=>t.id)).size!==tasks.length)throw error('forbidden','任务 ID 重复');
    const payloadHash=hash({ticketId:body.ticketId,title:body.title.trim(),goal:body.goal.trim(),tasks,...(originData?{origin:originData}:{})});
    const current=this.authoritative();
    const old=current.tickets.find(t=>t.id===body.ticketId);
    if(old){if(old.coordinatorCreation?.requestId===body.requestId&&old.coordinatorCreation?.payloadHash===payloadHash)return {ok:true,duplicate:true,ticketId:old.id,taskIds:old.tasks.map(t=>t.id)};throw error('forbidden','工单已存在，不允许覆盖');}
    if(current.tickets.some(t=>t.coordinatorCreation?.requestId===body.requestId||t.tasks.some(x=>tasks.some(y=>y.id===x.id))))throw error('forbidden','请求或任务 ID 已被使用');
    if(this.pendingTicketMutations.size)throw error('permission_required','另一项工单写入正在保存，请稍后重试');
    const at=this.now();
    const ticket={id:body.ticketId,title:body.title.trim(),goal:body.goal.trim(),participantIds:[...new Set(['agent_coordinator',...tasks.map(t=>t.assigneeId)])],tasks,discussion:{text:'',updatedAt:at},artifacts:{text:'',updatedAt:at},updatedAt:at,coordinatorCreation:{requestId:body.requestId,payloadHash},...(originData?{origin:originData}:{})};
    this.pendingTicketMutations.add(body.ticketId);
    try {await this.applyTicketMutation({operation:'create-ticket',requestId:body.requestId,ticket},d=>d.tickets.some(t=>t.id===ticket.id&&t.coordinatorCreation?.payloadHash===payloadHash&&hash(t.tasks)===hash(tasks)));}
    finally {this.pendingTicketMutations.delete(body.ticketId);}
    this.change();return {ok:true,ticketId:ticket.id,taskIds:tasks.map(t=>t.id)};
  }
  async publishMessage(body) {
    if (!body.requestId?.trim() || !['voice', 'text'].includes(body.medium) || typeof body.text !== 'string' || !body.text.trim()) throw error('forbidden', '需要消息文字、发送形式和 requestId');
    const agentId = body.agentId || 'agent_coordinator';
    this.member(agentId);
    const data = this.authoritative();
    let conv;
    if (body.conversationId) {
      conv = data.conversations.find(c => c.id === body.conversationId);
      if (!conv) throw error('executor_unavailable', '目标会话尚未建立');
      if (conv.kind !== 'living-room' && !(conv.kind === 'direct' && conv.agentId === agentId)) {
        throw error('forbidden', '成员不得向其他会话发送消息');
      }
    } else {
      conv = data.conversations.find(c => c.kind === 'direct' && c.agentId === agentId);
      if (!conv) throw error('executor_unavailable', `${agentId} 私聊尚未建立`);
    }
    const id = 'msg_office_' + crypto.createHash('sha256').update(body.requestId).digest('hex').slice(0, 32);
    const words = require('./chatReplies.cjs').replyText(body.text).trim();
    if (!words) throw error('forbidden', '消息内容不能为空');
    const text = (body.medium === 'voice' ? '[语音]\n' : '') + words;
    const matches = m => m.id === id && m.agentId === agentId && m.conversationId === conv.id && m.text === text && m.status === 'sent' && m.sourceChannel === 'luma';
    if (data.purgedMessageIds?.includes(id)) throw error('forbidden', '消息已经删除，不重新添加');
    const prior = data.messages.find(m => m.id === id);
    if (prior && !matches(prior)) throw error('forbidden', '同一 requestId 已用于其他内容');
    if (!prior) {
      const message = { id, conversationId: conv.id, agentId, text, createdAt: this.now(), status: 'sent', demo: false, requestId: body.requestId, sourceChannel: 'luma' };
      await this.applyTicketMutation({ type: 'companion-message', message }, d => d.messages.some(matches));
      if (conv.kind === 'living-room') {
        void this.onLivingRoomMessage?.(message);
      }
    }
    return { ok: true, saved: true, messageId: id, conversationId: conv.id, medium: body.medium, duplicate: Boolean(prior) };
  }
  async rejectReview(body) {
    this.coordinatorDecision(body);
    if(Object.keys(body).some(k=>!['schemaVersion','explicit','requestId','jobId','attemptId','reportId','reason'].includes(k))||typeof body.reason!=='string'||!body.reason.trim()||body.reason.length>5000)throw error('forbidden','退回必须提供具体审查意见，不能改派或更改成员授权');
    const job=this.data.jobs.find(j=>j.jobId===body.jobId&&j.kind==='work');
    if(this.data.jobs.some(j=>j.jobId!==body.jobId&&j.reviewDecision?.requestId===body.requestId))throw error('forbidden','退回请求编号已用于另一个任务');
    if(job?.state==='rejected'&&job.reviewDecision?.requestId===body.requestId){if(job.reviewDecision.reason!==body.reason.trim()||job.attemptId!==body.attemptId||job.report?.reportId!==body.reportId)throw error('forbidden','退回请求编号重复');return {ok:true,duplicate:true,state:'rejected',jobId:job.jobId};}
    if(!job||job.state!=='review')throw error('permission_required','只有待审成果可以退回，执行中的任务不得退回');
    if(job.attemptId!==body.attemptId||job.report?.reportId!==body.reportId)throw error('stale_attempt','待审轮次或交付报告不匹配');
    const ticket=this.authoritative().tickets.find(t=>t.id===job.ticketId),task=ticket?.tasks.find(t=>t.id===job.taskId);
    if(!task||task.assigneeId!==job.agentId||task.status==='done')throw error('stale_attempt','工单已删除、改派或已完成');
    if(this.pendingTicketMutations.size||this.data.jobs.some(j=>j.jobId!==job.jobId&&j.ticketId===job.ticketId&&j.taskId===job.taskId&&(ACTIVE.has(j.state)||j.state==='review')))throw error('permission_required','任务写入或执行状态冲突');
    const decision={requestId:body.requestId,reason:body.reason.trim(),attemptId:job.attemptId,reportId:job.report.reportId,at:this.now()};
    this.pendingTicketMutations.add(job.ticketId);
    try {await this.applyTicketMutation({operation:'reject-review',requestId:body.requestId,ticketId:job.ticketId,taskId:job.taskId,assigneeId:job.agentId,jobId:job.jobId,decision},d=>{const t=d.tickets.find(t=>t.id===job.ticketId);return t?.tasks.some(x=>x.id===job.taskId&&x.assigneeId===job.agentId&&x.status==='todo')&&t.reviewDecisions?.some(x=>x.jobId===job.jobId&&x.requestId===body.requestId&&x.reportId===body.reportId);});
      job.state='rejected';job.reviewDecision=decision;this.addFeed(job,'rejected');this.change();return {ok:true,state:'rejected',jobId:job.jobId};
    } finally {this.pendingTicketMutations.delete(job.ticketId);}
  }
  dispatch({ticketId,taskId,requestId}) {
    if(typeof requestId!=='string'||!requestId||requestId.length>160||typeof ticketId!=='string'||typeof taskId!=='string')throw error('forbidden','派发参数无效');
    const d = this.authoritative(); const ticket = d.tickets.find(t=>t.id===ticketId); const task = ticket?.tasks.find(t=>t.id===taskId);
    if(this.pendingTicketMutations.has(ticketId))throw error('permission_required','权威工单写入尚未保存');
    if (!task || !task.assigneeId) throw error('permission_required','任务尚未指定负责人');
    this.member(task.assigneeId);
    const reg = this.data.registrations[task.assigneeId]; if (!reg) throw error('executor_unavailable','负责人尚未登记客户端');
    const previous = this.data.jobs.find(j=>j.requestId===requestId);
    if (previous) { if(previous.ticketId!==ticketId || previous.taskId!==taskId) throw error('forbidden','派发请求编号重复'); return {ok:true,jobId:previous.jobId}; }
    if (this.data.jobs.some(j=>j.ticketId===ticketId && j.taskId===taskId && (ACTIVE.has(j.state)||j.state==='review'))) throw error('permission_required','任务已派发或待验收，不能重复执行');
    if (task.status === 'done') throw error('permission_required','已完成任务不能自动重跑');
    const job = {jobId:id('job'),ticketId,taskId,agentId:reg.agentId,executorId:reg.executorId,workspace:reg.workspace,goal: `${ticket.goal}\n任务：${task.title}`.trim(),scope:'只执行当前工单，文件操作仅限批准工作目录；不自行发布或读取秘密',acceptance:task.acceptance || '提交实际产物、检查结果及未验证项，等待协调者验收',state:'queued',kind:'work',requestId,createdAt:this.now(),attemptId:null,seq:0,events:[],checkpoint:null,report:null};
    // Validate identity/context before enqueueing; no fallback persona or fabricated relationship.
    this.contextPacket({...job,attemptId:'preflight'});
    this.data.jobs.push(job); this.addFeed(job,'dispatch'); this.change(); return {ok:true,jobId:job.jobId};
  }
  chat(params) {
    const reg = this.data.registrations[params.targetAgentId];
    if (!reg?.chatEnabled) throw error('executor_unavailable','客户端聊天线路尚未启用');
    if (this.data.jobs.some(j=>j.requestId===params.requestId)) throw error('forbidden','聊天请求已存在');
    const conv = this.authoritative().conversations.find(c=>c.id===params.conversationId);
    const job = {jobId:id('chat'),ticketId:params.conversationId,taskId:params.requestId,agentId:reg.agentId,executorId:reg.executorId,workspace:reg.workspace,goal:params.currentText,scope:'普通聊天，只回答本轮消息；不得执行文件修改或领取其他工作',acceptance:'返回本轮答复，保留原会话归属',kind:'chat',conversationId:conv.id,requestId:params.requestId,excludeMessageIds:params.excludeMessageIds,cutoffTime:params.cutoffTime,attachments:params.authorizedAttachments||[],state:'queued',createdAt:this.now(),attemptId:null,seq:0,events:[],checkpoint:null,report:null,isUserInitiated:params.isUserInitiated!==false&&!params.originReport,originReport:params.originReport===true};
    job.semanticMemoryIds=params.semanticMemoryIds||[];
    job.semanticMessageIds=params.semanticMessageIds||[];
    job.externalMemoryContext=params.externalMemoryContext;
    const packet = this.contextPacket({...job,attemptId:'preflight'});
    this.data.jobs.push(job); this.change();
    const promise = new Promise((resolve,reject)=>this.chatWaiters.set(job.jobId,{resolve,reject}));
    return {jobId:job.jobId,packet,promise};
  }
  cancel(jobId) {
    const job = this.data.jobs.find(j=>j.jobId===jobId); if(!job)throw error('forbidden','任务不存在');
    if (!ACTIVE.has(job.state)) throw error('stale_attempt','任务已结束');
    job.cancelRequested = true; job.state = job.attemptId ? 'cancelling':'cancelled';
    if (!job.attemptId) this.finishChat(job,{outcome:'cancelled',summary:'已取消'});
    this.addFeed(job,'cancel'); this.change(); return {ok:true};
  }
  resume(jobId,confirmed) {
    const job=this.data.jobs.find(j=>j.jobId===jobId&&j.kind==='work');
    if(!job||!['offline','cancelled','failed'].includes(job.state)||confirmed!==true)throw error('permission_required','先确认旧客户端已停止，再按检查点续接');
    const ticket=this.authoritative().tickets.find(t=>t.id===job.ticketId),task=ticket?.tasks.find(t=>t.id===job.taskId);
    if(!task||task.assigneeId!==job.agentId)throw error('stale_attempt','任务已删除或改派');
    job.previousAttempts||=[];job.previousAttempts.push({attemptId:job.attemptId,report:job.report,events:job.events});
    // Keep work continuity only, never carry a cached execution session/persona.
    const continuity=job.checkpoint?.continuity||job.checkpoint;
    job.checkpoint=continuity?{continuity:{completed:continuity.completed||[],remaining:continuity.remaining||[],blockers:continuity.blockers||[],nextAction:continuity.nextAction||'按当前权威工单续接'}}:null;
    job.goal=`${ticket.goal}\n任务：${task.title}`.trim();job.state='queued';job.attemptId=null;job.report=null;job.seq=0;job.events=[];job.cancelRequested=false;job.leasedFingerprint=null;job.sourceIds=null;job.contextFingerprint=null;
    this.addFeed(job,'resume');this.change();return {ok:true};
  }
  accept(jobId) { const job = this.data.jobs.find(j=>j.jobId===jobId); if(!job || job.state!=='review')throw error('permission_required','只有待审成果可以验收');
    if(this.pendingTicketMutations.has(job.ticketId))throw error('permission_required','审查写入正在保存，不能同时验收');
    const task=this.authoritative().tickets.find(t=>t.id===job.ticketId)?.tasks.find(t=>t.id===job.taskId);
    if(!task||task.assigneeId!==job.agentId)throw error('stale_attempt','工单已删除或改派，不得给新负责人记为完成');
    job.state='done';this.addFeed(job,'accepted');this.change();
    void this.checkOriginReport(job.ticketId);
    return {ok:true}; }
  receipt(job,packet,status='injected') {
    const sources=packet.memory.sourceReceipts;
    return {requestId:job.requestId,conversationId:job.conversationId||this.authoritative().conversations.find(c=>c.kind==='living-room')?.id,targetAgentId:job.agentId,preparedSources:sources.map(s=>({...s,injected:status==='injected'})),injectedSources:status==='injected'?sources:[],status,totalBudgetChars:16000,usedChars:JSON.stringify(packet).length,timestamp:this.now()};
  }
  addFeed(job,type) { if(job.kind==='chat')return; this.data.feed.push({id:id('bridge_msg'),type,jobId:job.jobId,ticketId:job.ticketId,taskId:job.taskId,agentId:job.agentId,createdAt:this.now()}); }
  expire() { let changed=false; for(const job of this.data.jobs) if(ACTIVE.has(job.state) && job.attemptId && job.leaseUntil < this.now() && !['offline','cancelling'].includes(job.state)){job.state='offline';changed=true;} if(changed)this.change(); }
  auth(req) {
    const token = String(req.headers.authorization||'').replace(/^Bearer /,'');
    const entry = /^[a-f0-9]{64}$/.test(token) ? [...this.sessions.entries()].find(([,s])=>crypto.timingSafeEqual(Buffer.from(token),Buffer.from(s.token))) : null;
    if(!entry)throw error('unauthenticated','会话凭据无效');
    const [key,session] = entry,agentId=session.coordinator?'agent_coordinator':key;this.member(agentId);
    const reg=session.coordinator?{agentId,executorId:'xiaowu-coordinator',coordinator:true}:this.data.registrations[agentId];
    if(req.headers['x-agent-id'] && req.headers['x-agent-id']!==agentId)throw error('forbidden','成员绑定不一致');
    if(req.headers['x-executor-id'] && req.headers['x-executor-id']!==reg.executorId)throw error('forbidden','执行器绑定不一致');
    session.lastSeen=this.now(); return reg;
  }
  owned(reg,body,allowCancelled=false) {
    const job = this.data.jobs.find(j=>j.jobId===body.jobId);
    if(!job || job.agentId!==reg.agentId || job.executorId!==reg.executorId) throw error('forbidden','任务不属于此执行器');
    if(job.attemptId!==body.attemptId || (!allowCancelled && job.cancelRequested))throw error('stale_attempt','执行轮次已失效或取消');
    if(job.kind==='work') { const ticket=this.authoritative().tickets.find(t=>t.id===job.ticketId); const task=ticket?.tasks.find(t=>t.id===job.taskId); if(!task || task.assigneeId!==reg.agentId) {
      if(!job.report){job.cancelRequested=true;job.state='cancelling';this.change();}
      if(!allowCancelled)throw error('stale_attempt','任务已删除或改派');
    } }
    if(realDirectory(reg.workspace)!==job.workspace)throw error('forbidden','批准工作目录已变化');
    return job;
  }
  executionOptions(task) {
    const value = task?.execution;
    if (value === undefined) return {};
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw error('permission_required','执行配置无效');
    const out = {};
    for (const key of ['pureAnalysis','resubmitOnly']) if (value[key] !== undefined) {
      if (typeof value[key] !== 'boolean') throw error('permission_required','执行模式必须是布尔值');
      out[key] = value[key];
    }
    if (value.timeoutMs !== undefined) {
      if (!Number.isInteger(value.timeoutMs) || value.timeoutMs < 1000 || value.timeoutMs > 600000) throw error('permission_required','执行预算必须在一秒至十分钟以内');
      out.timeoutMs = value.timeoutMs;
    }
    if (value.requiredArtifacts !== undefined) {
      if (!Array.isArray(value.requiredArtifacts) || !value.requiredArtifacts.length || value.requiredArtifacts.length > 8 || value.requiredArtifacts.some(x => typeof x !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]*\.(?:md|txt|json|js|ts|html|css|py)$/.test(x))) throw error('permission_required','产物必须是批准目录内的明确文件名');
      out.requiredArtifacts = [...new Set(value.requiredArtifacts)];
    }
    if (value.canary !== undefined) {
      if (typeof value.canary !== 'string' || !/^[A-Za-z0-9_-]{1,120}$/.test(value.canary)) throw error('permission_required','产物标识码无效');
      out.canary = value.canary;
    }
    if (value.approvedTools !== undefined) {
      if (!Array.isArray(value.approvedTools) || value.approvedTools.some(x => !['file_read','file_write'].includes(x))) throw error('permission_required','此轮只支持明确批准的文件能力，不能扩展终端权限');
      out.approvedTools = [...new Set(value.approvedTools)];
    }
    if (out.pureAnalysis && (!out.requiredArtifacts || out.requiredArtifacts.length !== 1 || !out.canary || out.approvedTools?.length)) throw error('permission_required','纯分析需要一个明确产物与标识码，且不批准工具执行');
    if (out.pureAnalysis || out.resubmitOnly) out.requireTaskBinding = true;
    return out;
  }
  contextPacket(job) {
    const d = this.authoritative(); const agent=this.member(job.agentId); const profile=d.chatProfiles?.find(p=>p.id===agent.profileId);
    const originalPersona=agent.systemPrompt?.trim() || profile?.developerInstructions?.trim();
    const conversationId=job.conversationId || d.conversations.find(c=>c.kind==='living-room')?.id;
    const conv=d.conversations?.find(c=>c.id===conversationId);
    const isLivingRoom=conv && conv.kind==='living-room';
    const sceneGuide = isLivingRoom
      ? `【当前场景：小屋客厅多人公共大厅】全家成员（使用者、协调者、编辑助手、Researcher、执行助手、审核助手）均在现场。使用者此话是在大厅公开说的，所有在场人都能看到。若使用者提到找协调者、研究助手、执行助手等其他人，大家都在现场，请直接当面接话或 @对方 现场讨论，严禁使用“去客厅”、“去客厅找某某”等私聊跨房间话术！`
      : `【当前场景：与使用者的一对一私聊】`;
    const persona=originalPersona && (job.kind==='chat' ? `${originalPersona}\n\n${sceneGuide}\n\n${replyInstructions}` : originalPersona);
    if(!persona)throw error('permission_required','缺少本成员授权人格，请先在成员设置补齐');
    const ticket=job.kind==='work'?d.tickets.find(t=>t.id===job.ticketId):null;
    const execution=job.kind==='work'?this.executionOptions(ticket?.tasks.find(t=>t.id===job.taskId)):{};
    // Work continuity is trusted broker data. Invalidated memory never resurrects via checkpoint text.
    const cp=job.checkpoint?.continuity || job.checkpoint || {};
    const list=value=>Array.isArray(value)?value.filter(x=>typeof x==='string'):typeof value==='string'?[value]:[];
    const continuity={currentCheckpoint:null,completed:list(cp.completed),remaining:cp.remaining?list(cp.remaining):[job.goal],blockers:list(cp.blockers),nextAction:typeof cp.nextAction==='string'?cp.nextAction:'处理当前任务',otherOpenTasks:d.tickets.filter(t=>t.id!==job.ticketId).flatMap(t=>t.tasks.filter(x=>x.assigneeId===job.agentId && x.status!=='done').map(x=>`${t.title} / ${x.title}：${x.status}`))};
    const identity={displayName:agent.name,personaVersion:hash(persona),authorizedPersona:persona,authorizedRelationships:Array.isArray(agent.authorizedRelationships)&&agent.authorizedRelationships.length ? agent.authorizedRelationships : ['关系描述沿用上述用户为本成员维护的授权人格；未提及的关系不得编造。']};
    const core={schemaVersion:1,homeId:this.data.homeId,agentId:job.agentId,executorId:job.executorId,identity,job:{jobId:job.jobId,ticketId:job.ticketId,taskId:job.taskId,attemptId:job.attemptId,workspace:job.workspace,goal:job.goal,scope:job.scope,acceptance:job.acceptance,state:job.state,kind:job.kind,attachments:job.attachments||[]},continuity,discussion:{linkedMessageIds:[],latestDecisions:ticket?.discussion.text?[ticket.discussion.text]:[],relevantMessages:[]}};
    Object.assign(core.job,execution);
    let fixed=JSON.stringify(core).length;
    if(fixed>12000 && job.kind==='chat'){
      // 自动上下文压缩与减负：针对聊天与自主活动，若长文逼近上限，自动压缩冗余前序，绝不致死报错
      if(typeof core.job.goal==='string' && core.job.goal.length > 2500){
        const targetGoalLen = Math.max(2000, core.job.goal.length - (fixed - 11000));
        const head = Math.floor(targetGoalLen * 0.45);
        const tail = Math.floor(targetGoalLen * 0.55);
        core.job.goal = core.job.goal.slice(0, head) + '\n\n...[前序长文已自动压缩存入记忆库，保持轻量窗口]...\n\n' + core.job.goal.slice(-tail);
        job.goal = core.job.goal;
        fixed = JSON.stringify(core).length;
      }
      if(fixed>12200 && core.continuity){
        core.continuity.otherOpenTasks = [];
        core.continuity.completed = (core.continuity.completed || []).slice(-1);
        fixed = JSON.stringify(core).length;
      }
      if(fixed>12200 && Array.isArray(core.identity?.authorizedRelationships) && core.identity.authorizedRelationships.length > 1){
        core.identity.authorizedRelationships = core.identity.authorizedRelationships.slice(0, 1);
        fixed = JSON.stringify(core).length;
      }
    }
    if(fixed>12500 && job.kind!=='chat'){
      throw error('permission_required','人格与工作检查点超过单轮预算，请精简后再派发');
    }
    const assembled=assembleAuthoritativeTurn(d,{requestId:job.requestId,conversationId,targetAgentId:job.agentId,currentText:job.goal,cutoffTime:job.cutoffTime,excludeMessageIds:job.excludeMessageIds,semanticMemoryIds:job.semanticMemoryIds,semanticMessageIds:job.semanticMessageIds,externalMemoryContext:job.externalMemoryContext});
    if(!assembled.ok)throw error('permission_required',assembled.reason);
    core.memory={authorizedRelevantItems:[],sourceReceipts:[]};
    // Reuse the memory manager's authorized, selected per-source parts. Fit the
    // actual packet including receipts; never claim dropped text was injected.
    for(const part of assembled.authorizedParts || []) {
      if(!part.source)continue;
      const item={id:part.source.id,version:part.source.editedAt||part.source.timestamp||1,summary:part.text};
      const source={...part.source,injected:true,injectedChars:part.text.length,payloadHash:crypto.createHash('sha256').update(part.text).digest('hex')};
      core.memory.authorizedRelevantItems.push(item);core.memory.sourceReceipts.push(source);
      if(JSON.stringify(core).length>12380){core.memory.authorizedRelevantItems.pop();core.memory.sourceReceipts.pop();}
    }
    // Hash latest authority, not last cached packet. Caller polling can observe invalidation.
    const authorized=filterAuthorizedData(d,job.agentId);
    if(!job.sourceIds)job.sourceIds=[...authorized.authorizedDirectMessages,...authorized.authorizedLivingRoomMessages].filter(m=>!m.id.startsWith('bridge_msg_')).map(m=>m.id);
    const sources=job.sourceIds.map(sourceId=>d.messages.find(m=>m.id===sourceId)||{id:sourceId,forgotten:true});
    const ticketAuthority=ticket?{id:ticket.id,goal:ticket.goal,participantIds:ticket.participantIds,discussion:ticket.discussion.text,task:ticket.tasks.filter(t=>t.id===job.taskId).map(t=>({id:t.id,title:t.title,assigneeId:t.assigneeId}))}:null;
    const fingerprint=hash({persona,relationships:identity.authorizedRelationships,removed:agent.removed,profile,sources:contentAuthority(sources),memories:contentAuthority(authorized.authorizedMemories),checkpoints:contentAuthority(authorized.authorizedCheckpoints),purged:d.purgedMessageIds,tombstones:d.memoryTombstones,ticket:ticketAuthority,execution});
    if(job.contextFingerprint!==fingerprint){job.contextVersion=(job.contextVersion||0)+1;job.contextFingerprint=fingerprint;}
    return {...core,packetId:`packet_${hash(core).slice(0,24)}`,contextVersion:job.contextVersion};
  }
  currentPacket(job) {
    const packet=this.contextPacket(job);
    if(job.leasedFingerprint && job.leasedFingerprint!==job.contextFingerprint){
      job.cancelRequested=true;job.state='cancelling';job.invalidated=true;this.change();
      throw error('stale_attempt','授权上下文已失效，停止旧回合；重新派发时使用最新资料');
    }
    return packet;
  }
  processDispatchSignal(rawText, { conversationId, agentId, requestId, isUserInitiated = true } = {}) {
    const text = String(rawText || '');
    const dispatchMatch = text.match(/\[\[去客厅:\s*([^\]\r\n]+?)\s*\]\]/u);
    const relayMatch = text.match(/\[\[客厅传话:\s*([^\]\r\n]+?)\s*\]\]/u);
    const cleanedText = text
      .replace(/\[\[去客厅:[^\]\r\n]+?\]\]\r?\n?/gu, '')
      .replace(/\[\[客厅传话:[^\]\r\n]+?\]\]\r?\n?/gu, '')
      .trim();
    if (!dispatchMatch && !relayMatch) {
      return { cleanedText: text, summary: null, relayText: null, dispatched: false, relayed: false };
    }

    const isDispatch = Boolean(dispatchMatch);
    const signalType = isDispatch ? 'dispatch' : 'relay';
    const payload = isDispatch ? dispatchMatch[1].trim() : relayMatch[1].trim();

    if (this.data.dispatchChannelEnabled === false) {
      return { cleanedText, summary: isDispatch ? payload : null, relayText: !isDispatch ? payload : null, signalType, dispatched: false, relayed: false, reason: 'channel_disabled' };
    }
    const reg = this.data.registrations?.[agentId];
    if (!reg || !DISPATCH_EXECUTORS.has(reg.executorId)) {
      return { cleanedText, summary: isDispatch ? payload : null, relayText: !isDispatch ? payload : null, signalType, dispatched: false, relayed: false, reason: 'unauthorized_executor' };
    }
    if (!isUserInitiated) {
      return { cleanedText, summary: isDispatch ? payload : null, relayText: !isDispatch ? payload : null, signalType, dispatched: false, relayed: false, reason: 'not_user_initiated' };
    }
    const auth = this.authoritative();
    const conv = auth.conversations?.find(c => c.id === conversationId);
    if (!conv || conv.kind !== 'direct' || conv.agentId !== agentId) {
      return { cleanedText, summary: isDispatch ? payload : null, relayText: !isDispatch ? payload : null, signalType, dispatched: false, relayed: false, reason: 'not_direct_chat' };
    }
    const now = this.now();
    const history = (this.dispatchHistory.get(conv.id) || []).filter(t => now - t < 10 * 60 * 1000);
    if (history.length >= 3) {
      return { cleanedText, summary: isDispatch ? payload : null, relayText: !isDispatch ? payload : null, signalType, dispatched: false, relayed: false, reason: 'rate_limited' };
    }

    history.push(now);
    this.dispatchHistory.set(conv.id, history);

    const livingConv = auth.conversations?.find(c => c.kind === 'living-room');

    if (isDispatch) {
      const summary = payload;
      const dispReqId = 'req_disp_' + crypto.createHash('sha256').update(requestId || (conv.id + '_' + now + '_' + summary)).digest('hex').slice(0, 10);
      if (this.data.pendingDispatches.some(p => p.requestId === dispReqId)) {
        return { cleanedText, summary, signalType, dispatched: true, duplicate: true, requestId: dispReqId };
      }
      const pendingItem = {
        requestId: dispReqId,
        fromConversationId: conv.id,
        fromAgentId: agentId,
        requestedBy: '使用者',
        summary,
        createdAt: now
      };
      this.data.pendingDispatches.push(pendingItem);
      this.change();

      let dispatchPromise = null;
      if (livingConv) {
        const livingMsgText = `@协调者 使用者在私聊里让我修：${summary}，麻烦开个单给我。（工单请求: ${dispReqId}）`;
        dispatchPromise = this.publishMessage({
          requestId: 'msg_' + dispReqId,
          conversationId: livingConv.id,
          agentId: agentId,
          text: livingMsgText,
          medium: 'text'
        }).catch(err => {
          console.error('[bridgeBroker] 发送客厅开单消息失败:', err.message);
        });
      }
      return { cleanedText, summary, signalType: 'dispatch', dispatched: true, requestId: dispReqId, promise: dispatchPromise };
    } else {
      const relayText = payload;
      const relayReqId = 'req_relay_' + crypto.createHash('sha256').update(requestId || (conv.id + '_' + now + '_' + relayText)).digest('hex').slice(0, 10);
      let relayPromise = null;
      if (livingConv) {
        relayPromise = this.publishMessage({
          requestId: 'msg_' + relayReqId,
          conversationId: livingConv.id,
          agentId: agentId,
          text: relayText,
          medium: 'text'
        }).catch(err => {
          console.error('[bridgeBroker] 发送客厅传话消息失败:', err.message);
        });
      }
      return { cleanedText, relayText, signalType: 'relay', relayed: true, requestId: relayReqId, promise: relayPromise };
    }
  }
  async checkOriginReport(ticketId) {
    const auth = this.authoritative();
    const ticket = auth.tickets?.find(t => t.id === ticketId);
    if (!ticket || !ticket.origin || ticket.originReported) return;
    if (this.data.reportedTicketOrigins.includes(ticketId)) return;
    const allTasksDone = ticket.tasks?.every(t => {
      if (t.status === 'done') return true;
      return this.data.jobs.some(j => j.ticketId === ticket.id && j.taskId === t.id && j.state === 'done');
    });
    if (!allTasksDone) return;

    const repReqId = 'rep_origin_' + ticket.id;
    try {
      await this.applyTicketMutation({
        operation: 'ticket-origin-reported',
        requestId: repReqId,
        ticketId: ticket.id
      }, d => d.tickets?.some(t => t.id === ticket.id && t.originReported === true));
    } catch (e) {
      console.warn('[bridgeBroker] ticket-origin-reported 落盘提示:', e.message);
    }
    ticket.originReported = true;
    if (!this.data.reportedTicketOrigins.includes(ticketId)) {
      this.data.reportedTicketOrigins.push(ticketId);
    }
    this.change();

    const origin = ticket.origin;
    const parts = [
      `使用者，之前你让我修的事已经弄好啦：`,
      `【工单】${sanitizeSecretPaths(ticket.title)}`
    ];
    for (const task of (ticket.tasks || [])) {
      const matchingJobs = this.data.jobs.filter(job => job.ticketId === ticket.id && job.taskId === task.id && job.report);
      const j = matchingJobs.length > 0 ? matchingJobs[matchingJobs.length - 1] : null;
      if (j?.report) {
        if (j.report.summary) {
          parts.push(`【${sanitizeSecretPaths(task.title)}】${sanitizeSecretPaths(j.report.summary)}`);
        }
        if (Array.isArray(j.report.checks) && j.report.checks.length) {
          const checksStr = j.report.checks.map(c => sanitizeSecretPaths(typeof c === 'string' ? c : c.name || c.text || JSON.stringify(c))).join('；');
          parts.push(`- 检查项：${checksStr}`);
        }
        if (Array.isArray(j.report.unknowns) && j.report.unknowns.length) {
          const unknownsStr = j.report.unknowns.map(u => sanitizeSecretPaths(String(u))).join('；');
          parts.push(`- 未验证项：${unknownsStr}`);
        }
      }
    }
    parts.push('协调者已经验收通过。');
    const finalReportText = parts.join('\n');

    const reg = this.data.registrations[origin.agentId];
    if (reg?.chatEnabled) {
      try {
        const chatReqId = 'rep_chat_' + ticket.id + '_' + this.now();
        const goal = `使用者在私聊中提的需求已由协调者验收通过。\n工单标题：${ticket.title}\n交付报告：${finalReportText}\n请用你自己的语气和话语在私聊里向使用者报告做完了什么、改动了什么、哪些未验证（如有），语气自然，严禁输出任何绝对路径或令牌。`;
        const turn = this.chat({
          targetAgentId: origin.agentId,
          conversationId: origin.conversationId,
          requestId: chatReqId,
          currentText: goal,
          isUserInitiated: false,
          originReport: true
        });
        turn.promise.then(async (replyText) => {
          const cleaned = sanitizeSecretPaths(replyText);
          await this.publishMessage({
            requestId: 'pub_' + chatReqId,
            conversationId: origin.conversationId,
            agentId: origin.agentId,
            text: cleaned,
            medium: 'text'
          });
        }).catch(async () => {
          await this.publishMessage({
            requestId: 'pub_fallback_' + ticket.id + '_' + this.now(),
            conversationId: origin.conversationId,
            agentId: origin.agentId,
            text: finalReportText,
            medium: 'text'
          });
        });
        return;
      } catch (e) {
        // chat 异常回退
      }
    }

    try {
      await this.publishMessage({
        requestId: 'rep_pub_' + ticket.id + '_' + this.now(),
        conversationId: origin.conversationId,
        agentId: origin.agentId,
        text: finalReportText,
        medium: 'text'
      });
    } catch (e) {
      console.error('[bridgeBroker] 私聊回报发布失败:', e.message);
    }
  }
  snapshot() {
    if(this.url)this.issueCoordinator();
    return {
      schemaVersion:1,
      homeId:this.data.homeId,
      generation:this.data.generation,
      url:this.url||null,
      coordinatorManifestPath:this.sessions.get('coordinator')?.manifestPath||null,
      dispatchChannelEnabled:this.data.dispatchChannelEnabled!==false,
      pendingDispatches:this.data.pendingDispatches||[],
      registrations:Object.values(this.data.registrations).map(r=>({...r,manifestPath:this.sessions.get(r.agentId)?.manifestPath||null,connected:!!this.sessions.get(r.agentId)?.lastSeen && this.now()-this.sessions.get(r.agentId).lastSeen<30000})),
      jobs:this.data.jobs.map(j=>({jobId:j.jobId,ticketId:j.ticketId,taskId:j.taskId,agentId:j.agentId,executorId:j.executorId,kind:j.kind,state:j.state==='review'&&this.pendingTicketMutations.has(j.ticketId)?'returning':j.state,contextVersion:j.contextVersion,attemptId:j.attemptId,workspace:j.workspace,report:j.report,events:j.events,reviewDecision:j.reviewDecision,createdAt:j.createdAt})),
      feed:this.data.feed
    };
  }
  finishChat(job,report) {
    const waiter=this.chatWaiters.get(job.jobId);
    if(!waiter)return;
    this.chatWaiters.delete(job.jobId);
    if(report.outcome==='submitted') {
      const isUser = job.isUserInitiated !== false && !job.originReport;
      const res = this.processDispatchSignal(report.summary, { conversationId: job.conversationId, agentId: job.agentId, requestId: job.requestId, isUserInitiated: isUser });
      const finalSummary = res.cleanedText;
      report.summary = finalSummary;
      waiter.resolve(finalSummary);
    } else {
      waiter.reject(error(report.outcome==='cancelled'?'stale_attempt':'executor_unavailable',report.summary||'客户端未能完成回复'));
    }
  }
  async handle(req,res) {
    const reply=(value,status=200)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
    try {
      // No CORS/browser origin; loopback Host checked to reject DNS rebinding.
      if(req.headers.origin || req.headers.host!==new URL(this.url).host)throw error('forbidden','拒绝浏览器来源或错误 Host');
      const reg=this.auth(req);const route=new URL(req.url,this.url).pathname;
      const coordination=route.startsWith('/v1/bridge/coordinator/');
      if(coordination!==!!reg.coordinator)throw error('forbidden','此会话没有该角色能力');
      if(coordination && req.method==='GET' && route==='/v1/bridge/coordinator/snapshot')return reply({ok:true,...this.coordinationSnapshot()});
      if(req.method==='GET' && route==='/v1/bridge/session')return reply({ok:true,schemaVersion:1,agentId:reg.agentId,executorId:reg.executorId,homeId:this.data.homeId,generation:this.data.generation,instanceGeneration:this.data.generation,workspace:reg.workspace});
      if(req.method!=='POST')throw error('forbidden','不支持的请求');
      let raw='';for await(const chunk of req){raw+=chunk;if(Buffer.byteLength(raw)>128*1024)throw error('forbidden','请求过大');}const b=JSON.parse(raw||'{}');
      if(b.schemaVersion!==1)throw error('unsupported_schema','仅支持 schemaVersion 1');
      if(typeof b.requestId!=='string'||b.requestId.length>160)throw error('forbidden','缺少合法 requestId');
      if(coordination){
        if(route==='/v1/bridge/coordinator/connect'){
          if(b.explicit!==true || typeof b.agentId!=='string')throw error('permission_required','连接需要明确决定和成员 ID');
          this.member(b.agentId);
          if(!this.data.registrations[b.agentId] || !this.sessions.has(b.agentId))throw error('executor_unavailable','成员尚未登记客户端');
          if(!this.launchExecutor)throw error('executor_unavailable','当前实例不支持启动托管客户端');
          return reply(await this.launchExecutor(b.agentId));
        }
        if(route==='/v1/bridge/coordinator/create-ticket')return reply(await this.createTicket(b));
        if(route==='/v1/bridge/coordinator/message')return reply(await this.publishMessage(b));
        if(route==='/v1/bridge/coordinator/reject-review')return reply(await this.rejectReview(b));
        if(route==='/v1/bridge/coordinator/dispatch')return reply(this.dispatch(b));
        if(route==='/v1/bridge/coordinator/cancel')return reply(this.cancel(b.jobId));
        if(route==='/v1/bridge/coordinator/accept')return reply(this.accept(b.jobId));
        if(route==='/v1/bridge/coordinator/artifact'){
          const job=this.data.jobs.find(j=>j.jobId===b.jobId&&j.kind==='work');
          const artifact=job?.report?.artifacts.find(a=>a.path===b.path);
          if(!artifact||!inside(fs.realpathSync(artifact.path),job.workspace)||!['.txt','.md','.json','.js','.ts','.html','.css','.py'].includes(path.extname(artifact.path).toLowerCase()))throw error('forbidden','只读取已交付的批准目录内文本产物');
          const fd=fs.openSync(artifact.path,'r');try{const bytes=Buffer.alloc(16000),n=fs.readSync(fd,bytes,0,bytes.length,0);return reply({ok:true,path:artifact.path,text:bytes.subarray(0,n).toString('utf8'),truncated:fs.fstatSync(fd).size>n});}finally{fs.closeSync(fd);}
        }
        throw error('forbidden','未知统筹操作');
      }
      if(route==='/v1/bridge/claim') {
        // One run per member. Expired leases remain owned; only same attempt can recover.
        let job=this.data.jobs.find(j=>j.agentId===reg.agentId&&ACTIVE.has(j.state)&&j.attemptId);
        // A missing heartbeat proves disconnection, not that the old model has
        // stopped. Never start another executor automatically after expiry.
        if(job)return reply({ok:true,job:null});
        const kinds=b.capabilities?.kinds || ['work'];
        if(job && !kinds.includes(job.kind))return reply({ok:true,job:null});
        if(!job)job=this.data.jobs.find(j=>j.agentId===reg.agentId&&j.state==='queued'&&kinds.includes(j.kind));
        if(!job || job.cancelRequested)return reply({ok:true,job:null});
        if(job.kind==='work'){
          const task=this.authoritative().tickets.find(t=>t.id===job.ticketId)?.tasks.find(t=>t.id===job.taskId);
          if(!task||task.assigneeId!==reg.agentId){
            job.cancelRequested=true;job.state=job.attemptId?'cancelling':'cancelled';this.addFeed(job,'cancel');this.change();
            throw error('stale_attempt','任务已删除或改派，不再发给旧负责人');
          }
        }
        if(!job.attemptId)job.attemptId=id('attempt');
        if(job.state==='offline')job.state='doing';
        const packet=this.currentPacket(job);job.leasedFingerprint=job.contextFingerprint;job.leaseUntil=this.now()+30000;this.change();
        return reply({ok:true,job:{jobId:job.jobId,ticketId:job.ticketId,taskId:job.taskId,agentId:reg.agentId,executorId:reg.executorId,homeId:this.data.homeId,kind:job.kind,goal:job.goal,workspace:job.workspace,attemptId:job.attemptId,contextVersion:packet.contextVersion,...this.executionOptions(this.authoritative().tickets.find(t=>t.id===job.ticketId)?.tasks.find(t=>t.id===job.taskId)),lease:{expiresAt:job.leaseUntil,maxRuntimeMs:15*60*1000}}});
      }
      const job=this.owned(reg,b,route==='/v1/bridge/report');
      if(route==='/v1/bridge/context'){const packet=this.currentPacket(job);this.persist();if(b.knownContextVersion && b.knownContextVersion!==packet.contextVersion)throw error('context_stale','上下文已变化，请重新获取');this.onContext(job,packet);return reply({ok:true,packet});}
      if(route==='/v1/bridge/heartbeat'){
        this.currentPacket(job);job.leaseUntil=this.now()+30000;if(job.state==='offline'){job.state='doing';this.change();}else this.persist();
        return reply({ok:true,attemptState:job.state,leaseUntil:job.leaseUntil,contextVersion:job.contextVersion});
      }
      if(route==='/v1/bridge/events') {
        this.currentPacket(job);
        if(!ACTIVE.has(job.state))throw error('stale_attempt','任务已结束');
        if(!EVENTS.has(b.type)||!Number.isInteger(b.seq)||b.seq<1||typeof b.summary!=='string'||b.summary.length>4000)throw error('forbidden','事件格式无效');
        const previous=job.events.find(e=>e.seq===b.seq);
        if(previous){if(previous.type!==b.type||previous.summary!==b.summary||(previous.checkpointHash||hash(null))!==hash(b.checkpoint||null))throw error('forbidden','重复 seq 内容冲突');return reply({ok:true,duplicate:true});}
        if(b.seq<=job.seq)throw error('stale_attempt','事件序号过期');
        job.seq=b.seq;job.events.push({seq:b.seq,type:b.type,summary:b.summary,checkpointHash:hash(b.checkpoint||null),createdAt:this.now()});
        job.state={started:'doing',progress:'doing',question:'question',permission_required:'permission_required',blocked:'blocked',failed:'blocked'}[b.type];
        if(b.checkpoint)job.checkpoint=b.checkpoint;this.addFeed(job,b.type);this.change();return reply({ok:true});
      }
      if(route==='/v1/bridge/report') {
        if(job.report){if(job.report.reportId===b.reportId && hash(job.report)===hash({reportId:b.reportId,outcome:b.outcome,summary:b.summary,artifacts:b.artifacts||[],checks:b.checks||[],checkpoint:b.checkpoint||null,unknowns:b.unknowns||[]}))return reply({ok:true,duplicate:true});throw error('stale_attempt','此轮已有报告');}
        if(job.cancelRequested && b.outcome!=='cancelled')throw error('stale_attempt','已取消任务不能提交成功');
        if(b.outcome!=='cancelled')this.currentPacket(job);
        if(!['submitted','failed','cancelled'].includes(b.outcome)||typeof b.reportId!=='string'||typeof b.summary!=='string'||b.summary.length>24000||!Array.isArray(b.artifacts)||!Array.isArray(b.checks)||(b.unknowns!==undefined&&(!Array.isArray(b.unknowns)||b.unknowns.some(x=>typeof x!=='string'))))throw error('forbidden','报告格式无效');
        for(const artifact of b.artifacts){if(typeof artifact.path!=='string'||!path.isAbsolute(artifact.path)||!inside(fs.realpathSync(artifact.path),job.workspace)||!fs.statSync(artifact.path).isFile())throw error('forbidden','产物必须是真实批准目录内的文件');}
        job.report={reportId:b.reportId,outcome:b.outcome,summary:b.summary,artifacts:b.artifacts,checks:b.checks,checkpoint:b.checkpoint||null,unknowns:b.unknowns||[]};job.checkpoint=b.checkpoint||job.checkpoint;
        job.state=b.outcome==='submitted'?'review':b.outcome;this.addFeed(job,b.outcome);this.change();this.finishChat(job,job.report);return reply({ok:true,state:job.state});
      }
      throw error('forbidden','路由不存在');
    } catch(e){ reply({ok:false,code:e.code||'unknown',message:e.code?e.message:'请求格式或本机操作失败',retryable:!!e.retryable},e.code==='unauthenticated'?401:e.code==='forbidden'?403:400); }
  }
}
module.exports={BridgeBroker,inside};
