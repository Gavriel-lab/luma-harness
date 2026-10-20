#!/usr/bin/env node
'use strict';

/**
 * Mock Codex App-Server (Stdio JSON-RPC 2.0 替身)
 * 用于自动化端到端测试，不消耗真实 token，不接管真实 Codex 线程
 */

const readline = require('readline');
const fs = require('fs');

const logFile = process.env.MOCK_CODEX_LOG || '';
function log(msg) {
  if (logFile) {
    try {
      fs.appendFileSync(logFile, `[MOCK-CODEX ${new Date().toISOString()}] ${msg}\n`);
    } catch {}
  }
}

log('Mock Codex App-Server started. Args: ' + JSON.stringify(process.argv));

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false,
});

let turnCounter = 1;

function sendResponse(id, result, error = null) {
  const resp = { jsonrpc: '2.0', id };
  if (error) {
    resp.error = error;
  } else {
    resp.result = result;
  }
  const payload = JSON.stringify(resp);
  log('Sending response: ' + payload);
  process.stdout.write(payload + '\n');
}

function sendNotification(method, params) {
  const notif = { jsonrpc: '2.0', method, params };
  const payload = JSON.stringify(notif);
  log('Sending notification: ' + payload);
  process.stdout.write(payload + '\n');
}

let pendingApprovalId = 1000;
function sendRequest(method, params, callback) {
  const id = ++pendingApprovalId;
  const req = { jsonrpc: '2.0', id, method, params };
  log('Sending request to client: ' + JSON.stringify(req));
  process.stdout.write(JSON.stringify(req) + '\n');
}

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  log('Received line: ' + trimmed);

  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch (e) {
    log('Failed to parse line: ' + e.message);
    return;
  }

  // 处理客户端对服务端请求的回复 (例如审批结果)
  if (msg.id && (msg.result !== undefined || msg.error !== undefined)) {
    log('Received response from client: ' + JSON.stringify(msg));
    return;
  }

  const { id, method, params } = msg;

  if (method === 'initialize') {
    sendResponse(id, {
      serverInfo: {
        name: 'mock-codex-app-server',
        version: '0.159.0',
      },
      capabilities: {
        streaming: true,
      },
    });
  } else if (method === 'initialized') {
    log('Client acknowledged initialization.');
  } else if (method === 'model/list') {
    sendResponse(id, {
      data: [
        { id: 'mock-gpt-6.1-sol', displayName: 'Mock GPT-6.1-Sol', isDefault: true },
        { id: 'mock-gpt-5-lite', displayName: 'Mock GPT-5-Lite' },
      ],
    });
  } else if (method === 'thread/start') {
    const threadId = 'thread_mock_' + Date.now();
    log(`thread/start -> ${threadId} (cwd: ${params?.cwd})`);
    sendResponse(id, { id: threadId });
  } else if (method === 'thread/resume') {
    log(`thread/resume -> ${params?.threadId}`);
    sendResponse(id, { id: params?.threadId || 'thread_resumed' });
  } else if (method === 'turn/start') {
    const currentTurnId = 'turn_' + turnCounter++;
    const threadId = params?.threadId;
    let inputText = '';
    if (typeof params?.input === 'string') {
      inputText = params.input;
    } else if (Array.isArray(params?.input)) {
      inputText = params.input.map((it) => (typeof it === 'string' ? it : (it?.text || ''))).join('');
    }
    log(`turn/start -> turnId: ${currentTurnId}, threadId: ${threadId}, inputText: ${JSON.stringify(inputText)}`);

    // 返回 turn/start 响应
    sendResponse(id, { turn: { id: currentTurnId, status: 'in_progress' } });

    // 检查是否包含特殊触发词用于安全拦截测试
    if (inputText.includes('TRIGGER_APPROVAL_TEST')) {
      setTimeout(() => {
        sendRequest('item/commandExecution/requestApproval', {
          command: 'rm -rf /',
          reason: 'Testing approval rejection',
        });
      }, 50);
    }

    // 模拟流式回复
    setTimeout(() => {
      sendNotification('item/agentMessage/delta', {
        threadId,
        turnId: currentTurnId,
        delta: '【协调者】我收到了：',
      });
    }, 40);

    setTimeout(() => {
      sendNotification('item/agentMessage/delta', {
        threadId,
        turnId: currentTurnId,
        delta: inputText.slice(0, 50),
      });
    }, 80);

    setTimeout(() => {
      sendNotification('turn/completed', {
        threadId,
        turnId: currentTurnId,
        status: 'completed',
      });
    }, 150);
  } else if (method === 'turn/interrupt') {
    log(`turn/interrupt for thread: ${params?.threadId}`);
    sendResponse(id, { ok: true });
  } else {
    log(`Unhandled method: ${method}`);
    if (id) {
      sendResponse(id, { ok: true });
    }
  }
});

rl.on('close', () => {
  log('Mock Codex App-Server stdin closed, exiting.');
  process.exit(0);
});
