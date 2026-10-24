'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const { BridgeBroker } = require('./bridgeBroker.cjs');
const { createModelForwarder } = require('./modelForwarder.cjs');
const piModule = file => require('node:url').pathToFileURL(path.join(process.env.LUMA_TEST_PI_ROOT || path.join(__dirname, '../connectors/pi'), file)).href;

test('Pi Bridge: 受控工具闭环、身份注入、事件上报与验收通过（发现4与发现6验证）', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'luma-pi-bridge-test-'));
  const brokerDir = path.join(tmpRoot, 'broker');
  const workspaceDir = path.join(tmpRoot, 'approved-workspace');
  fs.mkdirSync(workspaceDir, { recursive: true });

  const targetFile = path.join(workspaceDir, 'target.txt');
  fs.writeFileSync(targetFile, 'Luma Pi SDK 受控读取测试验证内容: Hello Pi!', 'utf8');

  let modelCallCount = 0;
  let receivedFirstPrompt = '';

  const modelForwarder = async (req, res, body, reg) => {
    modelCallCount++;
    const messages = body.messages || [];
    const lastMsg = messages[messages.length - 1];

    if (modelCallCount === 1) {
      receivedFirstPrompt = JSON.stringify(messages);
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });

    const sendSSE = (data) => {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    if (lastMsg?.role === 'tool' || lastMsg?.role === 'toolResult') {
      const summaryText = `[Pi 成果交付] 已成功受控读取文件，内容确认：${lastMsg.content}`;
      sendSSE({
        id: 'chatcmpl_' + Date.now(),
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: 'pi-default',
        choices: [{ index: 0, delta: { role: 'assistant', content: summaryText }, finish_reason: null }]
      });
      sendSSE({
        id: 'chatcmpl_' + Date.now(),
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: 'pi-default',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
      });
      res.write('data: [DONE]\n\n');
      return res.end();
    }

    sendSSE({
      id: 'chatcmpl_' + Date.now(),
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: 'pi-default',
      choices: [{
        index: 0,
        delta: {
          role: 'assistant',
          tool_calls: [{
            index: 0,
            id: 'call_read_target',
            type: 'function',
            function: { name: 'read', arguments: JSON.stringify({ path: 'target.txt' }) }
          }]
        },
        finish_reason: null
      }]
    });
    sendSSE({
      id: 'chatcmpl_' + Date.now(),
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: 'pi-default',
      choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }]
    });
    res.write('data: [DONE]\n\n');
    return res.end();
  };

  const mockData = {
    agents: [
      { id: 'agent_coordinator', name: '协调者', kind: 'ai', removed: false },
      { id: 'agent_pi_tester', name: 'Pi测试员', kind: 'ai', removed: false, profileId: 'prof_pi' }
    ],
    chatProfiles: [
      { id: 'prof_pi', name: 'Pi测试配置', developerInstructions: '【测试身份注入标记：Pi受控测试员】' }
    ],
    conversations: [
      { id: 'conv_living_room', kind: 'living-room' },
      { id: 'conv_pi_test', kind: 'direct', agentId: 'agent_pi_tester' }
    ],
    tickets: [
      {
        id: 'ticket_pi_01',
        title: 'Pi SDK 正常读取验证',
        goal: '受控读取 target.txt',
        participantIds: ['agent_coordinator', 'agent_pi_tester'],
        discussion: { text: '' },
        tasks: [
          {
            id: 'task_pi_read_01',
            title: '读取 target.txt 并汇报',
            assigneeId: 'agent_pi_tester',
            acceptance: '确认读取到内容并交付',
            status: 'todo'
          }
        ]
      }
    ],
    messages: [],
    purgedMessageIds: []
  };

  const broker = new BridgeBroker({
    dir: brokerDir,
    getData: () => mockData,
    modelForwarder
  });

  await broker.start();

  try {
    const regRes = broker.register({
      agentId: 'agent_pi_tester',
      executorId: 'pi',
      workspace: workspaceDir
    });
    assert.equal(regRes.ok, true);

    const dispRes = broker.dispatch({
      ticketId: 'ticket_pi_01',
      taskId: 'task_pi_read_01',
      requestId: 'req_pi_01'
    });
    assert.equal(dispRes.ok, true);

    const { runPiBridge } = await import(piModule('worker.mjs'));
    await runPiBridge({
      manifestPath: regRes.manifestPath,
      runOnce: true
    });

    const finishedJob = broker.snapshot().jobs.find((j) => j.jobId === dispRes.jobId);
    assert.equal(finishedJob.state, 'review');
    assert.ok(finishedJob.report);
    assert.equal(finishedJob.report.outcome, 'submitted');
    assert.match(finishedJob.report.summary, /Hello Pi!/);

    // 验证事件规范（发现6）：至少包含受控工具调用事件
    assert.ok(finishedJob.events.some((e) => e.summary && e.summary.includes('read')));

    // 验证身份与上下文注入（发现4）：模型必须收到 developerInstructions
    assert.match(receivedFirstPrompt, /Pi受控测试员/);

    // 验证协调者验收
    const acceptRes = broker.accept(finishedJob.jobId);
    assert.equal(acceptRes.ok, true);
    assert.equal(broker.snapshot().jobs.find((j) => j.jobId === finishedJob.jobId).state, 'done');
  } finally {
    await broker.stop();
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  }
});

test('Pi Bridge: 模型失败时严格转为 failed，绝不谎报成功（发现1验证）', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'luma-pi-fail-test-'));
  const brokerDir = path.join(tmpRoot, 'broker');
  const workspaceDir = path.join(tmpRoot, 'workspace');
  fs.mkdirSync(workspaceDir, { recursive: true });

  const modelForwarder = async (req, res, body, reg) => {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: '上游模型调用模拟内部错误' } }));
  };

  const mockData = {
    agents: [
      { id: 'agent_coordinator', name: '协调者', kind: 'ai', removed: false },
      { id: 'agent_pi_fail', name: 'Pi测试员', kind: 'ai', removed: false, profileId: 'prof_pi' }
    ],
    chatProfiles: [
      { id: 'prof_pi', name: 'Pi测试配置', developerInstructions: 'Pi失败测试身份' }
    ],
    conversations: [
      { id: 'conv_living_room', kind: 'living-room' },
      { id: 'conv_pi_fail', kind: 'direct', agentId: 'agent_pi_fail' }
    ],
    tickets: [{
      id: 'ticket_fail_01',
      title: '失败测试工单',
      goal: '验证失败不虚报',
      participantIds: ['agent_coordinator', 'agent_pi_fail'],
      discussion: { text: '' },
      tasks: [{ id: 'task_fail_01', title: '必然失败的任务', assigneeId: 'agent_pi_fail', status: 'todo' }]
    }],
    messages: []
  };

  const broker = new BridgeBroker({
    dir: brokerDir,
    getData: () => mockData,
    modelForwarder
  });
  await broker.start();

  try {
    const regRes = broker.register({
      agentId: 'agent_pi_fail',
      executorId: 'pi',
      workspace: workspaceDir
    });

    const dispRes = broker.dispatch({
      ticketId: 'ticket_fail_01',
      taskId: 'task_fail_01',
      requestId: 'req_fail_01'
    });

    const { runPiBridge } = await import(piModule('worker.mjs'));
    await runPiBridge({
      manifestPath: regRes.manifestPath,
      runOnce: true
    });

    const job = broker.snapshot().jobs.find((j) => j.jobId === dispRes.jobId);
    assert.equal(job.state, 'failed');
    assert.ok(job.report);
    assert.equal(job.report.outcome, 'failed');
    assert.match(job.report.summary, /失败|错误/);
  } finally {
    await broker.stop();
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  }
});

test('Pi Bridge: 任务取消后不产生多余执行，状态流转为 cancelled（发现2验证）', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'luma-pi-cancel-test-'));
  const brokerDir = path.join(tmpRoot, 'broker');
  const workspaceDir = path.join(tmpRoot, 'workspace');
  fs.mkdirSync(workspaceDir, { recursive: true });

  let modelCalled = false;
  const modelForwarder = async (req, res, body, reg) => {
    modelCalled = true;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: [DONE]\n\n');
    res.end();
  };

  const mockData = {
    agents: [
      { id: 'agent_coordinator', name: '协调者', kind: 'ai', removed: false },
      { id: 'agent_pi_cancel', name: 'Pi测试员', kind: 'ai', removed: false, profileId: 'prof_pi' }
    ],
    chatProfiles: [
      { id: 'prof_pi', name: 'Pi测试配置', developerInstructions: 'Pi取消测试身份' }
    ],
    conversations: [
      { id: 'conv_living_room', kind: 'living-room' },
      { id: 'conv_pi_cancel', kind: 'direct', agentId: 'agent_pi_cancel' }
    ],
    tickets: [{
      id: 'ticket_cancel_01',
      title: '取消测试工单',
      goal: '验证取消状态',
      participantIds: ['agent_coordinator', 'agent_pi_cancel'],
      discussion: { text: '' },
      tasks: [{ id: 'task_cancel_01', title: '取消任务', assigneeId: 'agent_pi_cancel', status: 'todo' }]
    }],
    messages: []
  };

  const broker = new BridgeBroker({
    dir: brokerDir,
    getData: () => mockData,
    modelForwarder
  });
  await broker.start();

  try {
    const regRes = broker.register({
      agentId: 'agent_pi_cancel',
      executorId: 'pi',
      workspace: workspaceDir
    });

    const dispRes = broker.dispatch({
      ticketId: 'ticket_cancel_01',
      taskId: 'task_cancel_01',
      requestId: 'req_cancel_01'
    });

    broker.cancel(dispRes.jobId);

    const { runPiBridge } = await import(piModule('worker.mjs'));
    await runPiBridge({
      manifestPath: regRes.manifestPath,
      runOnce: true
    });

    const job = broker.snapshot().jobs.find((j) => j.jobId === dispRes.jobId);
    assert.equal(job.state, 'cancelled');
    assert.equal(modelCalled, false, '已取消的任务不应触发模型网络请求');
  } finally {
    await broker.stop();
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  }
});

test('Pi Bridge: modelForwarder 无法找到配置时返回 503 明确诊断（发现3验证）', async () => {
  const forwarder = createModelForwarder({
    getAuthoritativeData: () => ({ agents: [{ id: 'agent_none' }], chatProfiles: [] }),
    credentialsStore: { getKey: () => null }
  });

  const oldBaseUrl = process.env.LUMA_PI_MODEL_BASE_URL;
  const oldApiKey = process.env.LUMA_PI_MODEL_API_KEY;
  delete process.env.LUMA_PI_MODEL_BASE_URL;
  delete process.env.LUMA_PI_MODEL_API_KEY;

  let statusCode = 0;
  let bodyData = '';

  const mockRes = {
    writeHead(code) {
      statusCode = code;
    },
    end(str) {
      bodyData = str;
    }
  };

  try {
    await forwarder({}, mockRes, { model: 'pi-default' }, { agentId: 'agent_none' });
    assert.equal(statusCode, 503);
    const parsed = JSON.parse(bodyData);
    assert.equal(parsed.error.code, 'PROFILE_NOT_CONFIGURED');
    assert.match(parsed.error.message, /未绑定模型配置/);
  } finally {
    if (oldBaseUrl) process.env.LUMA_PI_MODEL_BASE_URL = oldBaseUrl;
    if (oldApiKey) process.env.LUMA_PI_MODEL_API_KEY = oldApiKey;
  }
});

test('Pi Bridge: 受控只读工具越界与敏感文件拦截防御验证', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'luma-pi-tools-test-'));
  const workspaceDir = path.join(tmpRoot, 'safe-workspace');
  fs.mkdirSync(workspaceDir, { recursive: true });

  const safeFile = path.join(workspaceDir, 'allowed.txt');
  fs.writeFileSync(safeFile, 'Safe content', 'utf8');

  const outsideFile = path.join(tmpRoot, 'forbidden.txt');
  fs.writeFileSync(outsideFile, 'Secret outside content', 'utf8');

  const envFile = path.join(workspaceDir, '.env');
  fs.writeFileSync(envFile, 'SECRET_KEY=123456', 'utf8');

  const { createControlledReadTool } = await import(piModule('controlled-tools.mjs'));
  const tool = createControlledReadTool(workspaceDir);

  const safeRes = await tool.execute({ path: 'allowed.txt' });
  assert.equal(safeRes.ok, true);
  assert.equal(safeRes.content, 'Safe content');

  const outsideRes = await tool.execute({ path: outsideFile });
  assert.equal(outsideRes.ok, false);
  assert.match(outsideRes.error, /越界拒绝/);

  const dotDotRes = await tool.execute({ path: '../forbidden.txt' });
  assert.equal(dotDotRes.ok, false);
  assert.match(dotDotRes.error, /越界拒绝/);

  const envRes = await tool.execute({ path: '.env' });
  assert.equal(envRes.ok, false);
  assert.match(envRes.error, /敏感保护/);

  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test('Pi Bridge: 阻塞1验证 - 双成员路由与凭据严格隔离，缺配置严禁跨成员借用', async () => {
  const upstreamRequests = [];
  const server = http.createServer((req, res) => {
    upstreamRequests.push({
      url: req.url,
      auth: req.headers['authorization']
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }));
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const baseUrlA = `http://127.0.0.1:${port}/route-a`;
  const baseUrlB = `http://127.0.0.1:${port}/route-b`;

  const mockData = {
    agents: [
      { id: 'audit_a', name: '成员A', profileId: 'prof_a' },
      { id: 'audit_b', name: '成员B', profileId: 'prof_b' },
      { id: 'audit_c', name: '成员C', profileId: null }
    ],
    chatProfiles: [
      { id: 'prof_a', baseUrl: baseUrlA, model: 'model-a', credentialRef: 'cred_a' },
      { id: 'prof_b', baseUrl: baseUrlB, model: 'model-b', credentialRef: 'cred_b' }
    ]
  };

  const mockCredStore = {
    getKey: (ref) => (ref === 'cred_a' ? 'key_for_agent_a' : ref === 'cred_b' ? 'key_for_agent_b' : null)
  };

  const oldBaseUrl = process.env.LUMA_PI_MODEL_BASE_URL;
  const oldApiKey = process.env.LUMA_PI_MODEL_API_KEY;
  delete process.env.LUMA_PI_MODEL_BASE_URL;
  delete process.env.LUMA_PI_MODEL_API_KEY;

  const forwarder = createModelForwarder({
    getAuthoritativeData: () => mockData,
    credentialsStore: mockCredStore
  });

  const makeReqRes = () => {
    let statusCode = 0;
    let data = '';
    const res = new EventEmitter();
    const req = new EventEmitter();
    res.writeHead = (code) => { statusCode = code; };
    res.write = (chunk) => { data += chunk; };
    res.end = (chunk) => { if (chunk) data += chunk; res.emit('finish'); };
    return { req, res, getResult: () => ({ statusCode, data }) };
  };

  try {
    // 1. 成员 A 调用：必须打向 /route-a 且使用 key_for_agent_a
    const { req: reqA, res: resA } = makeReqRes();
    await forwarder(reqA, resA, { model: 'pi-default' }, { agentId: 'audit_a' });
    await new Promise((r) => setTimeout(r, 60));

    assert.equal(upstreamRequests.length, 1);
    assert.equal(upstreamRequests[0].url, '/route-a/chat/completions');
    assert.equal(upstreamRequests[0].auth, 'Bearer key_for_agent_a');

    // 2. 成员 B 调用：必须打向 /route-b 且使用 key_for_agent_b
    const { req: reqB, res: resB } = makeReqRes();
    await forwarder(reqB, resB, { model: 'pi-default' }, { agentId: 'audit_b' });
    await new Promise((r) => setTimeout(r, 60));

    assert.equal(upstreamRequests.length, 2);
    assert.equal(upstreamRequests[1].url, '/route-b/chat/completions');
    assert.equal(upstreamRequests[1].auth, 'Bearer key_for_agent_b');

    // 3. 成员 C 调用：未配置 profile，必须返回 503 且拒绝，绝不借用 A 或 B
    const { req: reqC, res: resC, getResult: getResultC } = makeReqRes();
    await forwarder(reqC, resC, { model: 'pi-default' }, { agentId: 'audit_c' });
    assert.equal(getResultC().statusCode, 503);
    const parsedC = JSON.parse(getResultC().data);
    assert.equal(parsedC.error.code, 'PROFILE_NOT_CONFIGURED');
    assert.equal(upstreamRequests.length, 2, '未配置成员绝不得产生任何上游调用');
  } finally {
    server.close();
    if (oldBaseUrl) process.env.LUMA_PI_MODEL_BASE_URL = oldBaseUrl;
    if (oldApiKey) process.env.LUMA_PI_MODEL_API_KEY = oldApiKey;
  }
});

test('Pi Bridge: 阻塞2验证 - 客户端流式中途断开时，立即向上游传播并关闭连接', async () => {
  let upstreamConnectionClosed = false;
  let upstreamTimer = null;

  const sseServer = http.createServer((req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });

    res.write('data: {"chunk": 1}\n\n');

    upstreamTimer = setInterval(() => {
      if (res.writableEnded || res.destroyed) {
        clearInterval(upstreamTimer);
        return;
      }
      res.write('data: {"chunk": 2}\n\n');
    }, 50);

    req.on('close', () => {
      upstreamConnectionClosed = true;
      clearInterval(upstreamTimer);
    });
  });

  await new Promise((resolve) => sseServer.listen(0, '127.0.0.1', resolve));
  const ssePort = sseServer.address().port;

  const mockData = {
    agents: [{ id: 'agent_stream_tester', name: '流测试员', profileId: 'prof_stream' }],
    chatProfiles: [{ id: 'prof_stream', baseUrl: `http://127.0.0.1:${ssePort}`, credentialRef: 'cred_stream' }]
  };

  const oldBaseUrl = process.env.LUMA_PI_MODEL_BASE_URL;
  const oldApiKey = process.env.LUMA_PI_MODEL_API_KEY;
  delete process.env.LUMA_PI_MODEL_BASE_URL;
  delete process.env.LUMA_PI_MODEL_API_KEY;

  const forwarder = createModelForwarder({
    getAuthoritativeData: () => mockData,
    credentialsStore: { getKey: () => 'stream_key' }
  });

  const mockRes = new EventEmitter();
  mockRes.writableEnded = false;
  mockRes.writeHead = () => {};
  mockRes.write = () => {};
  mockRes.end = () => { mockRes.writableEnded = true; };

  const mockReq = new EventEmitter();

  try {
    await forwarder(mockReq, mockRes, { model: 'test' }, { agentId: 'agent_stream_tester' });

    // 等待连接建立与首块发送
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(upstreamConnectionClosed, false, '初始状态上游连接处于活跃状态');

    // 模拟客户端中途断开（例如任务取消导致 response 关闭）
    mockRes.emit('close');

    // 等待事件向传播
    await new Promise((r) => setTimeout(r, 100));

    assert.equal(upstreamConnectionClosed, true, '客户端断开后，上游连接必须立即被关闭');
  } finally {
    clearInterval(upstreamTimer);
    sseServer.close();
    if (oldBaseUrl) process.env.LUMA_PI_MODEL_BASE_URL = oldBaseUrl;
    if (oldApiKey) process.env.LUMA_PI_MODEL_API_KEY = oldApiKey;
  }
});

test('Pi Bridge: 跨文件连续读取与按 toolCallId 准确关联（验收1、2、3验证）', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'luma-pi-multifile-test-'));
  const brokerDir = path.join(tmpRoot, 'broker');
  const workspaceDir = path.join(tmpRoot, 'workspace');
  fs.mkdirSync(workspaceDir, { recursive: true });

  const fileAlpha = path.join(workspaceDir, 'file_alpha.txt');
  const fileBeta = path.join(workspaceDir, 'file_beta.txt');
  fs.writeFileSync(fileAlpha, 'Alpha content: CHECK_AAA', 'utf8');
  fs.writeFileSync(fileBeta, 'Beta content: CHECK_BBB', 'utf8');

  const modelForwarder = async (req, res, body, reg) => {
    const messages = body.messages || [];
    const toolResults = messages.filter((m) => m.role === 'tool' || m.role === 'toolResult');

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });
    const sendSSE = (d) => res.write(`data: ${JSON.stringify(d)}\n\n`);

    if (toolResults.length === 0) {
      // 第一轮：调用 read 读取 file_alpha.txt
      sendSSE({
        id: 'cmpl_1',
        choices: [{
          index: 0,
          delta: {
            role: 'assistant',
            tool_calls: [{
              index: 0,
              id: 'call_alpha_123',
              type: 'function',
              function: { name: 'read', arguments: JSON.stringify({ path: 'file_alpha.txt' }) }
            }]
          },
          finish_reason: null
        }]
      });
      sendSSE({
        id: 'cmpl_1',
        choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }]
      });
      res.write('data: [DONE]\n\n');
      return res.end();
    } else if (toolResults.length === 1) {
      // 第二轮：调用 read 读取 file_beta.txt
      sendSSE({
        id: 'cmpl_2',
        choices: [{
          index: 0,
          delta: {
            role: 'assistant',
            tool_calls: [{
              index: 0,
              id: 'call_beta_456',
              type: 'function',
              function: { name: 'read', arguments: JSON.stringify({ path: 'file_beta.txt' }) }
            }]
          },
          finish_reason: null
        }]
      });
      sendSSE({
        id: 'cmpl_2',
        choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }]
      });
      res.write('data: [DONE]\n\n');
      return res.end();
    } else {
      // 总结轮
      sendSSE({
        id: 'cmpl_3',
        choices: [{
          index: 0,
          delta: { role: 'assistant', content: '两份文件均已读取整理完毕。' },
          finish_reason: null
        }]
      });
      sendSSE({
        id: 'cmpl_3',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
      });
      res.write('data: [DONE]\n\n');
      return res.end();
    }
  };

  const mockData = {
    agents: [{ id: 'agent_pi_multi', name: 'Pi多文件测试员', kind: 'ai', removed: false, profileId: 'prof_pi' }],
    chatProfiles: [{ id: 'prof_pi', developerInstructions: '多文件测试' }],
    conversations: [
      { id: 'conv_living_room', kind: 'living-room' },
      { id: 'conv_pi_multi', kind: 'direct', agentId: 'agent_pi_multi' }
    ],
    tickets: [{
      id: 'ticket_multi_01',
      title: '多文件读取工单',
      goal: '连续读取双文件',
      participantIds: ['agent_pi_multi'],
      discussion: { text: '' },
      tasks: [{ id: 'task_multi_01', title: '双文件任务', assigneeId: 'agent_pi_multi', status: 'todo' }]
    }]
  };

  const broker = new BridgeBroker({ dir: brokerDir, getData: () => mockData, modelForwarder });
  await broker.start();

  try {
    const regRes = broker.register({ agentId: 'agent_pi_multi', executorId: 'pi', workspace: workspaceDir });
    const dispRes = broker.dispatch({ ticketId: 'ticket_multi_01', taskId: 'task_multi_01', requestId: 'req_multi_01' });

    const { runPiBridge } = await import(piModule('worker.mjs'));
    await runPiBridge({ manifestPath: regRes.manifestPath, runOnce: true });

    const job = broker.snapshot().jobs.find((j) => j.jobId === dispRes.jobId);
    assert.equal(job.state, 'review');
    assert.ok(job.report);
    assert.equal(job.report.outcome, 'submitted');

    // 1. 验证 artifacts 必须同时覆盖两份不同文件，且绝无重复或遗漏
    const artifactPaths = job.report.artifacts.map((a) => path.basename(a.path));
    assert.ok(artifactPaths.includes('file_alpha.txt'), 'artifacts 应包含 file_alpha.txt');
    assert.ok(artifactPaths.includes('file_beta.txt'), 'artifacts 应包含 file_beta.txt');
    assert.equal(new Set(artifactPaths).size, 2, '两份文件路径必须各不相同');

    // 2. 验证 checks 准确覆盖两份文件
    const checkText = job.report.checks.join('; ');
    assert.match(checkText, /file_alpha\.txt/);
    assert.match(checkText, /file_beta\.txt/);

    // 3. 验证事件中同时记录了两个不同文件的开始与完成
    const eventSummaries = job.events.map((e) => e.summary);
    assert.ok(eventSummaries.some((s) => s.includes('file_alpha.txt')), '应有 alpha 开始或完成事件');
    assert.ok(eventSummaries.some((s) => s.includes('file_beta.txt')), '应有 beta 开始或完成事件');
  } finally {
    await broker.stop();
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  }
});

test('Pi Bridge: 事件有序发送并在 report 提交前全部等待确认（验收4验证）', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'luma-pi-queue-test-'));
  const brokerDir = path.join(tmpRoot, 'broker');
  const workspaceDir = path.join(tmpRoot, 'workspace');
  fs.mkdirSync(workspaceDir, { recursive: true });

  const testFile = path.join(workspaceDir, 'queue_test.txt');
  fs.writeFileSync(testFile, 'queue test data', 'utf8');

  let round = 0;
  const modelForwarder = async (req, res, body, reg) => {
    round++;
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Connection': 'keep-alive' });
    const sendSSE = (d) => res.write(`data: ${JSON.stringify(d)}\n\n`);

    if (round === 1) {
      sendSSE({
        id: 'cmpl_q1',
        choices: [{
          index: 0,
          delta: {
            role: 'assistant',
            tool_calls: [{
              index: 0,
              id: 'call_q',
              type: 'function',
              function: { name: 'read', arguments: JSON.stringify({ path: 'queue_test.txt' }) }
            }]
          },
          finish_reason: null
        }]
      });
      sendSSE({
        id: 'cmpl_q1',
        choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }]
      });
      res.write('data: [DONE]\n\n');
      return res.end();
    } else {
      sendSSE({
        id: 'cmpl_q2',
        choices: [{
          index: 0,
          delta: { role: 'assistant', content: '队列完成。' },
          finish_reason: null
        }]
      });
      sendSSE({
        id: 'cmpl_q2',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
      });
      res.write('data: [DONE]\n\n');
      return res.end();
    }
  };

  const mockData = {
    agents: [{ id: 'agent_pi_queue', name: '队列测试员', kind: 'ai', removed: false, profileId: 'prof_pi' }],
    chatProfiles: [{ id: 'prof_pi', developerInstructions: '队列测试' }],
    conversations: [
      { id: 'conv_living_room', kind: 'living-room' },
      { id: 'conv_pi_queue', kind: 'direct', agentId: 'agent_pi_queue' }
    ],
    tickets: [{
      id: 'ticket_q_01',
      title: '队列工单',
      goal: '验证事件顺序',
      participantIds: ['agent_pi_queue'],
      discussion: { text: '' },
      tasks: [{ id: 'task_q_01', title: '队列任务', assigneeId: 'agent_pi_queue', status: 'todo' }]
    }]
  };

  const broker = new BridgeBroker({ dir: brokerDir, getData: () => mockData, modelForwarder });
  await broker.start();

  try {
    const regRes = broker.register({ agentId: 'agent_pi_queue', executorId: 'pi', workspace: workspaceDir });
    const dispRes = broker.dispatch({ ticketId: 'ticket_q_01', taskId: 'task_q_01', requestId: 'req_q_01' });

    const { runPiBridge } = await import(piModule('worker.mjs'));
    await runPiBridge({ manifestPath: regRes.manifestPath, runOnce: true });

    const job = broker.snapshot().jobs.find((j) => j.jobId === dispRes.jobId);
    assert.equal(job.state, 'review');

    // 1. 验证事件到达 Broker 的序号必须严格单调递增 [1, 2, 3...]
    assert.ok(job.events.length >= 3, '至少应收到 3 个事件');
    for (let i = 0; i < job.events.length; i++) {
      assert.equal(job.events[i].seq, i + 1, `事件序号未单调递增: 第 ${i} 项 seq 为 ${job.events[i].seq}`);
    }

    // 2. 验证所有事件在 report 形成之前已经入库
    assert.ok(job.report);
    assert.equal(job.report.outcome, 'submitted');
  } finally {
    await broker.stop();
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  }
});

test('Pi Bridge: 工单31验收 - work 模式受控新建(write)、精确编辑(edit)与读回(read)全链路闭环', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'luma-pi-work-rw-test-'));
  const brokerDir = path.join(tmpRoot, 'broker');
  const workspaceDir = path.join(tmpRoot, 'workspace');
  fs.mkdirSync(workspaceDir, { recursive: true });

  const targetRelativePath = 'checklist.md';

  let round = 0;
  const modelForwarder = async (req, res, body, reg) => {
    round++;
    const messages = body.messages || [];
    const toolResults = messages.filter((m) => m.role === 'tool' || m.role === 'toolResult');

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });
    const sendSSE = (d) => res.write(`data: ${JSON.stringify(d)}\n\n`);

    if (toolResults.length === 0) {
      // 轮次 1: 调用 write 创建 checklist.md
      sendSSE({
        id: 'cmpl_w1',
        choices: [{
          index: 0,
          delta: {
            role: 'assistant',
            tool_calls: [{
              index: 0,
              id: 'call_write_01',
              type: 'function',
              function: {
                name: 'write',
                arguments: JSON.stringify({
                  path: targetRelativePath,
                  content: '# 阅读角\n\n- 预算：180元\n- 任务：采买台灯\n- 任务：整理书架\n'
                })
              }
            }]
          },
          finish_reason: null
        }]
      });
      sendSSE({ id: 'cmpl_w1', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
      res.write('data: [DONE]\n\n');
      return res.end();
    } else if (toolResults.length === 1) {
      // 轮次 2: 调用 edit 精确把“预算：180元”改为“预算：160元”
      sendSSE({
        id: 'cmpl_w2',
        choices: [{
          index: 0,
          delta: {
            role: 'assistant',
            tool_calls: [{
              index: 0,
              id: 'call_edit_01',
              type: 'function',
              function: {
                name: 'edit',
                arguments: JSON.stringify({
                  path: targetRelativePath,
                  edits: [{ oldText: '预算：180元', newText: '预算：160元' }]
                })
              }
            }]
          },
          finish_reason: null
        }]
      });
      sendSSE({ id: 'cmpl_w2', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
      res.write('data: [DONE]\n\n');
      return res.end();
    } else if (toolResults.length === 2) {
      // 轮次 3: 调用 read 读回验证
      sendSSE({
        id: 'cmpl_w3',
        choices: [{
          index: 0,
          delta: {
            role: 'assistant',
            tool_calls: [{
              index: 0,
              id: 'call_read_01',
              type: 'function',
              function: {
                name: 'read',
                arguments: JSON.stringify({ path: targetRelativePath })
              }
            }]
          },
          finish_reason: null
        }]
      });
      sendSSE({ id: 'cmpl_w3', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
      res.write('data: [DONE]\n\n');
      return res.end();
    } else {
      // 总结交付
      sendSSE({
        id: 'cmpl_w4',
        choices: [{
          index: 0,
          delta: { role: 'assistant', content: '[执行助手工单汇报] checklist.md 已成功新建并由 180 元精确调整为 160 元，读回确认无误。' },
          finish_reason: null
        }]
      });
      sendSSE({ id: 'cmpl_w4', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
      res.write('data: [DONE]\n\n');
      return res.end();
    }
  };

  const mockData = {
    agents: [{ id: 'agent_worker', name: '执行助手', kind: 'ai', removed: false, profileId: 'prof_worker' }],
    chatProfiles: [{ id: 'prof_worker', developerInstructions: '执行助手工作助理' }],
    conversations: [
      { id: 'conv_living_room', kind: 'living-room' },
      { id: 'conv_dm_worker', kind: 'direct', agentId: 'agent_worker' }
    ],
    tickets: [{
      id: 'ticket_write_edit_01',
      title: '工单31写入编辑验证工单',
      goal: '新建 checklist.md 并精确调整预算为 160 元',
      participantIds: ['agent_worker'],
      discussion: { text: '' },
      tasks: [{
        id: 'task_we_01',
        title: '创建与编辑 checklist.md',
        assigneeId: 'agent_worker',
        status: 'todo'
      }]
    }]
  };

  const broker = new BridgeBroker({ dir: brokerDir, getData: () => mockData, modelForwarder });
  await broker.start();

  try {
    const regRes = broker.register({ agentId: 'agent_worker', executorId: 'pi', workspace: workspaceDir });
    const dispRes = broker.dispatch({
      ticketId: 'ticket_write_edit_01',
      taskId: 'task_we_01',
      requestId: 'req_we_01'
    });

    const { runPiBridge } = await import(piModule('worker.mjs'));
    await runPiBridge({ manifestPath: regRes.manifestPath, runOnce: true });

    const job = broker.snapshot().jobs.find((j) => j.jobId === dispRes.jobId);
    assert.equal(job.state, 'review');
    assert.ok(job.report);
    assert.equal(job.report.outcome, 'submitted');

    // 1. 验证目标文件在物理磁盘真实生成且内容精确一致
    const realDiskFile = path.join(workspaceDir, targetRelativePath);
    assert.ok(fs.existsSync(realDiskFile), 'checklist.md 必须在磁盘上切实存在');
    const diskContent = fs.readFileSync(realDiskFile, 'utf8');
    assert.equal(diskContent.replace(/\r\n/g, '\n'), '# 阅读角\n\n- 预算：160元\n- 任务：采买台灯\n- 任务：整理书架\n');

    // 2. 验证 artifacts 包含生成文件的物理绝对路径
    assert.ok(job.report.artifacts.some((a) => path.basename(a.path) === 'checklist.md'));

    // 3. 验证 checks 准确分类记录了新建、编辑与读取成功
    const checksText = job.report.checks.join('; ');
    assert.match(checksText, /受控新建文件成功: checklist.md/);
    assert.match(checksText, /受控精确编辑文件成功: checklist.md/);
    assert.match(checksText, /受控读取文件成功: checklist.md/);

    // 4. 验证事件流记录了完整的 write、edit 与 read
    const eventSummaries = job.events.map((e) => e.summary);
    assert.ok(eventSummaries.some((s) => s.includes('write [checklist.md]')));
    assert.ok(eventSummaries.some((s) => s.includes('edit [checklist.md]')));
    assert.ok(eventSummaries.some((s) => s.includes('read [checklist.md]')));
  } finally {
    await broker.stop();
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  }
});

test('Pi Bridge: 工单31验收与工单33加固 - 权威工单授权严格收口，非work或目录不匹配严格只读', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'luma-pi-chat-readonly-'));
  const workspaceDir = path.join(tmpRoot, 'workspace');
  fs.mkdirSync(workspaceDir, { recursive: true });

  const { PiRunner, assemblePiTaskPrompt } = await import(piModule('runner.mjs'));

  // 1. 无 packet 或 chat 模式：检查组装的提示词
  const chatPrompt = assemblePiTaskPrompt({ kind: 'chat', job: { goal: '闲聊中请求创建文件' } }, false);
  assert.match(chatPrompt, /仅开放受控的 read 工具/);
  assert.match(chatPrompt, /禁止任何形式的文件创建与修改/);

  // 2. 目录不匹配的 work packet：提示词必须判定为只读
  const mismatchedPrompt = assemblePiTaskPrompt({
    kind: 'work',
    job: { goal: '工作', workspace: process.cwd() }
  }, false);
  assert.match(mismatchedPrompt, /仅开放受控的 read 工具/);

  // 3. 工单33安全加固：缺失权威 workspace 或 job.kind 冲突时，严格降级只读
  // 验证 assemblePiTaskPrompt 均保持只读
  const missingWsPrompt = assemblePiTaskPrompt({ job: { kind: 'work' } }, false);
  assert.match(missingWsPrompt, /仅开放受控的 read 工具/);

  const conflictPrompt = assemblePiTaskPrompt({ kind: 'work', job: { kind: 'chat', workspace: workspaceDir } }, false);
  assert.match(conflictPrompt, /仅开放受控的 read 工具/);

  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test('Pi Bridge: 工单37验收 - work模式受控运行(run tool)，完成测试报错、精确修正与重跑通过闭环', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'luma-pi-run-work-'));
  const brokerDir = path.join(tmpRoot, 'broker');
  const workspaceDir = path.join(tmpRoot, 'workspace');
  fs.mkdirSync(brokerDir, { recursive: true });
  fs.mkdirSync(workspaceDir, { recursive: true });

  // 1. 准备初始文件：故意包含加法错误的代码以及包含2个断言的测试文件
  const codeFile = path.join(workspaceDir, 'add.mjs');
  const testFile = path.join(workspaceDir, 'add.test.mjs');
  fs.writeFileSync(codeFile, `export function add(a, b) {\n  return a - b;\n}\n`, 'utf8');
  fs.writeFileSync(
    testFile,
    `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from './add.mjs';\ntest('add positive numbers', () => { assert.equal(add(1, 2), 3); });\ntest('add tens', () => { assert.equal(add(10, 20), 30); });\n`,
    'utf8'
  );

  let round = 0;
  const modelForwarder = async (req, res, meta, context) => {
    round++;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });

    const sendSSE = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

    if (round === 1) {
      // 第 1 轮：模型调用 run 工具执行 node_test
      sendSSE({
        id: 'cmpl_r1',
        choices: [{
          index: 0,
          delta: {
            role: 'assistant',
            tool_calls: [{
              index: 0,
              id: 'call_run_01',
              type: 'function',
              function: {
                name: 'run',
                arguments: JSON.stringify({ action: 'node_test', target: 'add.test.mjs' })
              }
            }]
          },
          finish_reason: null
        }]
      });
      sendSSE({ id: 'cmpl_r1', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
      res.write('data: [DONE]\n\n');
      return res.end();
    } else if (round === 2) {
      // 第 2 轮：模型收到测试失败，调用 edit 工具修复代码
      sendSSE({
        id: 'cmpl_r2',
        choices: [{
          index: 0,
          delta: {
            role: 'assistant',
            tool_calls: [{
              index: 0,
              id: 'call_edit_01',
              type: 'function',
              function: {
                name: 'edit',
                arguments: JSON.stringify({
                  path: 'add.mjs',
                  edits: [{ oldText: 'return a - b;', newText: 'return a + b;' }]
                })
              }
            }]
          },
          finish_reason: null
        }]
      });
      sendSSE({ id: 'cmpl_r2', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
      res.write('data: [DONE]\n\n');
      return res.end();
    } else if (round === 3) {
      // 第 3 轮：模型调用 run 工具重新运行测试验证
      sendSSE({
        id: 'cmpl_r3',
        choices: [{
          index: 0,
          delta: {
            role: 'assistant',
            tool_calls: [{
              index: 0,
              id: 'call_run_02',
              type: 'function',
              function: {
                name: 'run',
                arguments: JSON.stringify({ action: 'node_test', target: 'add.test.mjs' })
              }
            }]
          },
          finish_reason: null
        }]
      });
      sendSSE({ id: 'cmpl_r3', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
      res.write('data: [DONE]\n\n');
      return res.end();
    } else if (round === 4) {
      // 第 4 轮：模型使用 read 读回最终文件
      sendSSE({
        id: 'cmpl_r4',
        choices: [{
          index: 0,
          delta: {
            role: 'assistant',
            tool_calls: [{
              index: 0,
              id: 'call_read_01',
              type: 'function',
              function: {
                name: 'read',
                arguments: JSON.stringify({ path: 'add.mjs' })
              }
            }]
          },
          finish_reason: null
        }]
      });
      sendSSE({ id: 'cmpl_r4', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
      res.write('data: [DONE]\n\n');
      return res.end();
    } else {
      // 第 5 轮：总结汇报交付
      sendSSE({
        id: 'cmpl_r5',
        choices: [{
          index: 0,
          delta: {
            role: 'assistant',
            content: '[执行助手工单汇报] add.mjs 中的错误实现已修复为加法，测试全部通过（2/2断言通过），读回确认无误。'
          },
          finish_reason: null
        }]
      });
      sendSSE({ id: 'cmpl_r5', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
      res.write('data: [DONE]\n\n');
      return res.end();
    }
  };

  const mockData = {
    agents: [{ id: 'agent_worker', name: '执行助手', kind: 'ai', removed: false, profileId: 'prof_worker' }],
    chatProfiles: [{ id: 'prof_worker', developerInstructions: '执行助手项目验证助理' }],
    conversations: [
      { id: 'conv_living_room', kind: 'living-room' },
      { id: 'conv_dm_worker', kind: 'direct', agentId: 'agent_worker' }
    ],
    tickets: [{
      id: 'ticket_run_01',
      title: '工单37项目运行测试闭环验证',
      goal: '运行 add.test.mjs 捕获失败，修复 add.mjs，重新测试通过并读回确认',
      participantIds: ['agent_worker'],
      discussion: { text: '' },
      tasks: [{
        id: 'task_run_01',
        title: '修复 add.mjs 并确保测试全部通过',
        assigneeId: 'agent_worker',
        status: 'todo'
      }]
    }]
  };

  const broker = new BridgeBroker({ dir: brokerDir, getData: () => mockData, modelForwarder });
  await broker.start();

  try {
    const regRes = broker.register({ agentId: 'agent_worker', executorId: 'pi', workspace: workspaceDir });
    const dispRes = broker.dispatch({
      ticketId: 'ticket_run_01',
      taskId: 'task_run_01',
      requestId: 'req_run_01'
    });

    const { runPiBridge } = await import(piModule('worker.mjs'));
    await runPiBridge({ manifestPath: regRes.manifestPath, runOnce: true });

    const job = broker.snapshot().jobs.find((j) => j.jobId === dispRes.jobId);
    assert.equal(job.state, 'review');
    assert.ok(job.report);
    assert.equal(job.report.outcome, 'submitted');

    // 1. 验证目标文件在物理磁盘上已被正确修复为 return a + b;
    const realDiskFile = path.join(workspaceDir, 'add.mjs');
    const diskContent = fs.readFileSync(realDiskFile, 'utf8');
    assert.match(diskContent, /return a \+ b;/);

    // 2. 验证 checks 准确留存了初始失败与最终成功记录（失败不被掩盖，成功如实留痕）
    const checksText = job.report.checks.join('; ');
    assert.match(checksText, /工具安全拦截\/错误 \[run:node_test:add\.test\.mjs\]/);
    assert.match(checksText, /受控精确编辑文件成功: add\.mjs/);
    assert.match(checksText, /测试运行通过: add\.test\.mjs \(exitCode: 0\)/);
    assert.match(checksText, /受控读取文件成功: add\.mjs/);

    // 3. 验证事件流记录了完整的 run, edit, run, read
    const eventSummaries = job.events.map((e) => e.summary);
    assert.ok(eventSummaries.some((s) => s.includes('run [node_test:add.test.mjs]')));
    assert.ok(eventSummaries.some((s) => s.includes('edit [add.mjs]')));
    assert.ok(eventSummaries.some((s) => s.includes('read [add.mjs]')));
  } finally {
    await broker.stop();
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  }
});
