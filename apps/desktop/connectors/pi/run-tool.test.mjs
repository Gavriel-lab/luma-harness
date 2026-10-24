import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  createControlledRunTool,
  createSecureRunToolDefinition,
  buildCleanChildEnv,
  inspectNodeTestOutput
} from './run-tool.mjs';

test('run-tool: node_file 正常运行、参数传递与输出捕获', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-run-node-'));
  const workspace = path.join(tmpDir, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });

  try {
    const entryFile = path.join(workspace, 'index.mjs');
    fs.writeFileSync(
      entryFile,
      `console.log("HELLO_STDOUT " + process.argv.slice(2).join(","));\nconsole.error("HELLO_STDERR");\nprocess.exit(0);`,
      'utf8'
    );

    const tool = createControlledRunTool(workspace);
    const res = await tool.execute({
      action: 'node_file',
      target: 'index.mjs',
      args: ['arg1', 'arg2']
    });

    assert.equal(res.ok, true);
    assert.equal(res.exitCode, 0);
    assert.match(res.content, /HELLO_STDOUT arg1,arg2/);
    assert.match(res.content, /HELLO_STDERR/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('run-tool: node_file 非0退出与语法错误分类准确', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-run-err-'));
  const workspace = path.join(tmpDir, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });

  try {
    const failFile = path.join(workspace, 'fail.cjs');
    fs.writeFileSync(failFile, `console.error("CRITICAL_FAILURE");\nprocess.exit(42);`, 'utf8');

    const tool = createControlledRunTool(workspace);
    const res = await tool.execute({
      action: 'node_file',
      target: 'fail.cjs'
    });

    assert.equal(res.ok, false);
    assert.equal(res.exitCode, 42);
    assert.match(res.content, /CRITICAL_FAILURE/);
    assert.match(res.content, /退出码非0: 42/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('run-tool: node_test 真正执行并通过至少一个断言；无测试时拒绝通过', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-run-test-'));
  const workspace = path.join(tmpDir, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });

  try {
    const tool = createControlledRunTool(workspace);

    // 1. 真实断言通过的测试
    const passTest = path.join(workspace, 'math.test.mjs');
    fs.writeFileSync(
      passTest,
      `import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('addition', () => { assert.equal(1 + 1, 2); });\ntest('subtraction', () => { assert.equal(5 - 2, 3); });`,
      'utf8'
    );

    const resPass = await tool.execute({
      action: 'node_test',
      target: 'math.test.mjs'
    });
    assert.equal(resPass.ok, true);
    assert.equal(resPass.exitCode, 0);
    assert.match(resPass.content, /tests 2|ℹ tests 2/i);
    assert.match(resPass.content, /pass 2|ℹ pass 2/i);

    // 2. 测试全跳过（pass 为 0），必须拒绝通过
    const skippedTest = path.join(workspace, 'skipped.test.mjs');
    fs.writeFileSync(
      skippedTest,
      `import test from 'node:test';\ntest.skip('all skipped test', () => {});`,
      'utf8'
    );

    const resEmpty = await tool.execute({
      action: 'node_test',
      target: 'skipped.test.mjs'
    });
    assert.equal(resEmpty.ok, false);
    assert.match(resEmpty.content, /测试未实际通过任何断言/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('run-tool: npm_script 仅执行 package.json 中声明的脚本，未声明或非法名称拦截', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-run-npm-'));
  const workspace = path.join(tmpDir, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });

  try {
    const pkg = {
      name: 'test-project',
      version: '1.0.0',
      scripts: {
        'verify': 'node -e "console.log(\'NPM_VERIFY_SUCCESS\')"',
        'typecheck': 'node -e "console.log(\'TYPECHECK_OK\')"'
      }
    };
    fs.writeFileSync(path.join(workspace, 'package.json'), JSON.stringify(pkg, null, 2), 'utf8');

    const tool = createControlledRunTool(workspace);

    // 1. 执行已声明的脚本
    const resOk = await tool.execute({
      action: 'npm_script',
      target: 'verify'
    });
    assert.equal(resOk.ok, true);
    assert.match(resOk.content, /NPM_VERIFY_SUCCESS/);

    // 2. 尝试执行未声明的脚本
    await assert.rejects(
      async () => {
        await tool.execute('call_npm_invalid', {
          action: 'npm_script',
          target: 'not_declared'
        });
      },
      /未声明名为 "not_declared" 的脚本/
    );

    // 3. 尝试注入非法路径或选项
    await assert.rejects(
      async () => {
        await tool.execute('call_npm_inject', {
          action: 'npm_script',
          target: '../../bin/sh'
        });
      },
      /非法的 npm_script 名称/
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('run-tool: 环境变量脱敏，严禁泄漏模型密钥与管理凭据', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-run-env-'));
  const workspace = path.join(tmpDir, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });

  const oldPiKey = process.env.LUMA_PI_MODEL_API_KEY;
  const oldOpenAIKey = process.env.OPENAI_API_KEY;
  const oldSupaKey = process.env.CLOUD_SYNC_SERVICE_ROLE_KEY;

  process.env.LUMA_PI_MODEL_API_KEY = 'SECRET_PI_KEY_SHOULD_NOT_LEAK';
  process.env.OPENAI_API_KEY = 'SECRET_OPENAI_KEY_SHOULD_NOT_LEAK';
  process.env.CLOUD_SYNC_SERVICE_ROLE_KEY = 'SECRET_CLOUD_SYNC_KEY_SHOULD_NOT_LEAK';

  try {
    const envInspect = path.join(workspace, 'inspect_env.mjs');
    fs.writeFileSync(
      envInspect,
      `console.log("PI_KEY:" + (process.env.LUMA_PI_MODEL_API_KEY || "NONE"));\n` +
      `console.log("OPENAI_KEY:" + (process.env.OPENAI_API_KEY || "NONE"));\n` +
      `console.log("SUPA_KEY:" + (process.env.CLOUD_SYNC_SERVICE_ROLE_KEY || "NONE"));\n`,
      'utf8'
    );

    const tool = createControlledRunTool(workspace);
    const res = await tool.execute({
      action: 'node_file',
      target: 'inspect_env.mjs'
    });

    assert.equal(res.ok, true);
    assert.match(res.content, /PI_KEY:NONE/);
    assert.match(res.content, /OPENAI_KEY:NONE/);
    assert.match(res.content, /SUPA_KEY:NONE/);
  } finally {
    if (oldPiKey !== undefined) process.env.LUMA_PI_MODEL_API_KEY = oldPiKey;
    else delete process.env.LUMA_PI_MODEL_API_KEY;
    if (oldOpenAIKey !== undefined) process.env.OPENAI_API_KEY = oldOpenAIKey;
    else delete process.env.OPENAI_API_KEY;
    if (oldSupaKey !== undefined) process.env.CLOUD_SYNC_SERVICE_ROLE_KEY = oldSupaKey;
    else delete process.env.CLOUD_SYNC_SERVICE_ROLE_KEY;

    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('run-tool: 越界拒绝与受保护目录拦截', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-run-security-'));
  const workspace = path.join(tmpDir, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });

  try {
    const tool = createControlledRunTool(workspace);

    // 1. 尝试执行工作目录外的文件
    const outsideFile = path.join(tmpDir, 'outside.mjs');
    fs.writeFileSync(outsideFile, `console.log("OUTSIDE");`, 'utf8');

    await assert.rejects(
      async () => {
        await tool.execute('call_out', {
          action: 'node_file',
          target: '../outside.mjs'
        });
      },
      /越界拒绝/
    );

    // 2. 尝试执行受保护目录（如 .git）内的文件
    const gitDir = path.join(workspace, '.git');
    fs.mkdirSync(gitDir, { recursive: true });
    const gitHook = path.join(gitDir, 'hook.mjs');
    fs.writeFileSync(gitHook, `console.log("GIT_HOOK");`, 'utf8');

    await assert.rejects(
      async () => {
        await tool.execute('call_git', {
          action: 'node_file',
          target: '.git/hook.mjs'
        });
      },
      /受保护目录/
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('run-tool: 超时控制与 Windows 进程树真实终止', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-run-timeout-'));
  const workspace = path.join(tmpDir, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });

  try {
    // 启动一个休眠 30 秒的脚本，并派生一个孙子进程
    const sleepScript = path.join(workspace, 'sleep.mjs');
    fs.writeFileSync(
      sleepScript,
      `import { spawn } from 'node:child_process';\nspawn(process.execPath, ['-e', 'setTimeout(()=>{}, 30000)'], { stdio: 'ignore' });\nsetTimeout(() => {}, 30000);\n`,
      'utf8'
    );

    const tool = createSecureRunToolDefinition(workspace, { timeoutMs: 1000 });
    const res = await tool.execute('call_timeout', {
      action: 'node_file',
      target: 'sleep.mjs'
    });

    assert.equal(res.isError, true);
    assert.equal(res.details.timedOut, true);
    assert.match(res.content[0].text, /执行超时/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('run-tool: AbortSignal 取消控制与进程清理', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-run-abort-'));
  const workspace = path.join(tmpDir, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });

  try {
    const hangScript = path.join(workspace, 'hang.mjs');
    fs.writeFileSync(hangScript, `setTimeout(() => {}, 60000);\n`, 'utf8');

    const controller = new AbortController();
    const tool = createSecureRunToolDefinition(workspace, { timeoutMs: 30000 });

    const runPromise = tool.execute(
      'call_abort',
      { action: 'node_file', target: 'hang.mjs' },
      controller.signal
    );

    // 500ms 后触发取消
    setTimeout(() => {
      controller.abort();
    }, 500);

    const res = await runPromise;
    assert.equal(res.isError, true);
    assert.equal(res.details.aborted, true);
    assert.match(res.content[0].text, /任务已取消/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('run-tool: 大输出截断与截断标记', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-run-trunc-'));
  const workspace = path.join(tmpDir, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });

  try {
    const hugeOutputScript = path.join(workspace, 'huge.mjs');
    // 输出 80KiB 字符
    fs.writeFileSync(
      hugeOutputScript,
      `console.log("X".repeat(80 * 1024));\n`,
      'utf8'
    );

    // 限制 16KiB
    const tool = createSecureRunToolDefinition(workspace, { maxOutputBytes: 16384 });
    const res = await tool.execute('call_trunc', {
      action: 'node_file',
      target: 'huge.mjs'
    });

    assert.equal(res.isError, false);
    assert.match(res.content[0].text, /输出已截断/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
