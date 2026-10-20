'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { BridgeBroker } = require('./bridgeBroker.cjs');
const { DataStore } = require('./dataStore.cjs');

async function setupTestEnvironment(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luma-dispatch-test-'));
  const work = path.join(dir, 'work');
  fs.mkdirSync(work, { recursive: true });

  const data = {
    version: 1,
    agents: [
      { id: 'agent_owner', name: '使用者', initial: 'Z', kind: 'human', connected: true, accent: '#fff', statusNote: '' },
      { id: 'agent_coordinator', name: '协调者', initial: 'G', kind: 'ai', connected: true, accent: '#fff', statusNote: '', profileId: 'p_coordinator', systemPrompt: '协调者' },
      { id: 'agent_kiro', name: 'Researcher', initial: 'R', kind: 'ai', connected: true, accent: '#fff', statusNote: '', profileId: 'p_kiro', systemPrompt: 'Researcher' },
      { id: 'agent_editor', name: '编辑助手', initial: 'L', kind: 'ai', connected: true, accent: '#fff', statusNote: '', profileId: 'p_antigravity', systemPrompt: '编辑助手' }
    ],
    conversations: [
      { id: 'conv_living_room', title: '小屋客厅', kind: 'living-room', agentId: null, createdAt: 1000 },
      { id: 'conv_kiro_direct', title: 'Researcher私聊', kind: 'direct', agentId: 'agent_kiro', createdAt: 1000 },
      { id: 'conv_coordinator_direct', title: '协调者私聊', kind: 'direct', agentId: 'agent_coordinator', createdAt: 1000 },
      { id: 'conv_antigravity_direct', title: '编辑助手私聊', kind: 'direct', agentId: 'agent_editor', createdAt: 1000 }
    ],
    activeConversationId: 'conv_kiro_direct',
    messages: [
      { id: 'm1', conversationId: 'conv_kiro_direct', agentId: 'agent_owner', text: '哥你去修一下桌面打包', createdAt: 1000, status: 'sent', demo: false, requestId: null }
    ],
    tickets: [],
    preferences: { theme: 'day' }
  };

  const store = new DataStore(dir);
  store.beginSession('test');
  let revision = 0;
  await store.save(JSON.stringify(data), ++revision, 'test');
  const read = () => JSON.parse(store.read().raw);

  const mutation = async command => {
    const d = read();
    if (command.operation === 'create-ticket') {
      d.tickets.push(command.ticket);
    } else if (command.operation === 'reject-review') {
      const ticket = d.tickets.find(t => t.id === command.ticketId);
      if (ticket) {
        const task = ticket.tasks.find(t => t.id === command.taskId);
        if (task) task.status = 'todo';
        ticket.reviewDecisions = [...(ticket.reviewDecisions || []), { ...command.decision, jobId: command.jobId, taskId: command.taskId }];
      }
    } else if (command.operation === 'ticket-origin-reported') {
      const ticket = d.tickets.find(t => t.id === command.ticketId);
      if (ticket) {
        ticket.originReported = true;
      }
    } else if (command.type === 'companion-message') {
      const m = command.message;
      if (!d.messages.some(x => x.id === m.id)) {
        d.messages.push(m);
      }
    }
    return store.save(JSON.stringify(d), ++revision, 'test');
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

  const regKiro = broker.register({ agentId: 'agent_kiro', executorId: 'kiro', workspace: work });
  const regDesktopAgent = broker.register({ agentId: 'agent_editor', executorId: 'antigravity-adapter', workspace: work });
  const kiroToken = fs.readFileSync(JSON.parse(fs.readFileSync(regKiro.manifestPath, 'utf8')).tokenFile, 'utf8');
  const coordToken = fs.readFileSync(JSON.parse(fs.readFileSync(broker.issueCoordinator(), 'utf8')).tokenFile, 'utf8');

  return { broker, store, read, work, kiroToken, coordToken, convKiro: 'conv_kiro_direct', convLiving: 'conv_living_room', convCoordinator: 'conv_coordinator_direct', convDesktopAgent: 'conv_antigravity_direct', dir, mutation, updateData: async fn => { const d = read(); fn(d); return store.save(JSON.stringify(d), ++revision, 'test'); } };
}

async function waitForMessage(read, conversationId, agentId, timeout = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const list = read().messages.filter(m => m.conversationId === conversationId && m.agentId === agentId);
    if (list.length > 0) return list;
    await new Promise(r => setTimeout(r, 20));
  }
  return read().messages.filter(m => m.conversationId === conversationId && m.agentId === agentId);
}

test('1. Tag recognition, stripping from private chat text, and living-room dispatch with request ID', async t => {
  const { broker, read, convKiro, convLiving } = await setupTestEnvironment(t);

  const rawReply = '好，我去客厅叫协调者开单。\n[[去客厅:修复桌面打包预检脚本]]';
  const result = broker.processDispatchSignal(rawReply, {
    conversationId: convKiro,
    agentId: 'agent_kiro',
    requestId: 'req_turn_01',
    isUserInitiated: true
  });
  if (result.promise) await result.promise;

  assert.equal(result.dispatched, true);
  assert.equal(result.summary, '修复桌面打包预检脚本');
  assert.equal(result.cleanedText, '好，我去客厅叫协调者开单。');
  assert.ok(result.requestId.startsWith('req_disp_'));

  // 待开单请求已持久记录在 broker 数据中
  assert.equal(broker.data.pendingDispatches.length, 1);
  const pending = broker.data.pendingDispatches[0];
  assert.equal(pending.summary, '修复桌面打包预检脚本');
  assert.equal(pending.fromConversationId, convKiro);
  assert.equal(pending.fromAgentId, 'agent_kiro');
  assert.equal(pending.requestedBy, '使用者');
  assert.equal(pending.requestId, result.requestId);

  // 客厅收到一条以 agent_kiro 发出的消息
  const currentMessages = read().messages;
  const livingMsg = currentMessages.find(m => m.conversationId === convLiving && m.agentId === 'agent_kiro');
  assert.ok(livingMsg, 'Living room should receive a message from agent_kiro');
  assert.ok(livingMsg.text.includes('@协调者 使用者在私聊里让我修：修复桌面打包预检脚本，麻烦开个单给我。'));
  assert.ok(livingMsg.text.includes(result.requestId), 'Living room message must contain the dispatch requestId');
});

test('2. Ordinary private replies without tag have no side effects', async t => {
  const { broker, read, convKiro, convLiving } = await setupTestEnvironment(t);

  const normalReply = '今天天气不错，下午一起喝杯咖啡吧。';
  const result = broker.processDispatchSignal(normalReply, {
    conversationId: convKiro,
    agentId: 'agent_kiro',
    requestId: 'req_turn_normal',
    isUserInitiated: true
  });

  assert.equal(result.dispatched, false);
  assert.equal(result.summary, null);
  assert.equal(result.cleanedText, normalReply);
  assert.equal(broker.data.pendingDispatches.length, 0);

  const currentMessages = read().messages;
  const livingMsg = currentMessages.find(m => m.conversationId === convLiving && m.agentId === 'agent_kiro');
  assert.equal(livingMsg, undefined, 'No living room message should be sent for ordinary chat');
});

test('3. Strict constraints: rate limiting (max 3 per 10min), non-user initiated rejection, disable switch', async t => {
  const { broker, convKiro } = await setupTestEnvironment(t);

  // 1) 非使用者发起（心跳/自主/群聊发言等）不识别
  const nonUserRes = broker.processDispatchSignal('[[去客厅:偷跑任务]]', {
    conversationId: convKiro,
    agentId: 'agent_kiro',
    requestId: 'req_auto_1',
    isUserInitiated: false
  });
  assert.equal(nonUserRes.dispatched, false);
  assert.equal(nonUserRes.reason, 'not_user_initiated');

  // 2) 非白名单 executor 不识别
  const otherAgentRes = broker.processDispatchSignal('[[去客厅:别人来喊]]', {
    conversationId: convKiro,
    agentId: 'agent_coordinator',
    requestId: 'req_other_1',
    isUserInitiated: true
  });
  assert.equal(otherAgentRes.dispatched, false);
  assert.equal(otherAgentRes.reason, 'unauthorized_executor');

  // 3) 限流：10 分钟最多 3 次
  const r1 = broker.processDispatchSignal('[[去客厅:第1次]]', { conversationId: convKiro, agentId: 'agent_kiro', requestId: 'req_rate_1', isUserInitiated: true });
  const r2 = broker.processDispatchSignal('[[去客厅:第2次]]', { conversationId: convKiro, agentId: 'agent_kiro', requestId: 'req_rate_2', isUserInitiated: true });
  const r3 = broker.processDispatchSignal('[[去客厅:第3次]]', { conversationId: convKiro, agentId: 'agent_kiro', requestId: 'req_rate_3', isUserInitiated: true });
  assert.equal(r1.dispatched, true);
  assert.equal(r2.dispatched, true);
  assert.equal(r3.dispatched, true);

  // 第 4 次应被限流拒绝
  const r4 = broker.processDispatchSignal('[[去客厅:第4次超限]]', { conversationId: convKiro, agentId: 'agent_kiro', requestId: 'req_rate_4', isUserInitiated: true });
  assert.equal(r4.dispatched, false);
  assert.equal(r4.reason, 'rate_limited');

  // 4) 一键关闭开关
  broker.setDispatchChannelEnabled(false);
  const disabledRes = broker.processDispatchSignal('[[去客厅:开关关了还要去]]', {
    conversationId: convKiro,
    agentId: 'agent_kiro',
    requestId: 'req_dis_1',
    isUserInitiated: true
  });
  assert.equal(disabledRes.dispatched, false);
  assert.equal(disabledRes.reason, 'channel_disabled');
});

test('4. createTicket supports optional origin and associates pending dispatch request', async t => {
  const { broker, read, convKiro } = await setupTestEnvironment(t);

  // 先记录一条待开单请求
  const res = broker.processDispatchSignal('好，我去客厅。\n[[去客厅:修改测试用例]]', {
    conversationId: convKiro,
    agentId: 'agent_kiro',
    requestId: 'req_turn_for_ticket',
    isUserInitiated: true
  });

  // 协调者带 origin 开单
  const createWithOrigin = {
    schemaVersion: 1,
    explicit: true,
    requestId: 'req_create_with_origin',
    ticketId: 'ticket_origin_1',
    title: '修改测试用例工单',
    goal: '把测试用例全跑通',
    origin: { requestId: res.requestId },
    tasks: [{ id: 'task_origin_1', title: '执行测试修复', assigneeId: 'agent_kiro', acceptance: '全绿' }]
  };

  const created = await broker.createTicket(createWithOrigin);
  assert.equal(created.ok, true);

  const storedTicket = read().tickets.find(tk => tk.id === 'ticket_origin_1');
  assert.ok(storedTicket);
  assert.deepEqual(storedTicket.origin, {
    conversationId: convKiro,
    agentId: 'agent_kiro',
    requestId: res.requestId
  });

  // 协调者不带 origin 开老工单，行为完全不受影响
  const createLegacy = {
    schemaVersion: 1,
    explicit: true,
    requestId: 'req_create_legacy',
    ticketId: 'ticket_legacy_1',
    title: '普通老工单',
    goal: '老流程无 origin',
    tasks: [{ id: 'task_legacy_1', title: '日常维护', assigneeId: 'agent_kiro', acceptance: '通过' }]
  };
  const legacyCreated = await broker.createTicket(createLegacy);
  assert.equal(legacyCreated.ok, true);
  const storedLegacy = read().tickets.find(tk => tk.id === 'ticket_legacy_1');
  assert.equal(storedLegacy.origin, undefined);

  // 传不存在的 origin.requestId 报错
  await assert.rejects(
    () => broker.createTicket({
      schemaVersion: 1,
      explicit: true,
      requestId: 'req_create_bad_origin',
      ticketId: 'ticket_bad_1',
      title: '错误来源工单',
      goal: '找不到来源',
      origin: { requestId: 'non_existent_req_id' },
      tasks: [{ id: 'task_bad_1', title: '任务', assigneeId: 'agent_kiro', acceptance: '通过' }]
    }),
    /未找到匹配的待开单请求/
  );
});

test('5. Acceptance triggers private chat report with path & token sanitization, rejection does not report, idempotent single report', async t => {
  const { broker, read, work, convKiro } = await setupTestEnvironment(t);

  // 1) 建立带 origin 的工单
  broker.data.pendingDispatches.push({
    requestId: 'req_disp_test_5',
    fromConversationId: convKiro,
    fromAgentId: 'agent_kiro',
    requestedBy: '使用者',
    summary: '修复内存泄露问题',
    createdAt: Date.now()
  });

  const ticketId = 'ticket_e2e_report';
  const taskId = 'task_e2e_report';
  await broker.createTicket({
    schemaVersion: 1,
    explicit: true,
    requestId: 'create_e2e_5',
    ticketId,
    title: '修复内存泄露问题',
    goal: '修复内存泄露并完成全链路验证',
    origin: { requestId: 'req_disp_test_5' },
    tasks: [{ id: taskId, title: '检查并修复内存引用', assigneeId: 'agent_kiro', acceptance: '测试通过' }]
  });

  // 2) 派发任务
  const dispatchRes = broker.dispatch({ ticketId, taskId, requestId: 'disp_job_5' });
  assert.equal(dispatchRes.ok, true);
  const job = broker.data.jobs.find(j => j.jobId === dispatchRes.jobId);
  job.attemptId = 'att_1';
  job.state = 'doing';

  // 3) 提交第一次交付报告（含敏感路径和密钥）
  const testArtifact = path.join(work, 'leak-fix.patch');
  fs.writeFileSync(testArtifact, 'diff content');
  job.report = {
    reportId: 'rep_1',
    outcome: 'submitted',
    summary: `已在路径 C:\\Users\\example-user\\secret-project\\app.js 修复泄露，通行令牌为 Bearer abcdef1234567890abcdef。`,
    artifacts: [{ path: testArtifact }],
    checks: ['内存测试跑通', '静态扫描无告警'],
    unknowns: ['弱网环境未做实测']
  };
  job.state = 'review';

  // 4) 协调者第一次审查：退回（rejectReview）
  const rejectRes = await broker.rejectReview({
    schemaVersion: 1,
    explicit: true,
    requestId: 'review_reject_1',
    jobId: job.jobId,
    attemptId: 'att_1',
    reportId: 'rep_1',
    reason: '还需要补充弱网测试数据'
  });
  assert.equal(rejectRes.ok, true);

  // 验证：退回时不回私聊！
  let messagesAfterReject = read().messages.filter(m => m.conversationId === convKiro && m.agentId === 'agent_kiro');
  assert.equal(messagesAfterReject.length, 0, 'No report should be sent to private chat on rejection');

  // 5) 重新派发并完成
  const dispatchRes2 = broker.dispatch({ ticketId, taskId, requestId: 'disp_job_5_round2' });
  const job2 = broker.data.jobs.find(j => j.jobId === dispatchRes2.jobId);
  job2.attemptId = 'att_2';
  job2.state = 'review';
  job2.report = {
    reportId: 'rep_2',
    outcome: 'submitted',
    summary: `弱网实测完成，耗时正常。修改文件位于 D:\\workspace\\internal\\network.js，临时鉴权 token="sk-secret1234567890abcdef"。`,
    artifacts: [{ path: testArtifact }],
    checks: ['全套测试 100% 通过'],
    unknowns: []
  };

  // 6) 协调者验收通过（accept）
  const acceptRes = broker.accept(job2.jobId);
  assert.equal(acceptRes.ok, true);
  assert.equal(job2.state, 'done');

  // 等待异步回报完成
  const messagesAfterAccept = await waitForMessage(read, convKiro, 'agent_kiro');
  assert.equal(messagesAfterAccept.length, 1, 'Exactly one report message should be sent to private chat');
  const reportMsg = messagesAfterAccept[0];
  assert.ok(reportMsg.text.includes('使用者，之前你让我修的事已经弄好啦'));
  assert.ok(reportMsg.text.includes('修复内存泄露问题'));
  assert.ok(reportMsg.text.includes('全套测试 100% 通过'));
  assert.ok(reportMsg.text.includes('协调者已经验收通过'));

  // 8) 验证敏感路径和令牌已被彻底脱敏
  assert.equal(reportMsg.text.includes(process.cwd()), false, 'Absolute paths must not leak');
  assert.equal(reportMsg.text.includes('sk-secret1234567890abcdef'), false, 'Secret tokens must not leak');
  assert.ok(reportMsg.text.includes('[受保护路径]') || reportMsg.text.includes('token=[已脱敏]'), 'Sanitization marker should be present');

  // 9) 验证去重：再次触发 checkOriginReport 不会重复回报
  await broker.checkOriginReport(ticketId);
  await new Promise(resolve => setTimeout(resolve, 50));
  const messagesDouble = read().messages.filter(m => m.conversationId === convKiro && m.agentId === 'agent_kiro');
  assert.equal(messagesDouble.length, 1, 'Origin report must be idempotent (sent at most once)');
});

test('6. Worker (agent_editor) tag recognition and living-room dispatch', async t => {
  const { broker, read, convDesktopAgent, convLiving } = await setupTestEnvironment(t);

  const rawReply = '收到，使用者！这个交互动效我去找协调者开单。\n[[去客厅:优化首屏转场动效]]';
  const result = broker.processDispatchSignal(rawReply, {
    conversationId: convDesktopAgent,
    agentId: 'agent_editor',
    requestId: 'req_antigravity_01',
    isUserInitiated: true
  });
  if (result.promise) await result.promise;

  assert.equal(result.dispatched, true);
  assert.equal(result.summary, '优化首屏转场动效');
  assert.equal(result.cleanedText, '收到，使用者！这个交互动效我去找协调者开单。');

  assert.equal(broker.data.pendingDispatches.length, 1);
  const pending = broker.data.pendingDispatches[0];
  assert.equal(pending.summary, '优化首屏转场动效');
  assert.equal(pending.fromConversationId, convDesktopAgent);
  assert.equal(pending.fromAgentId, 'agent_editor');

  const livingMsg = read().messages.find(m => m.conversationId === convLiving && m.agentId === 'agent_editor');
  assert.ok(livingMsg, 'Living room should receive message from agent_editor');
  assert.ok(livingMsg.text.includes('@协调者 使用者在私聊里让我修：优化首屏转场动效'));
});

test('7. Coordinator direct private ticket creation without dispatch tag and returns report to Coordinator private chat', async t => {
  const { broker, read, convCoordinator, work } = await setupTestEnvironment(t);

  const ticketId = 'ticket_coordinator_direct_01';
  const taskId = 'task_coordinator_direct_01';

  // 协调者直接通过 createTicket 开单，origin 填他和使用者的私聊 conversationId
  const createRes = await broker.createTicket({
    schemaVersion: 1,
    explicit: true,
    requestId: 'create_coordinator_direct_01',
    ticketId,
    title: '调整私聊背景质感',
    goal: '为使用者定制私聊视觉效果',
    origin: { conversationId: convCoordinator },
    tasks: [{ id: taskId, title: '调整 CSS 变量与阴影', assigneeId: 'agent_kiro', acceptance: '视觉验收通过' }]
  });
  assert.equal(createRes.ok, true);

  const savedTicket = read().tickets.find(t => t.id === ticketId);
  assert.ok(savedTicket);
  assert.equal(savedTicket.origin.conversationId, convCoordinator);
  assert.equal(savedTicket.origin.agentId, 'agent_coordinator');
  assert.ok(savedTicket.origin.requestId.startsWith('req_direct_'));

  // 派发并完成
  const dispatchRes = broker.dispatch({ ticketId, taskId, requestId: 'disp_coordinator_1' });
  const job = broker.data.jobs.find(j => j.jobId === dispatchRes.jobId);
  job.attemptId = 'att_gav_1';
  job.state = 'review';
  job.report = {
    reportId: 'rep_gav_1',
    outcome: 'submitted',
    summary: '已更新私聊背景毛玻璃与阴影细节。',
    artifacts: [],
    checks: ['样式检查无冲突'],
    unknowns: []
  };

  const acceptRes = broker.accept(job.jobId);
  assert.equal(acceptRes.ok, true);
  const coordinatorMessages = await waitForMessage(read, convCoordinator, 'agent_coordinator');

  // 验证回报发送到了协调者私聊 convCoordinator，发送者为 agent_coordinator
  assert.equal(coordinatorMessages.length, 1);
  assert.ok(coordinatorMessages[0].text.includes('调整私聊背景质感'));
  assert.ok(coordinatorMessages[0].text.includes('已更新私聊背景毛玻璃与阴影细节'));
});

test('8. Origin reported persistence and no repeated report after broker restart', async t => {
  const { broker, read, convKiro, work, dir, mutation } = await setupTestEnvironment(t);

  const ticketId = 'ticket_restart_test';
  const taskId = 'task_restart_test';
  broker.data.pendingDispatches.push({
    requestId: 'req_disp_restart',
    fromConversationId: convKiro,
    fromAgentId: 'agent_kiro',
    requestedBy: '使用者',
    summary: '测试重启不重复回报',
    createdAt: Date.now()
  });

  await broker.createTicket({
    schemaVersion: 1,
    explicit: true,
    requestId: 'create_restart_test',
    ticketId,
    title: '测试重启不重复回报',
    goal: '验证持久化落盘与重启幂等',
    origin: { requestId: 'req_disp_restart' },
    tasks: [{ id: taskId, title: '持久化落盘验证', assigneeId: 'agent_kiro', acceptance: '单测通过' }]
  });

  const dispatchRes = broker.dispatch({ ticketId, taskId, requestId: 'disp_restart_1' });
  const job = broker.data.jobs.find(j => j.jobId === dispatchRes.jobId);
  job.attemptId = 'att_rst_1';
  job.state = 'review';
  job.report = {
    reportId: 'rep_rst_1',
    outcome: 'submitted',
    summary: '测试任务执行完毕。',
    artifacts: [],
    checks: ['测试全部通过'],
    unknowns: []
  };

  broker.accept(job.jobId);
  const messagesBefore = await waitForMessage(read, convKiro, 'agent_kiro');

  // 验证第一次汇报已发出
  assert.equal(messagesBefore.length, 1);

  // 验证磁盘上 ticket.originReported 已经通过 applyTicketMutation 落盘为 true
  const ticketOnDisk = read().tickets.find(t => t.id === ticketId);
  assert.equal(ticketOnDisk.originReported, true, 'ticket.originReported must be persisted to store');

  // 模拟重启：关闭当前 broker，实例化全新 Broker
  if (broker.server) broker.server.close();
  const restartedBroker = new BridgeBroker({
    dir: path.join(dir, 'broker_restarted'),
    getData: read,
    mutateTickets: mutation
  });
  await restartedBroker.start();
  t.after(() => {
    if (restartedBroker.server) restartedBroker.server.close();
  });

  // 再次触发 checkOriginReport
  await restartedBroker.checkOriginReport(ticketId);
  await new Promise(resolve => setTimeout(resolve, 50));

  const messagesAfter = read().messages.filter(m => m.conversationId === convKiro && m.agentId === 'agent_kiro');
  assert.equal(messagesAfter.length, 1, 'No duplicate report message after broker restart');
});

test('9. finishChat does not trigger living-room dispatch during non-user or originReport turns', async t => {
  const { broker, convKiro } = await setupTestEnvironment(t);

  broker.enableChat('agent_kiro', true);

  // 模拟 originReport 轮次或 isUserInitiated 为 false 的聊天任务
  const turn = broker.chat({
    targetAgentId: 'agent_kiro',
    conversationId: convKiro,
    requestId: 'req_system_report_round',
    currentText: '系统汇报回合',
    isUserInitiated: false,
    originReport: true
  });

  const job = broker.data.jobs.find(j => j.jobId === turn.jobId);
  assert.equal(job.isUserInitiated, false);
  assert.equal(job.originReport, true);

  // 客户端提交包含 [[去客厅:...]] 的输出
  broker.finishChat(job, {
    outcome: 'submitted',
    summary: '已向使用者汇报完毕。[[去客厅:不该被派发的二次指令]]'
  });

  const reply = await turn.promise;
  assert.equal(reply, '已向使用者汇报完毕。');
  assert.equal(broker.data.pendingDispatches.length, 0, 'Must not dispatch to living room on system/report turn');
});

test('10. [[客厅传话:...]] tag recognition, stripping from private chat, and relaying verbatim without ticket', async t => {
  const { broker, read, convKiro, convLiving } = await setupTestEnvironment(t);

  const rawReply = '好的使用者，我这就去客厅问大家！\n[[客厅传话:大家晚上想吃什么呀？使用者问咱们要不要点夜宵]]';
  const result = broker.processDispatchSignal(rawReply, {
    conversationId: convKiro,
    agentId: 'agent_kiro',
    requestId: 'req_relay_01',
    isUserInitiated: true
  });
  if (result.promise) await result.promise;

  assert.equal(result.relayed, true);
  assert.equal(result.signalType, 'relay');
  assert.equal(result.relayText, '大家晚上想吃什么呀？使用者问咱们要不要点夜宵');
  assert.equal(result.cleanedText, '好的使用者，我这就去客厅问大家！');

  // 不建工单！
  assert.equal(broker.data.pendingDispatches.length, 0, 'Relay must not create any work ticket');

  // 客厅收到一条以 agent_kiro 名义原样发出的消息（不带@协调者或开单前缀）
  const livingMessages = read().messages.filter(m => m.conversationId === convLiving && m.agentId === 'agent_kiro');
  assert.equal(livingMessages.length, 1);
  assert.equal(livingMessages[0].text, '大家晚上想吃什么呀？使用者问咱们要不要点夜宵');
});

test('11. Worker (agent_editor) [[客厅传话:...]] verbatim relay', async t => {
  const { broker, read, convDesktopAgent, convLiving } = await setupTestEnvironment(t);

  const rawReply = '收到使用者！我去喊大伙一声。\n[[客厅传话:使用者设计的新主题已经上线啦，大家快去看看！]]';
  const result = broker.processDispatchSignal(rawReply, {
    conversationId: convDesktopAgent,
    agentId: 'agent_editor',
    requestId: 'req_antigravity_relay_01',
    isUserInitiated: true
  });
  if (result.promise) await result.promise;

  assert.equal(result.relayed, true);
  assert.equal(result.signalType, 'relay');
  assert.equal(result.cleanedText, '收到使用者！我去喊大伙一声。');
  assert.equal(broker.data.pendingDispatches.length, 0);

  const livingMsg = read().messages.find(m => m.conversationId === convLiving && m.agentId === 'agent_editor');
  assert.ok(livingMsg);
  assert.equal(livingMsg.text, '使用者设计的新主题已经上线啦，大家快去看看！');
});

test('12. [[客厅传话:...]] obeys strict rules: user-initiated only, rate limiting (shared 3 per 10min), disable switch', async t => {
  const { broker, convKiro } = await setupTestEnvironment(t);

  // 1) 非使用者发起拒绝
  const nonUserRes = broker.processDispatchSignal('[[客厅传话:偷偷传话]]', {
    conversationId: convKiro,
    agentId: 'agent_kiro',
    requestId: 'req_auto_relay',
    isUserInitiated: false
  });
  assert.equal(nonUserRes.relayed, false);
  assert.equal(nonUserRes.reason, 'not_user_initiated');

  // 2) 共享限流：10分钟最多 3 次（包含去客厅和客厅传话）
  const r1 = broker.processDispatchSignal('[[去客厅:第1次开单]]', { conversationId: convKiro, agentId: 'agent_kiro', requestId: 'req_mix_1', isUserInitiated: true });
  const r2 = broker.processDispatchSignal('[[客厅传话:第2次传话]]', { conversationId: convKiro, agentId: 'agent_kiro', requestId: 'req_mix_2', isUserInitiated: true });
  const r3 = broker.processDispatchSignal('[[客厅传话:第3次传话]]', { conversationId: convKiro, agentId: 'agent_kiro', requestId: 'req_mix_3', isUserInitiated: true });
  const r4 = broker.processDispatchSignal('[[客厅传话:超限传话]]', { conversationId: convKiro, agentId: 'agent_kiro', requestId: 'req_mix_4', isUserInitiated: true });
  assert.equal(r1.dispatched, true);
  assert.equal(r2.relayed, true);
  assert.equal(r3.relayed, true);
  assert.equal(r4.relayed, false);
  assert.equal(r4.reason, 'rate_limited');

  // 3) 通道关闭时拒绝
  broker.data.dispatchChannelEnabled = false;
  const disabledRes = broker.processDispatchSignal('[[客厅传话:停用测试]]', { conversationId: convKiro, agentId: 'agent_kiro', requestId: 'req_dis_relay', isUserInitiated: true });
  assert.equal(disabledRes.relayed, false);
  assert.equal(disabledRes.reason, 'channel_disabled');
});

test('13. Dispatch tags recognize random dynamic agentId registered with kiro or antigravity-adapter', async t => {
  const { broker, read, convLiving, work, updateData } = await setupTestEnvironment(t);

  const randomKiroAgentId = 'agent_worker_research';
  const randomDesktopAgentAgentId = 'agent_worker_editor';
  const convRandomKiro = 'conv_dm_muso4jav2bjvg9';
  const convRandomDesktopAgent = 'conv_dm_mus9go8v4gbhcj';

  // 将新成员和会话持久化到 store
  await updateData(d => {
    d.agents.push(
      { id: randomKiroAgentId, name: 'Researcher真机', initial: 'R', kind: 'ai', connected: true, accent: '#fff', statusNote: '', profileId: 'p_rk', systemPrompt: 'Researcher' },
      { id: randomDesktopAgentAgentId, name: '编辑助手真机', initial: 'L', kind: 'ai', connected: true, accent: '#fff', statusNote: '', profileId: 'p_rl', systemPrompt: '编辑助手' }
    );
    d.conversations.push(
      { id: convRandomKiro, kind: 'direct', agentId: randomKiroAgentId, title: 'Researcher私聊', createdAt: 1000 },
      { id: convRandomDesktopAgent, kind: 'direct', agentId: randomDesktopAgentAgentId, title: '编辑助手私聊', createdAt: 1000 }
    );
  });

  // 按 executorId 登记
  broker.register({ agentId: randomKiroAgentId, executorId: 'kiro', workspace: work });
  broker.register({ agentId: randomDesktopAgentAgentId, executorId: 'antigravity-adapter', workspace: work });

  // 1) 随机 Kiro 成员触发开单
  const res1 = broker.processDispatchSignal('好的！\n[[去客厅:修复真机白名单问题]]', {
    conversationId: convRandomKiro,
    agentId: randomKiroAgentId,
    requestId: 'req_random_1',
    isUserInitiated: true
  });
  if (res1.promise) await res1.promise;
  assert.equal(res1.dispatched, true);
  assert.equal(res1.summary, '修复真机白名单问题');
  assert.equal(res1.cleanedText, '好的！');
  assert.equal(broker.data.pendingDispatches[0].fromAgentId, randomKiroAgentId);

  // 2) 随机 编辑助手 成员触发传话
  const res2 = broker.processDispatchSignal('收到使用者！\n[[客厅传话:编辑助手向大伙问好啦]]', {
    conversationId: convRandomDesktopAgent,
    agentId: randomDesktopAgentAgentId,
    requestId: 'req_random_2',
    isUserInitiated: true
  });
  if (res2.promise) await res2.promise;
  assert.equal(res2.relayed, true);
  assert.equal(res2.relayText, '编辑助手向大伙问好啦');
  assert.equal(res2.cleanedText, '收到使用者！');

  const livingMsg = read().messages.find(m => m.conversationId === convLiving && m.agentId === randomDesktopAgentAgentId);
  assert.ok(livingMsg);
  assert.equal(livingMsg.text, '编辑助手向大伙问好啦');
});

test('14. finishChat always strips [[去客厅:...]] and [[客厅传话:...]] from private chat text, even for unauthorized executors or when channel is disabled', async t => {
  const { broker, convKiro } = await setupTestEnvironment(t);

  broker.enableChat('agent_kiro', true);

  // 场景 A：非白名单 executor（例如未注册客户端的 agent_unregistered）
  const unregJob = {
    jobId: 'chat_unreg_1',
    ticketId: convKiro,
    taskId: 'req_unreg_1',
    agentId: 'agent_unregistered',
    conversationId: convKiro,
    requestId: 'req_unreg_1',
    isUserInitiated: true,
    originReport: false
  };
  const waiterA = new Promise((resolve, reject) => broker.chatWaiters.set(unregJob.jobId, { resolve, reject }));
  broker.finishChat(unregJob, {
    outcome: 'submitted',
    summary: '这是私聊回复内容。\n[[去客厅:未授权开单]]\n[[客厅传话:未授权传话]]'
  });
  const textA = await waiterA;
  assert.equal(textA, '这是私聊回复内容。', 'Private text must not contain dispatch or relay tags for unauthorized executor');
  assert.equal(broker.data.pendingDispatches.length, 0, 'No ticket must be created for unauthorized executor');

  // 场景 B：通道已关闭（dispatchChannelEnabled = false）
  broker.data.dispatchChannelEnabled = false;
  const turnB = broker.chat({
    targetAgentId: 'agent_kiro',
    conversationId: convKiro,
    requestId: 'req_disabled_channel',
    currentText: '测试通道关闭'
  });
  const jobB = broker.data.jobs.find(j => j.jobId === turnB.jobId);
  broker.finishChat(jobB, {
    outcome: 'submitted',
    summary: '通道已关闭的回复。\n[[去客厅:通道已关闭时不应该发到客厅]]'
  });
  const textB = await turnB.promise;
  assert.equal(textB, '通道已关闭的回复。', 'Private text must not contain dispatch tag when channel is disabled');
  assert.equal(broker.data.pendingDispatches.length, 0, 'No ticket must be created when channel is disabled');
});
