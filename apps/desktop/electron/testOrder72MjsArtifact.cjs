const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { BridgeBroker } = require('./bridgeBroker.cjs');

const result = {
  at: new Date().toISOString(),
  order: 'Order 72 - Coordinator MJS Artifact Inspection & Security Boundaries Verification',
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

async function run() {
  console.log('--- 开始工单72工作台审核读取 .mjs 产物独立复验 ---');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'luma-order72-'));
  const brokerDir = path.join(tmpDir, 'broker');
  const workerDir = path.join(tmpDir, 'worker-work');
  fs.mkdirSync(brokerDir, { recursive: true });
  fs.mkdirSync(workerDir, { recursive: true });

  const data = {
    version: 1,
    agents: [
      { id: 'agent_owner', name: '使用者', kind: 'human', connected: true },
      { id: 'agent_coordinator', name: '协调者', kind: 'ai', connected: true, profileId: 'p_coordinator', systemPrompt: '协调者' },
      { id: 'agent_kiro', name: '执行助手', kind: 'ai', connected: true, profileId: 'p_kiro', systemPrompt: 'Researcher' }
    ],
    conversations: [
      { id: 'conv_living_room', kind: 'living-room', createdAt: 1000 }
    ],
    messages: [],
    tickets: []
  };

  const broker = new BridgeBroker({
    dir: brokerDir,
    getData: () => data,
    mutateTickets: async (cmd) => {
      if (cmd.operation === 'create-ticket') {
        data.tickets.push(cmd.ticket);
      } else if (cmd.operation === 'approve-plan') {
        const t = data.tickets.find(x => x.id === cmd.ticketId);
        if (t) {
          t.stage = 'in_progress';
          if (t.plan) t.plan.status = 'approved';
          t.approvedPlanVersion = cmd.planVersion;
        }
      }
      return { ok: true, applied: true };
    }
  });
  await broker.start();

  // 1. 注册工作客户端并获取协调者凭据
  broker.register({ agentId: 'agent_kiro', executorId: 'pi', workspace: workerDir });
  const manifestPath = broker.issueCoordinator();
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const coordToken = fs.readFileSync(manifest.tokenFile, 'utf8').trim();

  // 2. 创建已批准工单并派发
  const ticketId = 'ticket_workbench_acceptance_20261023_642274';
  const taskId = 'task_add_service';
  await broker.createTicket({
    schemaVersion: 1,
    explicit: true,
    requestId: 'req_create_72',
    ticketId,
    title: '受控测试',
    goal: '实现加法并测试',
    tasks: [{ id: taskId, title: '加法功能', assigneeId: 'agent_kiro', acceptance: '通过测试' }],
    plan: {
      version: 1,
      title: '加法方案',
      goal: '实现加法并测试',
      status: 'draft',
      conversationId: 'conv_living_room',
      tasks: [{ id: taskId, title: '加法功能', assigneeId: 'agent_kiro', acceptance: '通过测试' }]
    },
    origin: { conversationId: 'conv_living_room', agentId: 'agent_coordinator', requestId: 'orig_72' }
  });
  const resApprove = await broker.approvePlan({ ticketId, planVersion: 1, explicit: true });
  assert.equal(resApprove.scheduled, 1, '点击开工成功派发工单任务');

  // 3. Worker 认领、上报 started 并准备产物
  const workerSession = broker.sessions.get('agent_kiro');
  const claimRes = await postHttp(broker.url, '/v1/bridge/claim', workerSession.token, {
    schemaVersion: 1,
    requestId: 'req_claim_72',
    capabilities: { kinds: ['work'] }
  }, { 'x-agent-id': 'agent_kiro', 'x-executor-id': 'pi' });
  assert.equal(claimRes.status, 200);
  const job = claimRes.body.job;
  assert.ok(job);
  assert.equal(job.taskId, taskId);

  // 写入真实测试产物文件（模拟真实复现目录）
  const addMjsPath = path.join(workerDir, 'add.mjs');
  const addTestMjsPath = path.join(workerDir, 'add.test.mjs');
  const resultMdPath = path.join(workerDir, 'RESULT.md');
  const unsubmittedMjsPath = path.join(workerDir, 'secret_unsubmitted.mjs');
  const forbiddenExtPath = path.join(workerDir, 'malicious.exe');

  fs.writeFileSync(addMjsPath, 'export function add(a, b) { return a + b; }\n', 'utf8');
  fs.writeFileSync(addTestMjsPath, "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from './add.mjs';\ntest('adds numbers', () => assert.equal(add(1, 2), 3));\n", 'utf8');
  fs.writeFileSync(resultMdPath, '# 验收测试结果\n测试已通过，退出码 0。\n', 'utf8');
  fs.writeFileSync(unsubmittedMjsPath, 'export const secret = 42;\n', 'utf8');
  fs.writeFileSync(forbiddenExtPath, 'MZ fake binary', 'utf8');

  // Worker 提交报告（提交 add.mjs, add.test.mjs, RESULT.md, forbiddenExtPath）
  const reportRes = await postHttp(broker.url, '/v1/bridge/report', workerSession.token, {
    schemaVersion: 1,
    jobId: job.jobId,
    attemptId: job.attemptId,
    reportId: 'rep_' + job.attemptId,
    outcome: 'submitted',
    summary: '加法功能与测试代码已就绪',
    artifacts: [
      { path: addMjsPath, kind: 'file', description: '加法实现' },
      { path: addTestMjsPath, kind: 'file', description: '单元测试' },
      { path: resultMdPath, kind: 'file', description: '执行结果' },
      { path: forbiddenExtPath, kind: 'file', description: '禁止的二进制产物' }
    ],
    checks: ['1 pass / 0 fail'],
    unknowns: []
  }, { 'x-agent-id': 'agent_kiro', 'x-executor-id': 'pi' });
  if (reportRes.status !== 200) console.log('reportRes debug:', JSON.stringify(reportRes));
  assert.equal(reportRes.status, 200, 'Worker 报告提交成功');

  // 4. 验证 1: 协调者成功读取批准目录内已提交的 .mjs 产物（add.mjs）
  const readAddMjs = await postHttp(broker.url, '/v1/bridge/coordinator/artifact', coordToken, {
    jobId: job.jobId,
    path: addMjsPath
  });
  assert.equal(readAddMjs.status, 200, '读取 add.mjs 必须返回 200');
  assert.equal(readAddMjs.body.ok, true);
  assert.equal(readAddMjs.body.path, addMjsPath);
  assert.ok(readAddMjs.body.text.includes('export function add(a, b)'));
  console.log('✔ Case 1: 协调者成功读取已提交的 add.mjs 源码产物');
  result.cases.push({ name: 'read_add_mjs_success', status: readAddMjs.status, pass: true });

  // 5. 验证 2: 协调者成功读取批准目录内已提交的 .test.mjs 产物（add.test.mjs）
  const readAddTestMjs = await postHttp(broker.url, '/v1/bridge/coordinator/artifact', coordToken, {
    jobId: job.jobId,
    path: addTestMjsPath
  });
  assert.equal(readAddTestMjs.status, 200, '读取 add.test.mjs 必须返回 200');
  assert.equal(readAddTestMjs.body.ok, true);
  assert.equal(readAddTestMjs.body.path, addTestMjsPath);
  assert.ok(readAddTestMjs.body.text.includes("test('adds numbers'"));
  console.log('✔ Case 2: 协调者成功读取已提交的 add.test.mjs 测试产物');
  result.cases.push({ name: 'read_add_test_mjs_success', status: readAddTestMjs.status, pass: true });

  // 6. 验证 3: 已有的 .md 产物读取能力保持正常
  const readResultMd = await postHttp(broker.url, '/v1/bridge/coordinator/artifact', coordToken, {
    jobId: job.jobId,
    path: resultMdPath
  });
  assert.equal(readResultMd.status, 200, '读取 RESULT.md 必须返回 200');
  assert.equal(readResultMd.body.ok, true);
  assert.ok(readResultMd.body.text.includes('验收测试结果'));
  console.log('✔ Case 3: 既有 RESULT.md 正常读取保持不变');
  result.cases.push({ name: 'read_result_md_success', status: readResultMd.status, pass: true });

  // 7. 验证 4: 未提交的 .mjs 产物严格拒绝（403 forbidden）
  const readUnsubmitted = await postHttp(broker.url, '/v1/bridge/coordinator/artifact', coordToken, {
    jobId: job.jobId,
    path: unsubmittedMjsPath
  });
  assert.equal(readUnsubmitted.status, 403, '未提交的 .mjs 产物必须返回 403');
  console.log('✔ Case 4: 未在 report 中声明提交的 .mjs 严格拒绝 (403)');
  result.cases.push({ name: 'unsubmitted_mjs_rejected_403', status: readUnsubmitted.status, pass: true });

  // 8. 验证 5: 工作区目录外部的 .mjs 文件严格拒绝（403 forbidden）
  const outsideMjsPath = path.join(tmpDir, 'outside.mjs');
  fs.writeFileSync(outsideMjsPath, 'export const outside = true;\n', 'utf8');
  const readOutside = await postHttp(broker.url, '/v1/bridge/coordinator/artifact', coordToken, {
    jobId: job.jobId,
    path: outsideMjsPath
  });
  assert.equal(readOutside.status, 403, '目录外的 .mjs 产物必须返回 403');
  console.log('✔ Case 5: 工作区目录外的 .mjs 严格拒绝 (403)');
  result.cases.push({ name: 'outside_workspace_mjs_rejected_403', status: readOutside.status, pass: true });

  // 9. 验证 6: 原本禁止的非文本白名单扩展名仍严格拒绝（403 forbidden）
  const readForbidden = await postHttp(broker.url, '/v1/bridge/coordinator/artifact', coordToken, {
    jobId: job.jobId,
    path: forbiddenExtPath
  });
  assert.equal(readForbidden.status, 403, '禁止扩展名必须返回 403');
  console.log('✔ Case 6: 非白名单扩展名 (.exe) 即使提交也严格拒绝 (403)');
  result.cases.push({ name: 'forbidden_extension_rejected_403', status: readForbidden.status, pass: true });

  await broker.stop();
  fs.rmSync(tmpDir, { recursive: true, force: true });

  const evidenceDir = path.resolve(__dirname, '../../../.local/pi-acceptance');
  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.writeFileSync(path.join(evidenceDir, '72-mjs-artifact-result.json'), JSON.stringify(result, null, 2));

  console.log('--- 工单72全量复验场景 100% 验证通过 ---');
}

run().catch(err => {
  console.error('复验异常中断:', err);
  process.exitCode = 1;
});
