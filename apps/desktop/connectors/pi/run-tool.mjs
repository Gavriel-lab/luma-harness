import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { validateControlledPath } from './controlled-tools.mjs';

/**
 * 环境变量白名单（防止泄露主进程的模型密钥与 CloudSync 管理凭据）
 */
const ALLOWED_ENV_VARS = [
  'PATH',
  'PATHEXT',
  'SYSTEMROOT',
  'COMSPEC',
  'TEMP',
  'TMP',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'ALLUSERSPROFILE',
  'PROGRAMDATA',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'COMMONPROGRAMFILES',
  'NODE_PATH',
  'NODE_OPTIONS'
];

/**
 * 解析并确定可信的独立 Node 可执行程序
 * 优先定位本机已核验的系统独立 node.exe (如 C:\Program Files\nodejs\node.exe)
 * 若无系统独立 node，则使用当前宿主 process.execPath
 */
export function resolveNodeBinary() {
  const systemCandidates = [
    'C:\\Program Files\\nodejs\\node.exe',
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs', 'node.exe'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'nodejs', 'node.exe')
  ];
  for (const cand of systemCandidates) {
    if (fs.existsSync(cand)) return cand;
  }
  return process.execPath;
}

/**
 * 定位本地 Node 内部的 npm-cli.js 路径
 */
export function resolveNpmCliPath() {
  const nodeBinary = resolveNodeBinary();
  const nodeDir = path.dirname(nodeBinary);
  const candidates = [
    path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'nodejs', 'node_modules', 'npm', 'bin', 'npm-cli.js')
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

/**
 * 构造清洗后的子进程环境变量（严禁注入任何模型密钥或数据库凭据）
 * 关键修复：显式补齐 ELECTRON_RUN_AS_NODE 标志，防止在 Electron 宿主下意外启动第二个 GUI
 */
export function buildCleanChildEnv(extraEnv = {}) {
  const cleanEnv = {};
  for (const key of Object.keys(process.env)) {
    const upper = key.toUpperCase();
    if (ALLOWED_ENV_VARS.includes(upper)) {
      cleanEnv[key] = process.env[key];
    }
  }
  cleanEnv.NODE_ENV = 'test';
  cleanEnv.CI = 'true';
  // 显式为子进程设置 ELECTRON_RUN_AS_NODE，确保即便在 Electron 宿主或调用到 小屋.exe 也以纯 Node 模式运行，绝不启动 GUI
  cleanEnv.ELECTRON_RUN_AS_NODE = '1';
  Object.assign(cleanEnv, extraEnv);
  return cleanEnv;
}

/**
 * 深度输出脱敏：彻底消除 Bearer 令牌、API-key 形状字符串及各种凭据标记
 */
export function sanitizeOutput(text) {
  if (!text || typeof text !== 'string') return text;
  return text
    // 1. Authorization: Bearer <token>
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    // 2. OpenAI / Anthropic / 类 API key 模式 (sk-..., sk-proj-..., key-...)
    .replace(/(?:sk-|sk-proj-|key-|api[-_]?key)[A-Za-z0-9_-]{16,}/gi, '[REDACTED_API_KEY]')
    // 3. 常见 key/token/secret/password 模式
    .replace(/(?:api[_-]?key|token|secret|password|credential)[=:\s]+['"]?[A-Za-z0-9._~+/-]{16,}['"]?/gi, '$1=[REDACTED]')
    // 4. 项目内特定敏感 token 标记
    .replace(/AUDIT_[a-zA-Z0-9_\-]+/gi, '[REDACTED]');
}

/**
 * 终止指定进程及其所有子孙进程（在 Windows 上使用 taskkill /T /F 真实进程树终止）
 */
export async function killProcessTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') {
    await new Promise((resolve) => {
      const killer = spawn('taskkill.exe', ['/pid', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore'
      });
      killer.on('close', () => resolve());
      killer.on('error', () => resolve());
      setTimeout(resolve, 3000);
    });
  } else {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      try { process.kill(pid, 'SIGKILL'); } catch {}
    }
  }
}

/**
 * 解析 node --test 输出中的测试通过数、失败数与跳过数
 */
export function inspectNodeTestOutput(stdout = '') {
  const testsMatch = stdout.match(/(?:#|ℹ)\s*tests\s+(\d+)/i);
  const passMatch = stdout.match(/(?:#|ℹ)\s*pass\s+(\d+)/i);
  const failMatch = stdout.match(/(?:#|ℹ)\s*fail\s+(\d+)/i);
  const skippedMatch = stdout.match(/(?:#|ℹ)\s*skipped\s+(\d+)/i);

  const totalTests = testsMatch ? parseInt(testsMatch[1], 10) : 0;
  const passedTests = passMatch ? parseInt(passMatch[1], 10) : 0;
  const failedTests = failMatch ? parseInt(failMatch[1], 10) : 0;
  const skippedTests = skippedMatch ? parseInt(skippedMatch[1], 10) : 0;

  return { totalTests, passedTests, failedTests, skippedTests };
}

/**
 * 底层通用结构化命令执行器
 */
export async function executeStructuredCommand({
  cmd,
  args = [],
  cwd,
  env,
  timeoutMs = 60000,
  signal,
  maxOutputBytes = 65536
}) {
  const startTime = Date.now();

  // 关键修复：预取消状态防御，已取消时绝不派生任何子进程，0 副作用启动
  if (signal?.aborted) {
    return {
      ok: false,
      exitCode: null,
      signal: 'SIGABRT',
      stdout: '',
      stderr: '任务在启动前已被取消',
      durationMs: 0,
      timedOut: false,
      aborted: true,
      error: '任务在启动前已被取消',
      testStats: { totalTests: 0, passedTests: 0, failedTests: 0, skippedTests: 0 }
    };
  }

  let timedOut = false;
  let aborted = false;
  let child = null;
  let timer = null;

  return new Promise((resolve) => {
    let stdoutBuffer = '';
    let stderrBuffer = '';
    let tailBuffer = ''; // 保持最近 64KiB 尾部滑动窗口，确保长日志下的测试统计报告不被丢弃
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let stdoutTotalBytes = 0;
    let stderrTotalBytes = 0;
    let currentTestStats = { totalTests: 0, passedTests: 0, failedTests: 0, skippedTests: 0 };
    let settled = false;

    const cleanupAndResolve = (res) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(res);
    };

    // 再次在 spawn 发生前复核预取消状态
    if (signal?.aborted) {
      return cleanupAndResolve({
        ok: false,
        exitCode: null,
        signal: 'SIGABRT',
        stdout: '',
        stderr: '任务在启动前已被取消',
        durationMs: 0,
        timedOut: false,
        aborted: true,
        error: '任务在启动前已被取消',
        testStats: currentTestStats
      });
    }

    try {
      child = spawn(cmd, args, {
        cwd,
        env: env || buildCleanChildEnv(),
        shell: false,
        windowsHide: true
      });
    } catch (err) {
      return cleanupAndResolve({
        ok: false,
        exitCode: null,
        signal: null,
        stdout: '',
        stderr: err.message,
        durationMs: Date.now() - startTime,
        timedOut: false,
        aborted: false,
        error: `启动子进程失败: ${err.message}`,
        testStats: currentTestStats
      });
    }

    child.stdout?.on('data', (chunk) => {
      const str = chunk.toString('utf8');
      stdoutTotalBytes += Buffer.byteLength(str);

      // 1. 摘要缓冲区（保留前 maxOutputBytes）
      if (Buffer.byteLength(stdoutBuffer) < maxOutputBytes) {
        stdoutBuffer += str;
        if (Buffer.byteLength(stdoutBuffer) > maxOutputBytes) {
          stdoutBuffer = stdoutBuffer.slice(0, maxOutputBytes);
          stdoutTruncated = true;
        }
      } else {
        stdoutTruncated = true;
      }

      // 2. 尾部滑动窗口（保留最近 64KiB，确保末尾测试报告不被丢弃）
      tailBuffer += str;
      if (Buffer.byteLength(tailBuffer) > 65536) {
        tailBuffer = tailBuffer.slice(-65536);
      }

      // 3. 动态提取最新测试统计
      const latestStats = inspectNodeTestOutput(tailBuffer);
      if (latestStats.totalTests > 0 || latestStats.passedTests > 0 || latestStats.failedTests > 0) {
        currentTestStats = latestStats;
      }
    });

    child.stderr?.on('data', (chunk) => {
      const str = chunk.toString('utf8');
      stderrTotalBytes += Buffer.byteLength(str);
      if (Buffer.byteLength(stderrBuffer) < maxOutputBytes) {
        stderrBuffer += str;
        if (Buffer.byteLength(stderrBuffer) > maxOutputBytes) {
          stderrBuffer = stderrBuffer.slice(0, maxOutputBytes);
          stderrTruncated = true;
        }
      } else {
        stderrTruncated = true;
      }
    });

    const handleAbortOrTimeout = async (isTimeout) => {
      if (settled) return;
      if (isTimeout) timedOut = true;
      else aborted = true;

      if (child?.pid) {
        await killProcessTree(child.pid);
      }
      try { child?.kill('SIGKILL'); } catch {}
    };

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        handleAbortOrTimeout(true);
      }, timeoutMs);
    }

    if (signal) {
      if (signal.aborted) {
        handleAbortOrTimeout(false);
      } else {
        signal.addEventListener('abort', () => handleAbortOrTimeout(false), { once: true });
      }
    }

    child.on('error', (err) => {
      cleanupAndResolve({
        ok: false,
        exitCode: null,
        signal: null,
        stdout: sanitizeOutput(stdoutBuffer),
        stderr: sanitizeOutput((stderrBuffer ? stderrBuffer + '\n' : '') + err.message),
        durationMs: Date.now() - startTime,
        timedOut,
        aborted,
        error: `子进程异常: ${err.message}`,
        testStats: currentTestStats
      });
    });

    child.on('close', (code, sig) => {
      const rawStdout = stdoutTruncated
        ? stdoutBuffer + `\n...[输出已截断：stdout 总量 ${stdoutTotalBytes} 字节，超出 ${maxOutputBytes} 字节限制]...`
        : stdoutBuffer;
      const rawStderr = stderrTruncated
        ? stderrBuffer + `\n...[输出已截断：stderr 总量 ${stderrTotalBytes} 字节，超出 ${maxOutputBytes} 字节限制]...`
        : stderrBuffer;

      // 输出深度脱敏
      const finalStdout = sanitizeOutput(rawStdout);
      const finalStderr = sanitizeOutput(rawStderr);

      const ok = code === 0 && !timedOut && !aborted && !sig;

      cleanupAndResolve({
        ok,
        exitCode: code,
        signal: sig,
        stdout: finalStdout,
        stderr: finalStderr,
        durationMs: Date.now() - startTime,
        timedOut,
        aborted,
        error: !ok ? (timedOut ? '执行超时' : aborted ? '任务已取消' : `进程退出码非0: ${code}`) : undefined,
        testStats: currentTestStats
      });
    });
  });
}

/**
 * 创建供 Pi SDK 注入的受控项目运行与验证工具定义
 */
export function createSecureRunToolDefinition(approvedWorkspace, options = {}) {
  const timeoutMs = options.timeoutMs || 60000;
  const maxOutputBytes = options.maxOutputBytes || 65536;

  return {
    name: 'run',
    label: 'run',
    description: '受控项目运行与验证工具：仅限在当前批准工作目录下执行预定义结构化动作（node_file / node_test / npm_script）。不接收任意 shell 脚本，严禁越界或执行任意系统命令。',
    promptSnippet: 'Execute, test or run npm scripts in the project directory',
    promptGuidelines: [
      'Use action: "node_file" to run an existing JS/MJS/CJS entry file in the approved workspace.',
      'Use action: "node_test" to run node --test on a specific test file in the workspace.',
      'Use action: "npm_script" to run a declared script (e.g. test, build, typecheck) from package.json.',
      'Do not specify arbitrary shell commands or interactive programs; execution is structured, headless and strictly scoped.'
    ],
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['node_file', 'node_test', 'npm_script'],
          description: '运行动作：node_file（运行JS入口）、node_test（运行node --test测试）、npm_script（运行package.json中声明的脚本）'
        },
        target: {
          type: 'string',
          description: '目标文件相对路径（针对node_file和node_test）或package.json中的脚本名（针对npm_script）'
        },
        args: {
          type: 'array',
          items: { type: 'string' },
          description: '可选参数列表，纯字符串数组'
        }
      },
      required: ['action', 'target']
    },
    execute: async (toolCallId, params, signal, onUpdate, ctx) => {
      // 预取消检查：已取消信号立即短路，0 次进程派生
      if (signal?.aborted) {
        return {
          content: [{ type: 'text', text: '【执行结果】失败 (FAILED)\n- 状态: 任务在启动前已被取消' }],
          isError: true,
          details: {
            action: params?.action || 'run',
            target: params?.target || '',
            ok: false,
            exitCode: null,
            signal: 'SIGABRT',
            durationMs: 0,
            timedOut: false,
            aborted: true,
            error: '任务在启动前已被取消',
            stdout: '',
            stderr: ''
          }
        };
      }

      if (!approvedWorkspace || typeof approvedWorkspace !== 'string') {
        throw new Error('[安全拦截] 未配置有效的批准工作目录');
      }

      let realRoot;
      try {
        realRoot = fs.realpathSync(approvedWorkspace);
      } catch (err) {
        throw new Error(`[安全拦截] 批准工作目录不存在或无法解析: ${err.message}`);
      }

      const action = params?.action;
      const target = params?.target;
      const userArgs = Array.isArray(params?.args)
        ? params.args.filter((a) => typeof a === 'string')
        : [];

      if (!action || !['node_file', 'node_test', 'npm_script'].includes(action)) {
        throw new Error(`[安全拦截] 无效的 action 参数: "${action}"。仅支持 node_file, node_test, npm_script`);
      }
      if (!target || typeof target !== 'string' || !target.trim()) {
        throw new Error('[安全拦截] 必须指定非空的 target 参数');
      }

      // 固定选用已核验的 Node 可执行程序
      let cmd = resolveNodeBinary();
      let cmdArgs = [];

      if (action === 'node_file') {
        const check = validateControlledPath(approvedWorkspace, target, { mode: 'read' });
        if (!check.allowed) {
          throw new Error(check.reason);
        }
        const ext = path.extname(check.realPath).toLowerCase();
        if (!['.js', '.mjs', '.cjs'].includes(ext)) {
          throw new Error(`[安全拦截] node_file 仅支持执行 .js, .mjs, .cjs 文件，禁止执行: ${ext}`);
        }
        cmdArgs = [check.realPath, ...userArgs];
      } else if (action === 'node_test') {
        const check = validateControlledPath(approvedWorkspace, target, { mode: 'read' });
        if (!check.allowed) {
          throw new Error(check.reason);
        }
        cmdArgs = ['--test', check.realPath, ...userArgs];
      } else if (action === 'npm_script') {
        if (target.includes('/') || target.includes('\\') || target.startsWith('-')) {
          throw new Error(`[安全拦截] 非法的 npm_script 名称: "${target}"`);
        }
        const pkgPath = path.join(realRoot, 'package.json');
        if (!fs.existsSync(pkgPath)) {
          throw new Error(`[安全拦截] 项目根目录下不存在 package.json，无法执行 npm_script`);
        }
        let pkg;
        try {
          pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        } catch (err) {
          throw new Error(`[安全拦截] 解析 package.json 失败: ${err.message}`);
        }
        if (!pkg.scripts || typeof pkg.scripts !== 'object' || !pkg.scripts[target]) {
          throw new Error(`[安全拦截] package.json 中未声明名为 "${target}" 的脚本`);
        }

        const npmCli = resolveNpmCliPath();
        if (!npmCli) {
          throw new Error(`[系统错误] 未能定位本地 npm-cli.js，无法安全执行 npm 脚本`);
        }
        cmdArgs = [npmCli, 'run', target, '--', ...userArgs];
      }

      // 执行结构化命令（子进程环境已注入 ELECTRON_RUN_AS_NODE 防 GUI 弹出）
      const runResult = await executeStructuredCommand({
        cmd,
        args: cmdArgs,
        cwd: realRoot,
        env: buildCleanChildEnv(),
        timeoutMs,
        signal,
        maxOutputBytes
      });

      // 针对 node_test，通过流式提取的真实 testStats 判定测试结果，不受日志截断影响
      if (action === 'node_test' && runResult.ok) {
        const stats = runResult.testStats || inspectNodeTestOutput(runResult.stdout);
        if (stats.passedTests === 0) {
          runResult.ok = false;
          runResult.error = `测试未实际通过任何断言（测试总数: ${stats.totalTests}，通过数: 0，跳过数: ${stats.skippedTests}）`;
        } else if (stats.failedTests > 0) {
          runResult.ok = false;
          runResult.error = `测试存在失败用例（失败数: ${stats.failedTests}）`;
        }
      }

      // 汇总输出并执行脱敏
      const summaryText = sanitizeOutput([
        `【执行结果】${runResult.ok ? '成功 (OK)' : '失败 (FAILED)'}`,
        `- 动作 (action): ${action}`,
        `- 目标 (target): ${target}`,
        `- 退出码 (exitCode): ${runResult.exitCode !== null ? runResult.exitCode : 'N/A'}`,
        `- 耗时: ${runResult.durationMs}ms`,
        runResult.timedOut ? `- 状态: 执行超时` : null,
        runResult.aborted ? `- 状态: 任务已取消` : null,
        runResult.error ? `- 错误原因: ${runResult.error}` : null,
        `- 标准输出 (stdout):\n${runResult.stdout ? runResult.stdout.trim() : '(无输出)'}`,
        `- 标准错误 (stderr):\n${runResult.stderr ? runResult.stderr.trim() : '(无输出)'}`
      ].filter(Boolean).join('\n'));

      return {
        content: [{ type: 'text', text: summaryText }],
        isError: !runResult.ok,
        details: {
          action,
          target,
          ok: runResult.ok,
          exitCode: runResult.exitCode,
          signal: runResult.signal,
          durationMs: runResult.durationMs,
          timedOut: runResult.timedOut,
          aborted: runResult.aborted,
          error: runResult.error,
          stdout: runResult.stdout,
          stderr: runResult.stderr,
          testStats: runResult.testStats
        }
      };
    }
  };
}

/**
 * 兼容独立调用与测试的 run 工具封装
 */
export function createControlledRunTool(approvedWorkspace, options = {}) {
  const def = createSecureRunToolDefinition(approvedWorkspace, options);
  return {
    ...def,
    execute: async (...args) => {
      if (args.length === 1 && typeof args[0] === 'object') {
        const input = args[0];
        const res = await def.execute('tool_direct_run', input);
        return {
          ok: !res.isError,
          exitCode: res.details?.exitCode,
          content: res.content?.[0]?.text,
          details: res.details
        };
      }
      return def.execute(...args);
    }
  };
}
