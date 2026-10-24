'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const vm = require('node:vm');
const ts = require('typescript');
const { BridgeBroker } = require('./bridgeBroker.cjs');
const { DataStore } = require('./dataStore.cjs');

// 编译并载入真实的 applyAuthorityMutation 逻辑，杜绝手写替身
const actualMutations = { exports: {} };
const tsSource = fs.readFileSync(path.join(__dirname, '../src/store/authorityMutations.ts'), 'utf8');
vm.runInNewContext(
  ts.transpileModule(tsSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
  { exports: actualMutations.exports, require, Date, console }
);
const applyRealAuthorityMutation = actualMutations.exports.applyAuthorityMutation;

async function setupTestEnvironment(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luma-collab-test-'));
  const work1 = path.join(dir, 'work1');
  const work2 = path.join(dir, 'work2');
  fs.mkdirSync(work1, { recursive: true });
  fs.mkdirSync(work2, { recursive: true });

  const data = {
    version: 1,
    agents: [
      { id: 'agent_owner', name: '使用者', initial: 'Z', kind: 'human', connected: true, accent: '#fff', statusNote: '' },
      { id: 'agent_coordinator', name: '协调者', initial: 'G', kind: 'ai', connected: true, accent: '#fff', statusNote: '', profileId: 'p_coordinator', systemPrompt: '协调者' },
      { id: 'agent_kiro', name: 'Researcher', initial: 'R', kind: 'ai', connected: true, accent: '#fff', statusNote: '', profileId: 'p_kiro', systemPrompt: 'Researcher' },
      { id: 'agent_editor', name: '编辑助手', initial: 'L', kind: 'ai', connected: true, accent: '#fff', statusNote: '', profileId: 'p_desktop-agent', systemPrompt: '编辑助手' }
    ],
    conversations: [
      { id: 'conv_living_room', title: '小屋客厅', kind: 'living-room', agentId: null, createdAt: 1000 },
      { id: 'conv_coordinator_direct', title: '协调者私聊', kind: 'direct', agentId: 'agent_coordinator', createdAt: 1000 },
      { id: 'conv_kiro_direct', title: 'Researcher私聊', kind: 'direct', agentId: 'agent_kiro', createdAt: 1000 },
      { id: 'conv_desktop-agent_direct', title: '编辑助手私聊', kind: 'direct', agentId: 'agent_editor', createdAt: 1000 }
    ],
    activeConversationId: 'conv_living_room',
    messages: [
      { id: 'm1', conversationId: 'conv_living_room', agentId: 'agent_owner', text: '大家看看新App方案怎么样', createdAt: 1000, status: 'sent', demo: false, requestId: null }
    ],
    tickets: [],
    preferences: { theme: 'day' }
  };

  const store = new DataStore(dir);
  store.beginSession('test');
  let revision = 0;
  await store.save(JSON.stringify(data), ++revision, 'test');
  const read = () => JSON.parse(store.read().raw);

  // 使用权威 applyAuthorityMutation 真实落盘
  const mutation = async command => {
    const current = read();
    const updated = applyRealAuthorityMutation(current, command);
    return store.save(JSON.stringify(updated), ++revision, 'test');
  };

  const broker = new BridgeBroker({
    dir: path.join(dir, 'broker'),
    getData: read,
    mutateTickets: mutation
  });
  await broker.start();
  if (t && typeof t.after === 'function') {
    t.after(() => {
      if (broker.server) broker.server.close();
    });
  }

  // 注册两个合法 worker
  const reg1 = broker.register({ agentId: 'agent_editor', executorId: 'antigravity-adapter', workspace: work1 });
  const reg2 = broker.register({ agentId: 'agent_kiro', executorId: 'kiro', workspace: work2 });

  return { dir, store, read, broker, work1, work2, mutation, mutate: mutation };
}

function postHttp(url, pathName, token, body, extraHeaders = {}) {
  const u = new URL(pathName, url);
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body || {});
    const req = http.request(u, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(data),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...extraHeaders
      }
    }, res => {
      let buf = '';
      res.on('data', d => { buf += d; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(buf) });
        } catch (_) {
          resolve({ status: res.statusCode, body: buf });
        }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

test('工单42：闭环测试 1 - 方案草案状态下 0 次派发，点击开工后自动按依赖派发', async (t) => {
  const env = await setupTestEnvironment(t);
  const { broker, read } = env;

  // 创建一个带方案与依赖的工单：task2 依赖 task1
  const ticketId = 'ticket_app_001';
  const plan = {
    version: 1,
    title: '新App轻量MVP',
    goal: '先完成架构与核心模块',
    status: 'draft',
    conversationId: 'conv_living_room',
    tasks: [
      { id: 'task_001', title: '核心模块研发', assigneeId: 'agent_editor' },
      { id: 'task_002', title: 'UI集成与验证', assigneeId: 'agent_kiro', dependencies: ['task_001'] }
    ]
  };

  const createRes = await broker.createTicket({
    schemaVersion: 1,
    explicit: true,
    requestId: 'req_create_001',
    ticketId,
    title: plan.title,
    goal: plan.goal,
    tasks: [
      { id: 'task_001', title: '核心模块研发', assigneeId: 'agent_editor', acceptance: '产出核心代码' },
      { id: 'task_002', title: 'UI集成与验证', assigneeId: 'agent_kiro', acceptance: '完成界面集成', dependencies: ['task_001'] }
    ],
    origin: { conversationId: 'conv_living_room', agentId: 'agent_owner', requestId: 'req_init_001' }
  });
  assert.equal(createRes.ok, true);

  // 1. 验证：方案批准前，broker 中待派发任务为 0，active job 数量为 0
  const jobsBefore = broker.data.jobs.filter(j => j.ticketId === ticketId);
  assert.equal(jobsBefore.length, 0, '方案批准前绝对 0 次 dispatch');

  // 2. 验证：非显式（如普通模型或无 explicit 标记）调用 approvePlan 被拒绝
  await assert.rejects(
    async () => {
      await broker.approvePlan({ ticketId, planVersion: 1, explicit: false });
    },
    /必须经由使用者明确操作确认开工/
  );

  // 3. 使用者显式前端点击开工（approvePlan）
  const approveRes = await broker.approvePlan({ ticketId, planVersion: 1, explicit: true });
  assert.equal(approveRes.ok, true);
  assert.equal(approveRes.stage, 'in_progress');

  // 4. 验证：点击开工后协调者统筹自动派发，task1 没有前置依赖，顺利进入派发队列；而 task2 依赖 task1，不得提前派发
  const jobsAfter = broker.data.jobs.filter(j => j.ticketId === ticketId);
  assert.equal(jobsAfter.length, 1, '只有依赖满足的 task1 派发，task2 不得提前派发');
  assert.equal(jobsAfter[0].taskId, 'task_001');
  assert.equal(jobsAfter[0].agentId, 'agent_editor');

  // 5. 重复点击开工具有幂等性，不重复派发
  const repeatApprove = await broker.approvePlan({ ticketId, planVersion: 1, explicit: true });
  assert.equal(repeatApprove.ok, true);
  assert.equal(repeatApprove.duplicate, true);
  assert.equal(broker.data.jobs.filter(j => j.ticketId === ticketId).length, 1, '重复点击开工不重复创建任务');
});

test('工单42：闭环测试 2 - 假 worker 初次失败 -> 协调者结构化返修 -> 重跑内部通过 -> 依赖任务自动解锁 -> 全 done 进入待使用者验收', async (t) => {
  const env = await setupTestEnvironment(t);
  const { broker, work1, work2 } = env;

  const ticketId = 'ticket_app_002';
  await broker.createTicket({
    schemaVersion: 1,
    explicit: true,
    requestId: 'req_create_002',
    ticketId,
    title: '完整闭环协作项目',
    goal: '端到端依赖与返修闭环',
    tasks: [
      { id: 'task_backend', title: '后端接口服务', assigneeId: 'agent_editor', acceptance: '接口可调用' },
      { id: 'task_frontend', title: '前端页面接入', assigneeId: 'agent_kiro', acceptance: '页面显示数据', dependencies: ['task_backend'] }
    ],
    origin: { conversationId: 'conv_coordinator_direct', agentId: 'agent_coordinator', requestId: 'req_origin_002' }
  });

  // 使用者点击开工
  await broker.approvePlan({ ticketId, planVersion: 1, explicit: true });

  const job1 = broker.data.jobs.find(j => j.ticketId === ticketId && j.taskId === 'task_backend');
  assert.ok(job1);

  // 模拟 worker 1 (编辑助手) 领取任务
  const tokenLaolin = broker.sessions.get('agent_editor').token.toString('hex');
  const claim1 = await postHttp(broker.url, '/v1/bridge/claim', tokenLaolin, {
    schemaVersion: 1,
    requestId: 'req_claim_001',
    capabilities: { kinds: ['work'] }
  }, {
    'x-agent-id': 'agent_editor',
    'x-executor-id': 'antigravity-adapter'
  });
  assert.equal(claim1.status, 200);
  assert.equal(claim1.body.job.jobId, job1.jobId);

  // 模拟 worker 1 第一次提交：报告中存在缺陷（模拟需要返修）
  const attemptId1 = claim1.body.job.attemptId;
  const artifactFile1 = path.join(work1, 'core.js');
  fs.writeFileSync(artifactFile1, 'export const api = null;'); // 缺陷代码

  const report1 = await postHttp(broker.url, '/v1/bridge/report', tokenLaolin, {
    schemaVersion: 1,
    requestId: 'req_rep_001',
    reportId: 'report_001',
    jobId: job1.jobId,
    attemptId: attemptId1,
    outcome: 'submitted',
    summary: '后端接口初版已交付，但缺少实现',
    artifacts: [{ path: artifactFile1 }],
    checks: ['单测待补'],
    unknowns: ['未进行压力测试']
  }, {
    'x-agent-id': 'agent_editor',
    'x-executor-id': 'antigravity-adapter'
  });
  if (report1.status !== 200) console.error('report1 error:', report1.body);
  assert.equal(report1.status, 200);
  assert.equal(job1.state, 'review', 'worker 1 提交后进入 review 状态');

  // 验证：此时下游 task_frontend 仍然被依赖阻塞，绝对不得提前派发
  assert.equal(broker.data.jobs.some(j => j.taskId === 'task_frontend'), false, '前置任务未通过前，下游任务不可执行');

  // 协调者 Coordinator 审核不通过，发起结构化退回返修（rejectReview）
  const tokenCoord = broker.sessions.get('coordinator').token.toString('hex');
  const rejectRes = await postHttp(broker.url, '/v1/bridge/coordinator/reject-review', tokenCoord, {
    schemaVersion: 1,
    explicit: true,
    requestId: 'req_reject_001',
    jobId: job1.jobId,
    attemptId: attemptId1,
    reportId: 'report_001',
    reason: '核心函数导出为 null，请补齐实际返回逻辑'
  }, {
    'x-agent-id': 'agent_coordinator',
    'x-executor-id': 'xiaowu-coordinator'
  });
  if (rejectRes.status !== 200) console.error('rejectRes error:', rejectRes.body);
  assert.equal(rejectRes.status, 200);
  assert.equal(rejectRes.body.ok, true);

  // 验证：退回后在范围内自动重新调度重跑（无须再次烦扰使用者）
  // 查找重新调度后的 job
  const job1Retry = broker.data.jobs.find(j => j.ticketId === ticketId && j.taskId === 'task_backend' && j.state === 'queued');
  assert.ok(job1Retry, '返修后系统自动重排任务');

  // worker 1 领取重试任务
  const claim1Retry = await postHttp(broker.url, '/v1/bridge/claim', tokenLaolin, {
    schemaVersion: 1,
    requestId: 'req_claim_retry_001',
    capabilities: { kinds: ['work'] }
  }, {
    'x-agent-id': 'agent_editor',
    'x-executor-id': 'antigravity-adapter'
  });
  assert.equal(claim1Retry.status, 200);
  assert.equal(claim1Retry.body.job.jobId, job1Retry.jobId);

  // 修复并重新提交
  fs.writeFileSync(artifactFile1, 'export const api = () => ({ status: "ok" });');
  const report1Retry = await postHttp(broker.url, '/v1/bridge/report', tokenLaolin, {
    schemaVersion: 1,
    requestId: 'req_rep_retry_001',
    reportId: 'report_retry_001',
    jobId: job1Retry.jobId,
    attemptId: claim1Retry.body.job.attemptId,
    outcome: 'submitted',
    summary: '修复核心逻辑，导出完整函数并通过验证',
    artifacts: [{ path: artifactFile1 }],
    checks: ['单元测试全部通过'],
    unknowns: []
  }, {
    'x-agent-id': 'agent_editor',
    'x-executor-id': 'antigravity-adapter'
  });
  assert.equal(report1Retry.status, 200);

  // 协调者 Coordinator 内部验收通过（accept）
  const acceptRes1 = await postHttp(broker.url, '/v1/bridge/coordinator/accept', tokenCoord, {
    schemaVersion: 1,
    requestId: 'req_accept_001',
    jobId: job1Retry.jobId
  }, {
    'x-agent-id': 'agent_coordinator',
    'x-executor-id': 'xiaowu-coordinator'
  });
  assert.equal(acceptRes1.status, 200);

  // 验证：task_backend 内部验收通过后，协调者 coordinator 自动解锁并自动派发 task_frontend！
  const job2 = broker.data.jobs.find(j => j.ticketId === ticketId && j.taskId === 'task_frontend');
  assert.ok(job2, '下游依赖任务 task_frontend 自动解锁派发成功！');
  assert.equal(job2.agentId, 'agent_kiro');

  // worker 2 (Researcher) 领取并完成执行
  const tokenKiro = broker.sessions.get('agent_kiro').token.toString('hex');
  const claim2 = await postHttp(broker.url, '/v1/bridge/claim', tokenKiro, {
    schemaVersion: 1,
    requestId: 'req_claim_002',
    capabilities: { kinds: ['work'] }
  }, {
    'x-agent-id': 'agent_kiro',
    'x-executor-id': 'kiro'
  });
  assert.equal(claim2.status, 200);

  const artifactFile2 = path.join(work2, 'App.jsx');
  fs.writeFileSync(artifactFile2, 'export function App() { return <div>OK</div>; }');
  const report2 = await postHttp(broker.url, '/v1/bridge/report', tokenKiro, {
    schemaVersion: 1,
    requestId: 'req_rep_002',
    reportId: 'report_002',
    jobId: job2.jobId,
    attemptId: claim2.body.job.attemptId,
    outcome: 'submitted',
    summary: '前端页面接入完成，数据对接通畅',
    artifacts: [{ path: artifactFile2 }],
    checks: ['页面渲染无误'],
    unknowns: []
  }, {
    'x-agent-id': 'agent_kiro',
    'x-executor-id': 'kiro'
  });
  assert.equal(report2.status, 200);

  // 协调者对 worker 2 进行内部验收通过
  const acceptRes2 = await postHttp(broker.url, '/v1/bridge/coordinator/accept', tokenCoord, {
    schemaVersion: 1,
    requestId: 'req_accept_002',
    jobId: job2.jobId
  }, {
    'x-agent-id': 'agent_coordinator',
    'x-executor-id': 'xiaowu-coordinator'
  });
  assert.equal(acceptRes2.status, 200);

  // 等到实际通知落盘，不用固定 60ms 假定异步写入完成。
  for (let n = 0; n < 100 && !env.read().messages.some(m => m.conversationId === 'conv_coordinator_direct'); n++) {
    await new Promise(r => setTimeout(r, 20));
  }

  // 关键验证：整体验证与最终验收解耦！
  // 所有子任务内部全部 done 之后，工单状态绝不直接标记为 completed，而是转为 pending_user_acceptance！
  const authAfterAllDone = env.read();
  const ticketAfterAllDone = authAfterAllDone.tickets.find(t => t.id === ticketId);
  assert.equal(ticketAfterAllDone.stage, 'pending_user_acceptance', '所有子任务内部完成后进入待使用者验收');
  assert.notEqual(ticketAfterAllDone.stage, 'completed', '内部 accept 不得等于使用者项目验收');

  // 验证：协调者通过私聊单独通知使用者一次
  const msgs = authAfterAllDone.messages.filter(m => m.conversationId === 'conv_coordinator_direct');
  assert.ok(msgs.length >= 1, '协调者向私聊发送通知');
  assert.match(msgs[msgs.length - 1].text, /待使用者|最终验收/, '通知内容强调待使用者最终验收，不声称使用者已验收');

  // 使用者在工作台点击确认验收（userAcceptProject）
  const userAcceptRes = await broker.userAcceptProject({ ticketId, explicit: true });
  assert.equal(userAcceptRes.ok, true);
  assert.equal(userAcceptRes.stage, 'completed');

  const authFinal = env.read();
  const ticketFinal = authFinal.tickets.find(t => t.id === ticketId);
  assert.equal(ticketFinal.stage, 'completed');
  assert.equal(ticketFinal.userAcceptedBy, 'user');
  assert.ok(ticketFinal.userAcceptedAt > 0);
});

test('工单42：闭环测试 3 - 使用者不满意提出修改意见，转入修订流程', async (t) => {
  const env = await setupTestEnvironment(t);
  const { broker, read } = env;

  const ticketId = 'ticket_app_003';
  await broker.createTicket({
    schemaVersion: 1,
    explicit: true,
    requestId: 'req_create_003',
    ticketId,
    title: '修订流程测试',
    goal: '验证使用者需要修改分支',
    tasks: [
      { id: 'task_only', title: '单项任务', assigneeId: 'agent_editor', acceptance: '产物交付' }
    ],
    origin: { conversationId: 'conv_living_room', agentId: 'agent_owner', requestId: 'req_003' }
  });

  await broker.approvePlan({ ticketId, planVersion: 1, explicit: true });
  const auth = read();
  const ticket = auth.tickets.find(t => t.id === ticketId);
  ticket.stage = 'pending_user_acceptance';

  // 补齐工单60统筹审查模型 Fake 及合法结构化契约，保留有效范围内自动续工与修改通报断言
  broker.attachCoordinatorReviewer({
    getData: read,
    startChat: async (_, emit) => {
      emit('chat:stream-done', {
        accumulatedText: JSON.stringify({
          scopeExpansion: false,
          reason: '页面配色与圆角属于原方案界面细节微调',
          planVersion: 1,
          revisionRound: 0,
          affectedTaskIds: ['task_only'],
          proposedChanges: '温馨配色与圆角按钮',
          newDirectories: [],
          newTools: []
        })
      });
      return { ok: true };
    }
  });

  // 使用者在工作台提交修改意见（工单46规范：范围内微调保持推进，自动安排续工，无需使用者二次开工）
  const reviseRes = await broker.userReviseProject({
    ticketId,
    feedback: '页面配色还需要更温馨一些，按钮做圆角',
    explicit: true
  });
  assert.equal(reviseRes.ok, true);
  assert.equal(reviseRes.stage, 'in_progress');

  const authAfterRevise = read();
  const ticketAfterRevise = authAfterRevise.tickets.find(t => t.id === ticketId);
  assert.equal(ticketAfterRevise.stage, 'in_progress');
  assert.equal(ticketAfterRevise.userFeedback, '页面配色还需要更温馨一些，按钮做圆角');
});

test('工单44：断点验证 1 & 2 - coordinator 令牌无法冒充人类批准开工与最终验收 (严格返回 403)', async (t) => {
  const env = await setupTestEnvironment(t);
  const { broker } = env;
  const ticketId = 'ticket_probe_auth_01';
  await broker.createTicket({
    schemaVersion: 1, explicit: true, requestId: 'req_probe_auth_01', ticketId,
    title: '权限隔离验证', goal: '验证人类权限不可冒充',
    tasks: [{ id: 'task_auth_01', title: '子任务', assigneeId: 'agent_editor', acceptance: '验收' }]
  });

  const coordToken = broker.sessions.get('coordinator').token;
  // 1. coordinator HTTP 试图调用 approve-plan 必须报 403
  const resApprove = await postHttp(broker.url, '/v1/bridge/coordinator/approve-plan', coordToken, {
    schemaVersion: 1, explicit: true, requestId: 'probe_apprv', ticketId, planVersion: 1
  });
  assert.equal(resApprove.status, 403, 'coordinator 令牌无权审批开工');

  // 2. coordinator HTTP 试图调用 user-accept 必须报 403
  const resAccept = await postHttp(broker.url, '/v1/bridge/coordinator/user-accept', coordToken, {
    schemaVersion: 1, explicit: true, requestId: 'probe_acc', ticketId
  });
  assert.equal(resAccept.status, 403, 'coordinator 令牌无权最终验收');
});

test('工单44：断点验证 3 & 7 - 未批准/草案方案 0 次派发，新草案撤销开工授权', async (t) => {
  const env = await setupTestEnvironment(t);
  const { broker, read } = env;
  const ticketId = 'ticket_probe_scope_01';
  await broker.createTicket({
    schemaVersion: 1, explicit: true, requestId: 'req_probe_scope_01', ticketId,
    title: '版本范围验证', goal: '验证新草案范围撤销授权',
    tasks: [{ id: 'task_scope_01', title: '任务1', assigneeId: 'agent_editor', acceptance: '验收' }]
  });

  // 更新为草案方案
  await env.mutation({
    operation: 'update-plan', requestId: 'req_plan_draft', ticketId,
    plan: { version: 1, title: '草案', goal: '草案', status: 'draft', tasks: [] }
  });

  // 1. 草案未批准时调 dispatch 必须被拦截 (400)
  const coordToken = broker.sessions.get('coordinator').token;
  const resDisp = await postHttp(broker.url, '/v1/bridge/coordinator/dispatch', coordToken, {
    schemaVersion: 1, requestId: 'req_disp_unapprv', ticketId, taskId: 'task_scope_01'
  });
  assert.notEqual(resDisp.status, 200);
  assert.equal(broker.data.jobs.length, 0, '未批准草案不得派发任何 job');

  // 2. 批准开工后，若写入新范围 v2 草案，自动将 stage 转为 planning 撤销执行授权
  await broker.approvePlan({ ticketId, planVersion: 1, explicit: true });
  assert.equal(read().tickets.find(t => t.id === ticketId).stage, 'in_progress');

  await env.mutation({
    operation: 'update-plan', requestId: 'req_plan_v2', ticketId,
    plan: { version: 2, title: '扩大范围草案', goal: '新范围', status: 'draft', tasks: [] }
  });
  const ticketAfterNewDraft = read().tickets.find(t => t.id === ticketId);
  assert.equal(ticketAfterNewDraft.stage, 'draft', '新范围草案必须撤销 in_progress 授权');
});

test('工作台改版：worker 交付在后台唤起协调者审核，群聊保持安静', async (t) => {
  const env = await setupTestEnvironment(t);
  const { broker, read } = env;
  const ticketId = 'ticket_probe_rep_01';
  await broker.createTicket({
    schemaVersion: 1, explicit: true, requestId: 'req_probe_rep_01', ticketId,
    title: '报告投递闭环', goal: '验证报告唤起协调任务',
    tasks: [{ id: 'task_rep_01', title: '开发任务', assigneeId: 'agent_editor', acceptance: '提交成果' }],
    origin: { conversationId: 'conv_living_room', agentId: 'agent_coordinator', requestId: 'orig_01' }
  });

  await broker.approvePlan({ ticketId, planVersion: 1, explicit: true });
  const tokenLaolin = broker.sessions.get('agent_editor').token;
  const headers = { 'x-agent-id': 'agent_editor', 'x-executor-id': 'antigravity-adapter' };

  // claim
  const claim = await postHttp(broker.url, '/v1/bridge/claim', tokenLaolin, {
    schemaVersion: 1, requestId: 'claim_rep_01', capabilities: { kinds: ['work'] }
  }, headers);
  assert.equal(claim.status, 200);

  // report
  const rep = await postHttp(broker.url, '/v1/bridge/report', tokenLaolin, {
    schemaVersion: 1, requestId: 'rep_01', jobId: claim.body.job.jobId, attemptId: claim.body.job.attemptId,
    reportId: 'rep_actual_01', outcome: 'submitted', summary: '核心功能已交付，请协调者审查',
    artifacts: [], checks: [], unknowns: []
  }, headers);
  assert.equal(rep.status, 200);

  // 新契约：后台报告不再通过普通群消息唤起审核。
  const groupMsgs = read().messages.filter(m => m.conversationId === 'conv_living_room');
  assert.equal(groupMsgs.length, 1, '交付报告留在后台，原群聊不增加流水');

  // 验证：自动生成了属于协调者的统筹审查任务 (coordination job)
  const coordJobs = broker.data.jobs.filter(j => j.agentId === 'agent_coordinator' && j.kind === 'coordination');
  assert.ok(coordJobs.length >= 1, '必须生成协调者协调审查任务');
});

test('工单44：断点验证 5 - 使用者修改意见通报群聊并安排修订重跑，再次开工继续调度', async (t) => {
  const env = await setupTestEnvironment(t);
  const { broker, read } = env;
  const ticketId = 'ticket_probe_rev_01';
  await broker.createTicket({
    schemaVersion: 1, explicit: true, requestId: 'req_probe_rev_01', ticketId,
    title: '修改意见闭环', goal: '验证修改重跑',
    tasks: [{ id: 'task_rev_01', title: '界面微调', assigneeId: 'agent_editor', acceptance: '通过' }],
    origin: { conversationId: 'conv_living_room', agentId: 'agent_coordinator', requestId: 'orig_rev_01' }
  });

  await broker.approvePlan({ ticketId, planVersion: 1, explicit: true });
  // 模拟任务完成并进入待使用者验收
  await env.mutation({ operation: 'patch-task', requestId: 'req_done', ticketId, taskId: 'task_rev_01', patch: { status: 'done' } });
  await env.mutation({ operation: 'ticket-origin-reported', requestId: 'req_rep_rdy', ticketId });

  // 补齐工单60统筹审查模型 Fake 及合法结构化契约，保留有效范围内自动续工与修改通报断言
  broker.attachCoordinatorReviewer({
    getData: read,
    startChat: async (_, emit) => {
      emit('chat:stream-done', {
        accumulatedText: JSON.stringify({
          scopeExpansion: false,
          reason: '修改浅蓝色属于原方案微调',
          planVersion: 1,
          revisionRound: 0,
          affectedTaskIds: ['task_rev_01'],
          proposedChanges: '浅蓝微调',
          newDirectories: [],
          newTools: []
        })
      });
      return { ok: true };
    }
  });

  const msgCountBefore = read().messages.length;
  // 使用者提出修改意见
  await broker.userReviseProject({ ticketId, explicit: true, feedback: '需要把按钮改成浅蓝色' });
  const msgCountAfter = read().messages.length;
  assert.ok(msgCountAfter > msgCountBefore, '修改意见必须由协调者通报群聊');

  // 使用者提出修改意见后自动排队续工
  assert.ok(broker.data.jobs.some(j => j.ticketId === ticketId && j.state === 'queued'), '修改后已自动排队续工');

  // 若前端或使用者再次触发开工，幂等保证工单处于推进中且不产生破坏
  const approve = await broker.approvePlan({ ticketId, planVersion: 1, explicit: true });
  const currentTicket = read().tickets.find(x => x.id === ticketId);
  assert.equal(currentTicket.stage, 'in_progress');
  assert.equal(currentTicket.originReported, false, '新修订轮次必须重置 originReported');
  assert.ok(approve.ok, '再次开工调用必须安全返回 ok');
});

test('工单44：断点验证 6 - 批准后排队前崩溃中断，重启与重复开工幂等补偿恢复', async (t) => {
  const env = await setupTestEnvironment(t);
  const { dir, store } = env;
  const ticketId = 'ticket_probe_crash_01';
  await env.broker.createTicket({
    schemaVersion: 1, explicit: true, requestId: 'req_probe_crash_01', ticketId,
    title: '容灾补偿验证', goal: '崩溃后自动补偿',
    tasks: [{ id: 'task_crash_01', title: '单项任务', assigneeId: 'agent_editor', acceptance: '通过' }]
  });

  // 模拟保存后但在 dispatch 前崩溃
  env.broker.scheduleCoordinatorWork = () => { throw new Error('simulated crash before dispatch'); };
  await assert.rejects(() => env.broker.approvePlan({ ticketId, planVersion: 1, explicit: true }), /simulated crash/);
  await env.broker.stop();

  // 重启 Broker
  const read = () => JSON.parse(store.read().raw);
  const mutation = async command => {
    const cur = read();
    const updated = applyRealAuthorityMutation(cur, command);
    return store.save(JSON.stringify(updated), 999, 'test');
  };
  const restarted = new BridgeBroker({ dir: path.join(dir, 'broker'), getData: read, mutateTickets: mutation });
  restarted.register({ agentId: 'agent_editor', executorId: 'antigravity-adapter', workspace: env.work1 });
  await restarted.start();

  // 重启后调用 approvePlan 补偿
  const res = await restarted.approvePlan({ ticketId, planVersion: 1, explicit: true });
  assert.equal(res.duplicate, true);
  assert.ok(restarted.data.jobs.length > 0, '重启后必须幂等补偿派发出任务');
  await restarted.stop();
});

test('工单44：断点验证 8 & 9 - 前端保存失败不调接口，缺运行时不伪造状态', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/components/Workbench.tsx'), 'utf8');
  const begin = source.indexOf('  const handleApprovePlan = async () => {');
  const end = source.indexOf('\n  // 使用者确认最终验收', begin);
  assert.ok(begin > 0 && end > begin);
  const code = ts.transpileModule(source.slice(begin, end).replace('const handleApprovePlan', 'globalThis.handleApprovePlan'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 }
  }).outputText;

  // 验证保存失败：0 次 bridge 调用，0 次 dispatch
  let bridgeCalls = 0; const actions = [];
  const ctxFailedSave = {
    ticket: { id: 't_mock' }, busyAction: false, planVersion: 1,
    setBusyAction: () => {}, setActionError: () => {},
    store: { flushSave: async () => false },
    window: { xiaowuDesktop: { bridge: { approvePlan: async () => { bridgeCalls++; return { ok: true }; } } } },
    dispatch: a => actions.push(a)
  };
  vm.runInNewContext(code, ctxFailedSave);
  await ctxFailedSave.handleApprovePlan();
  assert.equal(bridgeCalls, 0, '保存失败绝对不调 bridge 接口');
  assert.equal(actions.length, 0, '保存失败绝对不 dispatch');

  // 验证缺运行时：0 次 dispatch，呈现明确错误提示
  let errMsg = '';
  const ctxNoRuntime = {
    ticket: { id: 't_mock' }, busyAction: false, planVersion: 1,
    setBusyAction: () => {}, setActionError: msg => { errMsg = msg; },
    store: { flushSave: async () => true },
    window: {},
    dispatch: a => actions.push(a)
  };
  vm.runInNewContext(code, ctxNoRuntime);
  await ctxNoRuntime.handleApprovePlan();
  assert.equal(actions.length, 0, '无运行时绝对不本地假装已批准');
  assert.ok(errMsg.includes('当前客户端未连接或版本尚未支持'), '必须提示不支持或未连接');
});
