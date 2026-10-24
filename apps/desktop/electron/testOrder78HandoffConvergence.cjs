const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const Module = require('node:module');

const workspaceRoot = path.resolve(__dirname, '..');
const req = Module.createRequire(path.join(workspaceRoot, 'package.json'));
const { BridgeBroker } = req('./electron/bridgeBroker.cjs');
const ts = req('typescript');

// 严格按照工单78要求：使用真实的 authorityMutations reducer，不使用自制 reducer
const authMutationsTsSrc = fs.readFileSync(path.join(workspaceRoot, 'src/store/authorityMutations.ts'), 'utf8');
const compiledAuth = ts.transpileModule(authMutationsTsSrc, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText;
const authModule = new Module(path.join(workspaceRoot, 'src/store/authorityMutations.cjs'));
authModule._compile(compiledAuth, path.join(workspaceRoot, 'src/store/authorityMutations.cjs'));
const { applyAuthorityMutation } = authModule.exports;

const unhandledRejections = [];
process.on('unhandledRejection', (reason) => {
  unhandledRejections.push(reason instanceof Error ? reason.message : String(reason));
});

const result = {
  at: new Date().toISOString(),
  order: 'Order 78 - Handoff Convergence & Two P1 Fixes Verification',
  cases: []
};

function createIsolatedFileStore(filePath, initialData, control = { ready: true, failNotice: false, failStage: false }) {
  fs.writeFileSync(filePath, JSON.stringify(initialData, null, 2), 'utf8');
  let mutationCount = 0;

  const getData = () => JSON.parse(fs.readFileSync(filePath, 'utf8'));

  const mutateTickets = async (command) => {
    mutationCount++;
    if (!control.ready) {
      return { ok: false, applied: false, reason: '小屋窗口未就绪' };
    }
    if (control.failStage && command.operation === 'ticket-origin-reported') {
      return { ok: false, applied: false, reason: 'Synthetic stage save failure' };
    }
    if (control.failNotice && command.type === 'companion-message') {
      return { ok: false, applied: false, reason: 'Synthetic notification save failure' };
    }

    const current = getData();
    const updated = applyAuthorityMutation(current, command);
    fs.writeFileSync(filePath, JSON.stringify(updated, null, 2), 'utf8');
    return { ok: true, applied: true };
  };

  return {
    getData,
    mutateTickets,
    getMutationCount: () => mutationCount,
    read: getData,
    write: (data) => fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8')
  };
}

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

async function run() {
  console.log('--- 开始工单78交接修复验收与集中收口独立复验 ---');

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'luma-order78-convergence-'));
  const workerDir = path.join(tmpRoot, 'worker');
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
  // Case 1: 正常内部 accept 后交接（无 origin、群聊发起、已有私聊来源分别测试）
  // =========================================================================
  console.log('--- 运行 Case 1: 正常内部 accept 后交接与目标会话解析 ---');
  const store1File = path.join(tmpRoot, 'store1.json');
  const store1 = createIsolatedFileStore(store1File, {
    version: 1,
    agents: baseAgents,
    conversations: [
      ...baseConversations,
      { id: 'conv_coordinator_custom', kind: 'direct', agentId: 'agent_coordinator', createdAt: 1002 }
    ],
    messages: [],
    tickets: [
      // 1A: 无 origin 协作项目
      {
        id: 't_c1_no_origin',
        title: '无 origin 方案项目',
        goal: '完成加法',
        participantIds: ['agent_coordinator', 'agent_worker'],
        tasks: [{ id: 'task_1a', title: '加法开发', assigneeId: 'agent_worker', status: 'todo' }],
        plan: { version: 1, status: 'approved', conversationId: 'conv_living_room' },
        stage: 'in_progress',
        approvedPlanVersion: 1,
        discussion: { text: '', updatedAt: 1000 }
      },
      // 1B: 客厅群聊发起的方案项目
      {
        id: 't_c1_group_origin',
        title: '群聊发起方案项目',
        goal: '完成乘法',
        participantIds: ['agent_coordinator', 'agent_worker'],
        tasks: [{ id: 'task_1b', title: '乘法开发', assigneeId: 'agent_worker', status: 'todo' }],
        plan: { version: 1, status: 'approved', conversationId: 'conv_living_room' },
        stage: 'in_progress',
        approvedPlanVersion: 1,
        origin: { conversationId: 'conv_living_room', agentId: 'agent_coordinator' },
        discussion: { text: '', updatedAt: 1000 }
      },
      // 1C: 已有明确合法协调者私聊来源
      {
        id: 't_c1_direct_origin',
        title: '明确私聊来源项目',
        goal: '完成除法',
        participantIds: ['agent_coordinator', 'agent_worker'],
        tasks: [{ id: 'task_1c', title: '除法开发', assigneeId: 'agent_worker', status: 'todo' }],
        plan: { version: 1, status: 'approved', conversationId: 'conv_living_room' },
        stage: 'in_progress',
        approvedPlanVersion: 1,
        origin: { conversationId: 'conv_coordinator_custom', agentId: 'agent_coordinator' },
        discussion: { text: '', updatedAt: 1000 }
      }
    ]
  });

  const broker1 = new BridgeBroker({
    dir: path.join(tmpRoot, 'b1'),
    getData: store1.getData,
    mutateTickets: store1.mutateTickets
  });
  await broker1.start();
  broker1.register({ agentId: 'agent_worker', executorId: 'pi', workspace: workerDir });
  const coordToken1 = broker1.sessions.get('coordinator').token;
  const workerSession1 = broker1.sessions.get('agent_worker');

  // 执行并内部审核 1A
  broker1.scheduleCoordinatorWork('t_c1_no_origin');
  const claim1A = await postHttp(broker1.url, '/v1/bridge/claim', workerSession1.token, { capabilities: { kinds: ['work'] } }, { 'x-agent-id': 'agent_worker', 'x-executor-id': 'pi' });
  const addPath = path.join(workerDir, 'add.mjs');
  fs.writeFileSync(addPath, 'export function add() {}\n', 'utf8');
  await postHttp(broker1.url, '/v1/bridge/report', workerSession1.token, {
    jobId: claim1A.body.job.jobId,
    attemptId: claim1A.body.job.attemptId,
    reportId: 'rep_' + claim1A.body.job.attemptId,
    outcome: 'submitted',
    summary: '加法完成',
    artifacts: [{ path: addPath, kind: 'file' }],
    checks: ['1 pass / 0 fail']
  }, { 'x-agent-id': 'agent_worker', 'x-executor-id': 'pi' });
  await postHttp(broker1.url, '/v1/bridge/coordinator/accept', coordToken1, { explicit: true, jobId: claim1A.body.job.jobId });

  // 执行并内部审核 1B
  broker1.scheduleCoordinatorWork('t_c1_group_origin');
  const claim1B = await postHttp(broker1.url, '/v1/bridge/claim', workerSession1.token, { capabilities: { kinds: ['work'] } }, { 'x-agent-id': 'agent_worker', 'x-executor-id': 'pi' });
  await postHttp(broker1.url, '/v1/bridge/report', workerSession1.token, {
    jobId: claim1B.body.job.jobId,
    attemptId: claim1B.body.job.attemptId,
    reportId: 'rep_' + claim1B.body.job.attemptId,
    outcome: 'submitted',
    summary: '乘法完成',
    artifacts: [{ path: addPath, kind: 'file' }],
    checks: ['1 pass / 0 fail']
  }, { 'x-agent-id': 'agent_worker', 'x-executor-id': 'pi' });
  await postHttp(broker1.url, '/v1/bridge/coordinator/accept', coordToken1, { explicit: true, jobId: claim1B.body.job.jobId });

  // 执行并内部审核 1C
  broker1.scheduleCoordinatorWork('t_c1_direct_origin');
  const claim1C = await postHttp(broker1.url, '/v1/bridge/claim', workerSession1.token, { capabilities: { kinds: ['work'] } }, { 'x-agent-id': 'agent_worker', 'x-executor-id': 'pi' });
  await postHttp(broker1.url, '/v1/bridge/report', workerSession1.token, {
    jobId: claim1C.body.job.jobId,
    attemptId: claim1C.body.job.attemptId,
    reportId: 'rep_' + claim1C.body.job.attemptId,
    outcome: 'submitted',
    summary: '除法完成',
    artifacts: [{ path: addPath, kind: 'file' }],
    checks: ['1 pass / 0 fail']
  }, { 'x-agent-id': 'agent_worker', 'x-executor-id': 'pi' });
  await postHttp(broker1.url, '/v1/bridge/coordinator/accept', coordToken1, { explicit: true, jobId: claim1C.body.job.jobId });

  await new Promise(r => setTimeout(r, 100));

  const state1 = store1.read();
  assert.equal(state1.tickets.find(t => t.id === 't_c1_no_origin').stage, 'pending_user_acceptance');
  assert.equal(state1.tickets.find(t => t.id === 't_c1_group_origin').stage, 'pending_user_acceptance');
  assert.equal(state1.tickets.find(t => t.id === 't_c1_direct_origin').stage, 'pending_user_acceptance');

  // 验证会话路由：
  // 1A(无 origin) -> 默认协调者私聊 conv_coordinator_direct
  // 1B(群聊发起) -> 契约协调者私聊 conv_coordinator_direct
  // 1C(已有私聊) -> 沿用绑定 conv_coordinator_custom
  const msgsDefaultDirect = state1.messages.filter(m => m.conversationId === 'conv_coordinator_direct');
  const msgsCustomDirect = state1.messages.filter(m => m.conversationId === 'conv_coordinator_custom');
  const msgsLivingRoom = state1.messages.filter(m => m.conversationId === 'conv_living_room' && m.text.includes('最终验收'));

  assert.equal(msgsDefaultDirect.length, 2, '无 origin 与群聊发起项目均准确发往协调者默认私聊');
  assert.equal(msgsCustomDirect.length, 1, '已有明确私聊来源项目沿用既有绑定');
  assert.equal(msgsLivingRoom.length, 0, '客厅群聊绝不得泄露任何私人验收通知');
  console.log('✔ Case 1: 正常内部审核交接与目标会话精准路由通过');
  result.cases.push({ name: 'internal_accept_conversation_routing', pass: true });
  await broker1.stop();

  // =========================================================================
  // Case 2: 真实启动先后顺序（先 Broker，后通道就绪，无未处理拒绝，就绪后成功补偿）
  // =========================================================================
  console.log('--- 运行 Case 2: 真实启动先后顺序与无未处理拒绝、就绪后补偿 ---');
  const store2File = path.join(tmpRoot, 'store2.json');
  const control2 = { ready: false, failNotice: false, failStage: false };
  const store2 = createIsolatedFileStore(store2File, {
    version: 1,
    agents: baseAgents,
    conversations: baseConversations,
    messages: [],
    tickets: [{
      id: 'ticket_case2_stale',
      title: '历史全done遗留项目',
      goal: '加法功能',
      participantIds: ['agent_coordinator', 'agent_worker'],
      tasks: [{ id: 'task_c2', status: 'done', assigneeId: 'agent_worker' }],
      plan: { version: 1, status: 'approved', conversationId: 'conv_living_room' },
      stage: 'in_progress', // 停滞在 in_progress
      approvedPlanVersion: 1,
      discussion: { text: '', updatedAt: 1000 }
    }]
  }, control2);

  const initialUnhandledCount = unhandledRejections.length;

  const broker2 = new BridgeBroker({
    dir: path.join(tmpRoot, 'b2'),
    getData: store2.getData,
    mutateTickets: store2.mutateTickets
  });

  // 1. Broker 先启动，此时通道未就绪（control2.ready = false）
  await broker2.start();
  await new Promise(r => setTimeout(r, 60));

  // 提取真实的 main.cjs 中的 IPC 注册与就绪接线
  const mainSrc = fs.readFileSync(path.join(workspaceRoot, 'electron/main.cjs'), 'utf8');
  const vm = require('node:vm');
  let onLoadHandler = null;
  let onAuthorityReadyHandler = null;
  const mockIpcMain = {
    handle: (channel, fn) => {
      if (channel === 'data:load') onLoadHandler = fn;
      if (channel === 'authority:ready') onAuthorityReadyHandler = fn;
    },
    on: (channel, fn) => {
      if (channel === 'authority:ready' && !onAuthorityReadyHandler) onAuthorityReadyHandler = fn;
    }
  };
  const startLoad = mainSrc.indexOf("  ipcMain.handle('data:load'");
  const endLoad = mainSrc.indexOf("\n  });", startLoad) + 7;
  const startAuth = mainSrc.indexOf("  ipcMain.on('authority:ready'");
  const endAuth = mainSrc.indexOf("\n  });", mainSrc.indexOf("  ipcMain.handle('authority:ready'")) + 7;

  vm.runInNewContext(mainSrc.slice(startLoad, endLoad), {
    ipcMain: mockIpcMain,
    senderOk: () => true,
    store: { read: () => ({ ok: true, state: 'ok', raw: JSON.stringify(store2.read()) }) },
    bridgeBroker: broker2
  });
  vm.runInNewContext(mainSrc.slice(startAuth, endAuth), {
    ipcMain: mockIpcMain,
    senderOk: () => true,
    bridgeBroker: broker2,
    reject: () => ({ ok: false })
  });

  // 2. 模拟渲染器首步发出 data:load（此时未完成 hydrate，readyRef.current = false）
  assert.ok(typeof onLoadHandler === 'function', 'main.cjs 必须配置 data:load 处理器');
  await onLoadHandler({});
  await new Promise(r => setTimeout(r, 60));

  // 验证：就绪前不假报成功，工单仍为 in_progress，消息为 0，0 未捕获拒绝
  const state2Before = store2.read();
  assert.equal(state2Before.tickets[0].stage, 'in_progress', '通道未就绪前不得假报完成');
  assert.equal(state2Before.messages.length, 0);
  assert.equal(unhandledRejections.length, initialUnhandledCount, '启动阶段通道未就绪严禁产生任何未捕获 Promise 拒绝');

  // 3. 通道真正就绪（渲染器完成 hydrate，readyRef.current = true，发出 authority:ready IPC 信号）
  control2.ready = true;
  assert.ok(typeof onAuthorityReadyHandler === 'function', 'main.cjs 必须配置 authority:ready 就绪处理器');
  await onAuthorityReadyHandler({});
  await new Promise(r => setTimeout(r, 60));

  // 4. 验证：工单成功落盘为 pending_user_acceptance，且私聊保存一条通知
  const state2After = store2.read();
  assert.equal(state2After.tickets[0].stage, 'pending_user_acceptance', '真实主进程 authority:ready 处理器触发后，工单真实落盘为 pending_user_acceptance');
  assert.equal(state2After.messages.filter(m => m.conversationId === 'conv_coordinator_direct').length, 1);
  console.log('✔ Case 2: 真实启动顺序验证通过：0 未处理拒绝，就绪后经真实主进程接线安全自愈并持久化');
  result.cases.push({ name: 'startup_order_and_graceful_recovery', pass: true });
  await broker2.stop();

  // =========================================================================
  // Case 2B: 已批准未完成任务的启动恢复与补偿调度能力（验证不退化）
  // =========================================================================
  console.log('--- 运行 Case 2B: 已批准未完成任务的启动恢复与补偿调度 ---');
  const store2BFile = path.join(tmpRoot, 'store2B.json');
  const worker2BDir = path.join(tmpRoot, 'worker2B');
  fs.mkdirSync(worker2BDir, { recursive: true });
  const store2B = createIsolatedFileStore(store2BFile, {
    version: 1,
    agents: baseAgents,
    conversations: baseConversations,
    messages: [],
    tickets: [{
      id: 'ticket_case2b_unfinished',
      title: '未完成已批准任务启动补偿',
      participantIds: ['agent_coordinator', 'agent_worker'],
      tasks: [{ id: 'task_c2b_todo', status: 'todo', assigneeId: 'agent_worker' }],
      plan: { version: 1, status: 'approved', conversationId: 'conv_living_room' },
      stage: 'in_progress',
      approvedPlanVersion: 1,
      discussion: { text: '', updatedAt: 1000 }
    }]
  });
  const broker2B = new BridgeBroker({
    dir: path.join(tmpRoot, 'b2b'),
    getData: store2B.getData,
    mutateTickets: store2B.mutateTickets
  });
  broker2B.data.registrations.agent_worker = {
    agentId: 'agent_worker',
    executorId: 'pi',
    workspace: worker2BDir,
    chatEnabled: false
  };
  await broker2B.start();
  await new Promise(r => setTimeout(r, 60));
  const queuedWork2B = broker2B.data.jobs.filter(j => j.kind === 'work' && j.state === 'queued');
  assert.equal(queuedWork2B.length, 1, '启动补偿必须为已批准未完成的 todo 任务创建 1 个 queued work，严禁调度能力退化');
  console.log('✔ Case 2B: 已批准未完成任务启动补偿验证通过：queued work = 1，调度能力无退化');
  result.cases.push({ name: 'approved_unfinished_startup_recovery', queuedWork: queuedWork2B.length, pass: true });
  await broker2B.stop();

  // =========================================================================
  // Case 3: 状态失败与消息失败分别模拟后恢复，真实持久化事实判定与防重
  // =========================================================================
  console.log('--- 运行 Case 3: 状态失败与消息失败分别模拟后恢复与防重 ---');
  const store3File = path.join(tmpRoot, 'store3.json');
  const control3 = { ready: true, failStage: true, failNotice: false };
  const store3 = createIsolatedFileStore(store3File, {
    version: 1,
    agents: baseAgents,
    conversations: baseConversations,
    messages: [],
    tickets: [{
      id: 'ticket_case3_fail_sim',
      title: '失败恢复模拟项目',
      tasks: [{ id: 'task_c3', status: 'done', assigneeId: 'agent_worker' }],
      plan: { version: 1, status: 'approved', conversationId: 'conv_living_room' },
      stage: 'in_progress',
      approvedPlanVersion: 1,
      discussion: { text: '', updatedAt: 1000 }
    }]
  }, control3);

  const broker3 = new BridgeBroker({
    dir: path.join(tmpRoot, 'b3'),
    getData: store3.getData,
    mutateTickets: store3.mutateTickets
  });
  await broker3.start();

  // 3A: 模拟状态写入失败（failStage = true）
  const res3A = await broker3.checkOriginReport('ticket_case3_fail_sim');
  assert.equal(res3A.ok, false);
  assert.equal(store3.read().tickets[0].stage, 'in_progress', '状态保存失败保留 in_progress');
  assert.equal(store3.read().messages.length, 0);

  // 恢复状态保存能力，但模拟私聊消息保存失败（failStage = false, failNotice = true）
  control3.failStage = false;
  control3.failNotice = true;
  const res3B = await broker3.checkOriginReport('ticket_case3_fail_sim');
  assert.equal(res3B.ok, false);
  const state3B = store3.read();
  assert.equal(state3B.tickets[0].stage, 'pending_user_acceptance', '状态已流转为 pending_user_acceptance');
  assert.equal(state3B.messages.length, 0, '通知写入失败，消息库中为 0');
  assert.equal(broker3.data.reportedTicketOrigins.includes('ticket_case3_fail_sim'), false, '消息写入失败绝对不得记录为已通知');

  // 恢复通知保存能力（failNotice = false）并再次交接
  control3.failNotice = false;
  const res3C = await broker3.checkOriginReport('ticket_case3_fail_sim');
  assert.equal(res3C.ok, true);
  const state3C = store3.read();
  assert.equal(state3C.messages.filter(m => m.conversationId === 'conv_coordinator_direct').length, 1, '恢复后私聊消息成功落盘');
  assert.equal(broker3.data.reportedTicketOrigins.includes('ticket_case3_fail_sim'), true, '真实消息落盘后才记录已通知');

  // 再次调用与重启测试幂等性与防重
  await broker3.checkOriginReport('ticket_case3_fail_sim');
  await broker3.stop();

  const broker3Restart = new BridgeBroker({
    dir: path.join(tmpRoot, 'b3'),
    getData: store3.getData,
    mutateTickets: store3.mutateTickets
  });
  await broker3Restart.start();
  await broker3Restart.recoverPendingHandoffs();

  const state3Final = store3.read();
  assert.equal(state3Final.messages.filter(m => m.conversationId === 'conv_coordinator_direct').length, 1, '重启及重复检查后消息条数严格恒等于 1，0 重复通知');
  console.log('✔ Case 3: 状态与消息失败分别模拟后安全恢复，真实事实判定与防重验证通过');
  result.cases.push({ name: 'failure_recovery_and_persistence_fact', pass: true });
  await broker3Restart.stop();

  // =========================================================================
  // Case 4: 存在 chatEnabled=true 的协调者注册，覆盖异步 chat 成功与失败回退
  // =========================================================================
  console.log('--- 运行 Case 4: chatEnabled=true 异步 chat 成功与失败回退覆盖 ---');
  const store4File = path.join(tmpRoot, 'store4.json');
  const store4 = createIsolatedFileStore(store4File, {
    version: 1,
    agents: baseAgents,
    conversations: baseConversations,
    messages: [],
    tickets: [
      {
        id: 't_chat_success',
        title: 'Chat成功测试工单',
        tasks: [{ id: 'tk_s', status: 'todo', assigneeId: 'agent_worker' }],
        plan: { version: 1, status: 'approved', conversationId: 'conv_living_room' },
        stage: 'in_progress',
        approvedPlanVersion: 1,
        discussion: { text: '', updatedAt: 1000 }
      },
      {
        id: 't_chat_fail_fallback',
        title: 'Chat失败回退测试工单',
        tasks: [{ id: 'tk_f', status: 'todo', assigneeId: 'agent_worker' }],
        plan: { version: 1, status: 'approved', conversationId: 'conv_living_room' },
        stage: 'in_progress',
        approvedPlanVersion: 1,
        discussion: { text: '', updatedAt: 1000 }
      }
    ]
  });

  const broker4 = new BridgeBroker({
    dir: path.join(tmpRoot, 'b4'),
    getData: store4.getData,
    mutateTickets: store4.mutateTickets
  });
  await broker4.start();

  // 注册协调者客户端并启用 chatEnabled
  broker4.register({ agentId: 'agent_coordinator', executorId: 'pi', workspace: workerDir });
  broker4.enableChat('agent_coordinator', true);

  // 4A: 任务完成，协调者客户端正常通过 /v1/bridge/report 返回生成的亲切回复
  const s4DataA = store4.read();
  s4DataA.tickets.find(t => t.id === 't_chat_success').tasks[0].status = 'done';
  store4.write(s4DataA);

  const p4A = broker4.checkOriginReport('t_chat_success');
  // 等待 chat 任务生成排队
  const startWaitA = Date.now();
  while (!broker4.data.jobs.some(j => j.agentId === 'agent_coordinator' && j.kind === 'chat' && j.state === 'queued') && Date.now() - startWaitA < 2000) {
    await new Promise(r => setTimeout(r, 10));
  }
  // 模拟客户端认领 chat 任务并提交
  const gavSession = broker4.sessions.get('agent_coordinator');
  const claimChatA = await postHttp(broker4.url, '/v1/bridge/claim', gavSession.token, { capabilities: { kinds: ['chat'] } }, { 'x-agent-id': 'agent_coordinator', 'x-executor-id': 'pi' });
  assert.equal(claimChatA.status, 200);
  assert.ok(claimChatA.body.job);
  await postHttp(broker4.url, '/v1/bridge/report', gavSession.token, {
    jobId: claimChatA.body.job.jobId,
    attemptId: claimChatA.body.job.attemptId,
    reportId: 'rep_chat_a',
    outcome: 'submitted',
    summary: '使用者，我是协调者。项目内部自检已经全过啦，快来工作台看看成果做最终验收吧～',
    artifacts: [],
    checks: []
  }, { 'x-agent-id': 'agent_coordinator', 'x-executor-id': 'pi' });
  await p4A;

  const msg4A = store4.read().messages.find(m => m.requestId === 'rep_pub_t_chat_success');
  assert.ok(msg4A);
  assert.ok(msg4A.text.includes('我是协调者'), 'Chat 成功时必须采用模型生成的温暖文本');

  // 4B: 任务完成，模拟协调者客户端失败（outcome = failed），测试安全回退到交付摘要
  const s4DataB = store4.read();
  s4DataB.tickets.find(t => t.id === 't_chat_fail_fallback').tasks[0].status = 'done';
  store4.write(s4DataB);

  const p4B = broker4.checkOriginReport('t_chat_fail_fallback');
  // 等待 chat 任务生成排队
  const startWaitB = Date.now();
  while (!broker4.data.jobs.some(j => j.agentId === 'agent_coordinator' && j.kind === 'chat' && j.state === 'queued') && Date.now() - startWaitB < 2000) {
    await new Promise(r => setTimeout(r, 10));
  }
  const claimChatB = await postHttp(broker4.url, '/v1/bridge/claim', gavSession.token, { capabilities: { kinds: ['chat'] } }, { 'x-agent-id': 'agent_coordinator', 'x-executor-id': 'pi' });
  assert.equal(claimChatB.status, 200);
  assert.ok(claimChatB.body.job);
  await postHttp(broker4.url, '/v1/bridge/report', gavSession.token, {
    jobId: claimChatB.body.job.jobId,
    attemptId: claimChatB.body.job.attemptId,
    reportId: 'rep_chat_b',
    outcome: 'failed',
    summary: '模型网络超时',
    artifacts: [],
    checks: []
  }, { 'x-agent-id': 'agent_coordinator', 'x-executor-id': 'pi' });
  await p4B;

  const msg4B = store4.read().messages.find(m => m.requestId === 'rep_pub_t_chat_fail_fallback');
  assert.ok(msg4B);
  assert.ok(msg4B.text.includes('协调者内部审核：已通过。当前等待使用者在工作台进行最终验收'), 'Chat 失败时安全回退至标准交付摘要');
  console.log('✔ Case 4: chatEnabled 异步生成成功与失败安全回退均通过');
  result.cases.push({ name: 'chat_enabled_async_and_fallback', pass: true });
  await broker4.stop();

  // =========================================================================
  // Case 5: 边界防御与最终用户验收确认闭环
  // =========================================================================
  console.log('--- 运行 Case 5: 边界防御与最终用户验收确认闭环 ---');
  const store5File = path.join(tmpRoot, 'store5.json');
  const store5 = createIsolatedFileStore(store5File, {
    version: 1,
    agents: baseAgents,
    conversations: baseConversations,
    messages: [],
    tickets: [
      {
        id: 't_draft_defense',
        title: '未批准方案',
        tasks: [{ id: 'tk_d', status: 'done', assigneeId: 'agent_worker' }],
        plan: { version: 1, status: 'draft' },
        stage: 'draft',
        discussion: { text: '', updatedAt: 1000 }
      },
      {
        id: 't_incomplete_defense',
        title: '未全完成工单',
        tasks: [
          { id: 'tk_i1', status: 'done', assigneeId: 'agent_worker' },
          { id: 'tk_i2', status: 'doing', assigneeId: 'agent_worker' }
        ],
        plan: { version: 1, status: 'approved' },
        stage: 'in_progress',
        approvedPlanVersion: 1,
        discussion: { text: '', updatedAt: 1000 }
      },
      {
        id: 't_user_accept_target',
        title: '待用户最终验收项目',
        tasks: [{ id: 'tk_done', status: 'done', assigneeId: 'agent_worker' }],
        plan: { version: 1, status: 'approved' },
        stage: 'pending_user_acceptance',
        approvedPlanVersion: 1,
        originReported: true,
        discussion: { text: '', updatedAt: 1000 }
      }
    ]
  });

  const broker5 = new BridgeBroker({
    dir: path.join(tmpRoot, 'b5'),
    getData: store5.getData,
    mutateTickets: store5.mutateTickets
  });
  await broker5.start();
  const coordToken5 = broker5.sessions.get('coordinator').token;

  // 5A: 未批准与未完成严禁交接
  await broker5.checkOriginReport('t_draft_defense');
  assert.equal(store5.read().tickets.find(t => t.id === 't_draft_defense').stage, 'draft');

  await broker5.checkOriginReport('t_incomplete_defense');
  assert.equal(store5.read().tickets.find(t => t.id === 't_incomplete_defense').stage, 'in_progress');

  // 5B: 协调者/模型令牌调用 user-accept 严格报 403
  const forbiddenRes = await postHttp(broker5.url, '/v1/bridge/coordinator/user-accept', coordToken5, { ticketId: 't_user_accept_target' });
  assert.equal(forbiddenRes.status, 403, '模型或协调者令牌无权代表人类最终验收');

  // 5C: 使用者在工作台明确确认最终验收
  const userAcceptRes = await broker5.userAcceptProject({
    ticketId: 't_user_accept_target',
    explicit: true,
    feedback: '验收通过，非常满意！'
  });
  assert.equal(userAcceptRes.ok, true);
  assert.equal(userAcceptRes.stage, 'completed');

  const finalTicket = store5.read().tickets.find(t => t.id === 't_user_accept_target');
  assert.equal(finalTicket.stage, 'completed');
  assert.equal(finalTicket.userAcceptedBy, 'user');
  assert.ok(typeof finalTicket.userAcceptedAt === 'number');
  assert.equal(finalTicket.userFeedback, '验收通过，非常满意！');
  console.log('✔ Case 5: 边界防御与最终用户验收确认闭环验证通过');
  result.cases.push({ name: 'boundary_defense_and_user_accept_closure', pass: true });
  await broker5.stop();

  // 最终确认未捕获 Promise rejection 数量为 0
  assert.equal(unhandledRejections.length, 0, '全流程严禁出现任何未捕获 Promise rejection');

  fs.rmSync(tmpRoot, { recursive: true, force: true });

  const evidenceDir = path.resolve(__dirname, '../../../.local/pi-acceptance');
  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.writeFileSync(path.join(evidenceDir, '78-handoff-convergence-result.json'), JSON.stringify(result, null, 2));

  console.log('--- 工单78全量收口场景 100% 验证通过 ---');
}

run().catch(err => {
  console.error('工单78复验失败:', err);
  process.exitCode = 1;
});
