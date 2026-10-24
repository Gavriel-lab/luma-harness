const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { BridgeBroker } = require('./bridgeBroker.cjs');

const result = {
  at: new Date().toISOString(),
  order: 'Order 76 - Coordinator Internal Accept to User Final Acceptance Handoff',
  cases: []
};

async function postHttp(url, route, token, body, headers = {}) {
  const payload = (body && typeof body === 'object') ? {
    schemaVersion: 1,
    requestId: 'req_' + Math.random().toString(36).slice(2, 10),
    ...body
  } : body;
  const res = await fetch(url.replace(/\/$/, '') + route, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer ' + token,
      ...headers
    },
    body: JSON.stringify(payload)
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch (_) {}
  return { status: res.status, body: json || text };
}

function createIsolatedDataStore(initialData, onSave = () => {}) {
  let state = JSON.parse(JSON.stringify(initialData));
  return {
    get: () => state,
    mutate: async (command) => {
      if (command.operation === 'ticket-origin-reported') {
        const t = state.tickets.find(x => x.id === command.ticketId);
        if (t && !t.originReported) {
          t.originReported = true;
          t.stage = 'pending_user_acceptance';
          t.updatedAt = Date.now();
        }
      } else if (command.type === 'companion-message') {
        const m = command.message;
        if (!state.messages.some(x => x.id === m.id)) {
          state.messages.push(m);
        }
      } else if (command.operation === 'user-accept-project') {
        const t = state.tickets.find(x => x.id === command.ticketId);
        if (t && t.stage === 'pending_user_acceptance') {
          t.stage = 'completed';
          t.userAcceptedAt = command.userAcceptedAt;
          t.userAcceptedBy = command.userAcceptedBy;
          t.userFeedback = command.feedback;
          t.updatedAt = Date.now();
        }
      } else if (command.operation === 'approve-plan') {
        const t = state.tickets.find(x => x.id === command.ticketId);
        if (t && t.plan) {
          t.plan.status = 'approved';
          t.stage = 'in_progress';
          t.approvedPlanVersion = command.planVersion;
        }
      }
      onSave(state);
      return { ok: true, applied: true };
    }
  };
}

async function run() {
  console.log('--- 开始工单76内部审核后交接使用者最终验收独立复验 ---');

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'luma-order76-'));
  const brokerDir = path.join(tmpRoot, 'broker');
  const workerDir = path.join(tmpRoot, 'worker');
  fs.mkdirSync(brokerDir, { recursive: true });
  fs.mkdirSync(workerDir, { recursive: true });

  const baseAgents = [
    { id: 'agent_owner', name: '使用者', kind: 'human', connected: true },
    { id: 'agent_coordinator', name: '协调者', kind: 'ai', connected: true, profileId: 'p_coordinator', systemPrompt: '协调者' },
    { id: 'agent_worker', name: '执行助手', kind: 'ai', connected: true, profileId: 'p_worker', systemPrompt: '执行助手' }
  ];
  const baseConversations = [
    { id: 'conv_living_room', kind: 'living-room', createdAt: 1000 },
    { id: 'conv_coordinator_direct', kind: 'direct', agentId: 'agent_coordinator', createdAt: 1001 }
  ];

  // =========================================================================
  // Case 1: 最后一个任务内部审核通过（accept）后交接最终验收（无 origin 方案）
  // =========================================================================
  console.log('--- 运行 Case 1: 最后一个任务内部审核通过后自动交接最终验收 ---');
  const store1 = createIsolatedDataStore({
    version: 1,
    agents: baseAgents,
    conversations: baseConversations,
    messages: [],
    tickets: [{
      id: 'ticket_case1',
      title: '加法功能方案项目',
      goal: '实现加法并完成测试',
      participantIds: ['agent_coordinator', 'agent_worker'],
      tasks: [{
        id: 'task_c1_1',
        title: '加法实现与测试',
        assigneeId: 'agent_worker',
        status: 'todo',
        acceptance: '测试通过'
      }],
      plan: {
        version: 1,
        title: '加法方案',
        status: 'approved',
        conversationId: 'conv_living_room',
        tasks: [{ id: 'task_c1_1', title: '加法实现与测试', assigneeId: 'agent_worker', acceptance: '测试通过' }]
      },
      stage: 'in_progress',
      approvedPlanVersion: 1,
      discussion: { text: '', updatedAt: 1000 }
      // 故意无 origin，模拟从方案或 MCP 创建的协作工单
    }]
  });

  const broker1 = new BridgeBroker({
    dir: path.join(brokerDir, 'b1'),
    getData: () => store1.get(),
    mutateTickets: (cmd) => store1.mutate(cmd)
  });
  await broker1.start();
  broker1.register({ agentId: 'agent_worker', executorId: 'pi', workspace: workerDir });
  const coordToken1 = broker1.sessions.get('coordinator').token;

  // 派发任务并认领
  broker1.scheduleCoordinatorWork('ticket_case1');
  const workerSession1 = broker1.sessions.get('agent_worker');
  const claimRes1 = await postHttp(broker1.url, '/v1/bridge/claim', workerSession1.token, {
    schemaVersion: 1,
    capabilities: { kinds: ['work'] }
  }, { 'x-agent-id': 'agent_worker', 'x-executor-id': 'pi' });
  assert.equal(claimRes1.status, 200);
  const job1 = claimRes1.body.job;
  assert.ok(job1);

  // 写入产物并提交报告
  const addPath = path.join(workerDir, 'add.mjs');
  fs.writeFileSync(addPath, 'export function add(a, b) { return a + b; }\n', 'utf8');
  const repRes1 = await postHttp(broker1.url, '/v1/bridge/report', workerSession1.token, {
    schemaVersion: 1,
    jobId: job1.jobId,
    attemptId: job1.attemptId,
    reportId: 'rep_' + job1.attemptId,
    outcome: 'submitted',
    summary: '加法功能已全部完成',
    artifacts: [{ path: addPath, kind: 'file' }],
    checks: ['4 pass / 0 fail']
  }, { 'x-agent-id': 'agent_worker', 'x-executor-id': 'pi' });
  assert.equal(repRes1.status, 200);

  // 协调者调用 accept 内部审核通过
  const acceptRes1 = await postHttp(broker1.url, '/v1/bridge/coordinator/accept', coordToken1, {
    schemaVersion: 1,
    explicit: true,
    jobId: job1.jobId
  });
  assert.equal(acceptRes1.status, 200);

  // 稍等异步消息写入
  await new Promise(r => setTimeout(r, 200));

  const t1 = store1.get().tickets.find(x => x.id === 'ticket_case1');
  assert.equal(t1.stage, 'pending_user_acceptance', '最后一个任务审核通过后，工单必须落盘转为 pending_user_acceptance');
  assert.equal(t1.originReported, true, 'originReported 标记必须落盘为 true');

  // 验证通知目标为真实协调者私聊，群聊无私人验收消息
  const coordinatorMsgs1 = store1.get().messages.filter(m => m.conversationId === 'conv_coordinator_direct');
  const livingMsgs1 = store1.get().messages.filter(m => m.conversationId === 'conv_living_room' && m.text.includes('确认最终验收'));
  assert.equal(coordinatorMsgs1.length, 1, '协调者私聊必须真实收到一条验收邀请');
  assert.ok(coordinatorMsgs1[0].text.includes('当前等待使用者在工作台进行最终验收'));
  assert.equal(livingMsgs1.length, 0, '客厅群聊绝不得泄露私人验收邀请');
  console.log('✔ Case 1: 最后一个任务通过内部审核交接，stage 落盘转 pending_user_acceptance，协调者私聊准确收到邀请');
  result.cases.push({ name: 'internal_accept_triggers_handoff', pass: true });
  await broker1.stop();

  // =========================================================================
  // Case 2: 旧项目全 done 后的启动补偿交接（模拟停滞工单）
  // =========================================================================
  console.log('--- 运行 Case 2: 旧项目全 done 后的启动补偿交接 ---');
  const store2 = createIsolatedDataStore({
    version: 1,
    agents: baseAgents,
    conversations: baseConversations,
    messages: [],
    tickets: [{
      id: 'ticket_case2_stale',
      title: '历史遗留加法工单',
      goal: '实现加法并测试',
      participantIds: ['agent_coordinator', 'agent_worker'],
      tasks: [{
        id: 'task_c2_1',
        title: '加法功能',
        assigneeId: 'agent_worker',
        status: 'done', // 已经 done
        acceptance: '测试通过'
      }],
      plan: {
        version: 1,
        title: '加法方案',
        status: 'approved',
        conversationId: 'conv_living_room',
        tasks: [{ id: 'task_c2_1', title: '加法功能', assigneeId: 'agent_worker', acceptance: '测试通过' }]
      },
      stage: 'in_progress', // 任务全 done 但仍卡在 in_progress
      originReported: false // 之前未上报
    }]
  });

  const broker2 = new BridgeBroker({
    dir: path.join(brokerDir, 'b2'),
    getData: () => store2.get(),
    mutateTickets: (cmd) => store2.mutate(cmd)
  });
  // 模拟应用重新启动
  await broker2.start();

  await new Promise(r => setTimeout(r, 200));

  const t2 = store2.get().tickets.find(x => x.id === 'ticket_case2_stale');
  assert.equal(t2.stage, 'pending_user_acceptance', '启动补偿必须将历史全 done 项目转为 pending_user_acceptance');
  assert.equal(t2.originReported, true);
  const coordinatorMsgs2 = store2.get().messages.filter(m => m.conversationId === 'conv_coordinator_direct');
  assert.equal(coordinatorMsgs2.length, 1, '启动补偿必须在协调者私聊发出一条验收邀请');
  console.log('✔ Case 2: 旧项目全 done 状态在 Broker 启动补偿时自动交接成功并落盘');
  result.cases.push({ name: 'startup_compensation_handoff', pass: true });

  // =========================================================================
  // Case 3: 幂等性与重启防重
  // =========================================================================
  console.log('--- 运行 Case 3: 幂等性与重启防重 ---');
  // 再次调用 checkOriginReport
  await broker2.checkOriginReport('ticket_case2_stale');
  assert.equal(store2.get().messages.filter(m => m.conversationId === 'conv_coordinator_direct').length, 1, '重复 checkOriginReport 不得追加新通知');

  // 再次重启 Broker
  await broker2.stop();
  const broker2Restart = new BridgeBroker({
    dir: path.join(brokerDir, 'b2'),
    getData: () => store2.get(),
    mutateTickets: (cmd) => store2.mutate(cmd)
  });
  await broker2Restart.start();
  await new Promise(r => setTimeout(r, 200));

  assert.equal(store2.get().messages.filter(m => m.conversationId === 'conv_coordinator_direct').length, 1, '重启后补偿不重复发送相同通知');
  console.log('✔ Case 3: 重复检查与多次重启幂等，0 重复通知，0 多余派工');
  result.cases.push({ name: 'idempotent_no_duplicate_notification', pass: true });
  await broker2Restart.stop();

  // =========================================================================
  // Case 4: 边界防御：未批准或任务未全完成严禁提前待验收
  // =========================================================================
  console.log('--- 运行 Case 4: 未批准与任务未全完成严禁提前待验收 ---');
  const store4 = createIsolatedDataStore({
    version: 1,
    agents: baseAgents,
    conversations: baseConversations,
    messages: [],
    tickets: [
      {
        id: 'ticket_case4_draft',
        title: '未批准方案工单',
        plan: { version: 1, status: 'draft', tasks: [] },
        tasks: [{ id: 't_d1', status: 'done', assigneeId: 'agent_worker' }],
        stage: 'draft',
        originReported: false
      },
      {
        id: 'ticket_case4_incomplete',
        title: '未完成全部任务工单',
        plan: { version: 1, status: 'approved', tasks: [] },
        tasks: [
          { id: 't_inc1', status: 'done', assigneeId: 'agent_worker' },
          { id: 't_inc2', status: 'doing', assigneeId: 'agent_worker' }
        ],
        stage: 'in_progress',
        originReported: false
      }
    ]
  });
  const broker4 = new BridgeBroker({
    dir: path.join(brokerDir, 'b4'),
    getData: () => store4.get(),
    mutateTickets: (cmd) => store4.mutate(cmd)
  });
  await broker4.start();

  await broker4.checkOriginReport('ticket_case4_draft');
  assert.equal(store4.get().tickets.find(x => x.id === 'ticket_case4_draft').stage, 'draft');

  await broker4.checkOriginReport('ticket_case4_incomplete');
  assert.equal(store4.get().tickets.find(x => x.id === 'ticket_case4_incomplete').stage, 'in_progress');
  assert.equal(store4.get().messages.length, 0, '未就绪工单绝不得发送任何验收通知');
  console.log('✔ Case 4: 未批准方案与未完成任务严禁提前转 pending_user_acceptance');
  result.cases.push({ name: 'unapproved_or_incomplete_defense', pass: true });
  await broker4.stop();

  // =========================================================================
  // Case 5: 真实权威会话解析与防泄露
  // =========================================================================
  console.log('--- 运行 Case 5: 真实权威会话解析与防泄露 ---');
  // 5A: 已有合法私聊 origin
  const store5A = createIsolatedDataStore({
    version: 1,
    agents: baseAgents,
    conversations: [
      { id: 'conv_living_room', kind: 'living-room', createdAt: 1000 },
      { id: 'conv_coordinator_custom_direct', kind: 'direct', agentId: 'agent_coordinator', createdAt: 1001 }
    ],
    messages: [],
    tickets: [{
      id: 'ticket_case5a',
      title: '私聊发起工单',
      tasks: [{ id: 't5a_1', status: 'done', assigneeId: 'agent_worker' }],
      stage: 'in_progress',
      origin: { conversationId: 'conv_coordinator_custom_direct', agentId: 'agent_coordinator' }
    }]
  });
  const broker5A = new BridgeBroker({
    dir: path.join(brokerDir, 'b5a'),
    getData: () => store5A.get(),
    mutateTickets: (cmd) => store5A.mutate(cmd)
  });
  await broker5A.start();
  await broker5A.checkOriginReport('ticket_case5a');
  assert.equal(store5A.get().messages.filter(m => m.conversationId === 'conv_coordinator_custom_direct').length, 1, '沿用原有私聊绑定不串会话');
  await broker5A.stop();

  // 5B: 找不到合法协调者私聊目标时，明确阻断，不泄露到群聊
  const store5B = createIsolatedDataStore({
    version: 1,
    agents: baseAgents,
    conversations: [
      { id: 'conv_living_room', kind: 'living-room', createdAt: 1000 }
      // 没有协调者私聊会话
    ],
    messages: [],
    tickets: [{
      id: 'ticket_case5b',
      title: '无私聊目标工单',
      tasks: [{ id: 't5b_1', status: 'done', assigneeId: 'agent_worker' }],
      stage: 'in_progress'
    }]
  });
  const broker5B = new BridgeBroker({
    dir: path.join(brokerDir, 'b5b'),
    getData: () => store5B.get(),
    mutateTickets: (cmd) => store5B.mutate(cmd)
  });
  await broker5B.start();
  await broker5B.checkOriginReport('ticket_case5b');
  assert.equal(store5B.get().messages.filter(m => m.conversationId === 'conv_living_room').length, 0, '无私聊目标时绝不对群聊发送私人内容');
  console.log('✔ Case 5: 权威会话目标严格解析，不串会话，无合法私聊时绝不泄露到群聊');
  result.cases.push({ name: 'authoritative_conversation_security', pass: true });
  await broker5B.stop();

  // =========================================================================
  // Case 6: 模型令牌越权拦截与使用者最终验收闭环
  // =========================================================================
  console.log('--- 运行 Case 6: 模型令牌越权拦截与使用者最终验收闭环 ---');
  const store6 = createIsolatedDataStore({
    version: 1,
    agents: baseAgents,
    conversations: baseConversations,
    messages: [],
    tickets: [{
      id: 'ticket_case6',
      title: '全闭环工单',
      tasks: [{ id: 't6_1', status: 'done', assigneeId: 'agent_worker' }],
      stage: 'pending_user_acceptance', // 已经交接待验收
      originReported: true
    }]
  });
  const broker6 = new BridgeBroker({
    dir: path.join(brokerDir, 'b6'),
    getData: () => store6.get(),
    mutateTickets: (cmd) => store6.mutate(cmd)
  });
  await broker6.start();
  const coordToken6 = broker6.sessions.get('coordinator').token;

  // 6A: 协调者/模型尝试代表人类最终验收，必须被 403 拦截
  const modelAcceptRes = await postHttp(broker6.url, '/v1/bridge/coordinator/user-accept', coordToken6, {
    ticketId: 'ticket_case6'
  });
  assert.equal(modelAcceptRes.status, 403, '协调者或模型令牌调用 user-accept 必须严格返回 403 forbidden');

  // 6B: 使用者在工作台点击确认最终验收（调用 userAcceptProject）
  const userAcceptRes = await broker6.userAcceptProject({
    ticketId: 'ticket_case6',
    explicit: true,
    feedback: '验收通过，非常棒！'
  });
  assert.equal(userAcceptRes.ok, true);
  assert.equal(userAcceptRes.stage, 'completed');

  const t6Final = store6.get().tickets.find(x => x.id === 'ticket_case6');
  assert.equal(t6Final.stage, 'completed', '使用者确认后工单落盘转为 completed');
  assert.equal(t6Final.userAcceptedBy, 'user');
  assert.ok(typeof t6Final.userAcceptedAt === 'number');
  assert.equal(t6Final.userFeedback, '验收通过，非常棒！');
  console.log('✔ Case 6: 模型令牌禁止代表人类最终验收 (403)，使用者在工作台确认后工单落盘转 completed');
  result.cases.push({ name: 'model_forbidden_and_user_accept_flow', pass: true });
  await broker6.stop();

  fs.rmSync(tmpRoot, { recursive: true, force: true });

  const evidenceDir = path.resolve(__dirname, '../../../.local/pi-acceptance');
  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.writeFileSync(path.join(evidenceDir, '76-user-acceptance-handoff-result.json'), JSON.stringify(result, null, 2));

  console.log('--- 工单76全量验收场景 100% 验证通过 ---');
}

run().catch(err => {
  console.error('工单76复验失败:', err);
  process.exitCode = 1;
});
