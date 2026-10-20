import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawn, execFile} from 'node:child_process';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
import {BrokerClient} from '../reviewer/adapter/broker.mjs';
import {verifyBinding} from '../reviewer/adapter/binding.mjs';
import {assembleFinalInput} from '../reviewer/adapter/packet.mjs';
import {findKiroBinary} from './chat.mjs';

// Kiro work line: claims `work` jobs, runs kiro-cli inside the approved directory only,
// and reports what actually happened. Shape follows opencode/worker.mjs + runner.mjs.

export const WORK_AGENT = 'luma-work';
const DESCRIPTION = 'Luma managed Kiro work executor v1';

// Shell is default-deny: only these command prefixes are allowed at all.
const SHELL_ALLOW = ['node *', 'npm test*', 'npm run *', 'python *', 'py *', 'git status*', 'git diff*', 'git log*', 'git show*',
  'dir*', 'type *', 'echo *', 'mkdir *', 'copy *', 'where *', 'findstr *'];
// Even inside allowed prefixes (chained commands, `node -e ...`), these are refused. Best effort, see notes in the final report.
const DENY_WORDS = ['del', 'erase', 'rm', 'rmdir', 'rd', 'format', 'curl', 'wget', 'iwr', 'irm', 'reg', 'sc', 'setx', 'npx'];
const DENY_FRAGMENTS = ['Remove-Item', 'Invoke-WebRequest', 'Invoke-RestMethod', 'certutil', 'bitsadmin', 'regedit', 'netsh', 'schtasks',
  'taskkill', 'shutdown', 'powershell', 'pwsh', 'cmd /c', 'cmd.exe', 'npm install', 'npm i ', 'npm publish', 'npm exec', 'pip install',
  'git push', 'git clone', 'git pull', 'git fetch', 'git reset', 'git clean', 'git checkout', 'rmSync', 'unlinkSync', 'rmdirSync', 'rm(', 'unlink(',
  'fetch(', 'http://', 'https://', 'XMLHttpRequest', 'require("http', "require('http", 'require("net', "require('net", 'node:http', 'node:net',
  '.env', 'credentials', 'token'];
const MODEL_REFUSAL = /selected model cannot continue this conversation/i;
const SECRET_FILES = ['**/.env', '**/.env.*', '**/*credentials*', '**/*token*', '**/*.pem', '**/*.key'];

const shellDeny = () => [
  ...DENY_WORDS.flatMap(w => [`${w} *`, `* ${w} *`, `*&${w} *`, `*|${w} *`, `*;${w} *`]),
  ...DENY_FRAGMENTS.map(f => `*${f}*`)
];

export function agentDefinition(workspace) {
  const root = workspace.replaceAll('\\', '/').replace(/\/+$/, '');
  return {
    name: WORK_AGENT, description: DESCRIPTION,
    prompt: '你在小屋 Luma 的批准工作目录里承接一张明确派发的工单。只处理当前工单；被权限拦截就如实说明并停止，不绕开、不虚报完成；不读取秘密，不联网，不删除文件，不改系统设置。',
    tools: ['read', 'write', 'shell', 'glob', 'grep'],
    permissions: {rules: [
      {capability: 'fs_read', match: [root, `${root}/**`], effect: 'allow'},
      {capability: 'fs_write', match: [`${root}/**`], effect: 'allow'},
      {capability: 'shell', match: SHELL_ALLOW, effect: 'allow'},
      // Deny rules go last so they win over the allows above.
      {capability: 'fs_read', match: SECRET_FILES, effect: 'deny'},
      {capability: 'fs_write', match: [...SECRET_FILES, `${root}/.kiro/**`], effect: 'deny'},
      {capability: 'shell', match: shellDeny(), effect: 'deny'}
    ]},
    resources: [], mcpServers: {}, includeMcpJson: false, includePowers: false
  };
}

export function ensureAgent(workspace) {
  const dir = path.join(workspace, '.kiro', 'agents'), file = path.join(dir, WORK_AGENT + '.json');
  fs.mkdirSync(dir, {recursive: true});
  const relative = path.relative(fs.realpathSync(workspace), fs.realpathSync(dir));
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Kiro 配置目录指向批准目录之外');
  if (fs.existsSync(file)) {
    let existing; try { existing = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { existing = null; }
    if (existing?.description !== DESCRIPTION) throw new Error(`已有同名 Kiro 配置，未覆盖：${WORK_AGENT}`);
  }
  // Rules embed the workspace path, so our own file is regenerated every run.
  fs.writeFileSync(file, JSON.stringify(agentDefinition(fs.realpathSync(workspace)), null, 2), {mode: 0o600});
}

export function workInput(finalInput) {
  return [finalInput, '', '## 执行要求',
    '- 只在批准工作目录内读、写、搜索，并运行必要的检查命令。',
    '- 被权限拦截的操作不要想办法绕开：在汇报里说明被拦了什么，然后停止。',
    '- 不读取密钥、令牌、.env；不联网、不删除文件、不改系统设置。',
    '- 完成后用简洁中文汇报：做了什么、改了哪些文件、跑了什么检查及结果、哪些没能验证。没做的不要说成做了。'].join('\n');
}

const toPath = p => { try { return p.startsWith('file:') ? fileURLToPath(p) : p; } catch { return p; } };
const inside = (workspace, file) => {
  try {
    const rel = path.relative(fs.realpathSync(workspace), fs.realpathSync(file));
    return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel) && !rel.split(path.sep).includes('.kiro') && fs.statSync(file).isFile();
  } catch { return false; }
};

// Pure parser so tests can feed recorded stream-json lines.
export function parseRun(lines, workspace, stderr = '') {
  const tools = new Map(); let final;
  for (const line of lines) {
    let event; try { event = JSON.parse(line); } catch { continue; }
    if (event.type === 'runFinished') { final = event.data; continue; }
    const u = event.data?.update; if (!u?.toolCallId) continue;
    if (!['tool_call', 'tool_call_update'].includes(u.sessionUpdate)) continue;
    const t = tools.get(u.toolCallId) || {kind: '', title: '', command: '', status: '', text: '', paths: new Set()};
    t.kind = u.kind || t.kind; t.title = u.title || t.title; t.status = u.status || t.status;
    t.command = u.rawInput?.command || t.command;
    for (const c of u.content || []) {
      if (c.type === 'diff' && c.path) t.paths.add(toPath(c.path));
      if (c.type === 'content' && typeof c.content?.text === 'string') t.text += c.content.text;
    }
    for (const l of u.locations || []) if (l.path) t.paths.add(toPath(l.path));
    tools.set(u.toolCallId, t);
  }
  const all = [...tools.values()];
  const denied = all.filter(t => t.status === 'failed' && /denied|rejected|not allowed|permission/i.test(t.text));
  const stderrDenied = /\[denied\]/.test(stderr);
  const artifacts = new Set();
  for (const t of all) if (t.kind === 'edit' && t.status === 'completed') for (const p of t.paths) if (inside(workspace, p)) artifacts.add(path.resolve(p));
  const commands = all.filter(t => t.kind === 'execute' && t.command).map(t => {
    const code = t.text.match(/Exit Code:\s*(-?\d+)/);
    return {command: t.command, status: t.status, exitCode: code ? Number(code[1]) : null};
  });
  const complete = final?.status === 'success' && final?.stopReason === 'end_turn' && !final.finalTextTruncated && typeof final.finalText === 'string' && !!final.finalText.trim();
  return {complete, final, denied: denied.map(t => t.title || t.command || '未命名操作'), stderrDenied, artifacts: [...artifacts].map(p => ({path: p})), commands};
}

export class KiroWorkRunner {
  constructor({model = 'claude-opus-5.5', binaryPath, spawnImpl = spawn} = {}) { this.model = model; this.binaryPath = binaryPath; this.spawn = spawnImpl; this.active = null; this.cancelled = false; }
  abort() {
    this.cancelled = true;
    const state = this.active; if (!state || state.cancelled) return;
    state.cancelled = true;
    if (process.platform === 'win32') execFile('taskkill', ['/PID', String(state.child.pid), '/T', '/F'], {windowsHide: true}, () => {});
    else state.child.kill('SIGTERM');
  }
  async execute({finalInput, workspace, timeoutMs = 900000}) {
    if (this.active) throw new Error('Kiro 干活执行器仍在运行');
    this.cancelled = false;
    ensureAgent(workspace);
    if (this.cancelled) return {status: 'cancelled', summary: '本轮执行已停止。'};
    const limit = Math.min(timeoutMs, 1800000), binary = this.binaryPath || findKiroBinary();
    return new Promise(resolve => {
      const lines = []; let bytes = 0, stderr = '', settled = false;
      const child = this.spawn(binary, ['chat', '--v3', '--agent', WORK_AGENT, '--model', this.model, '--no-interactive', '--output-format', 'stream-json'],
        {cwd: workspace, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: {...process.env, KIRO_HEADLESS_WORKFLOW_TIMEOUT_SECS: String(Math.ceil(limit / 1000))}});
      const state = {child, cancelled: false, timedOut: false, outputExceeded: false}; this.active = state;
      const timer = setTimeout(() => { state.timedOut = true; this.abort(); }, limit); timer.unref?.();
      const reader = createInterface({input: child.stdout, crlfDelay: Infinity});
      child.stdout.on('data', c => { bytes += c.length; if (bytes > 32 * 1024 * 1024) { state.outputExceeded = true; this.abort(); } });
      reader.on('line', l => lines.push(l));
      child.stderr.on('data', c => { stderr = (stderr + c.toString('utf8')).slice(-8192); });
      child.stdin.on('error', () => {});
      const finish = result => { if (settled) return; settled = true; clearTimeout(timer); if (this.active === state) this.active = null; resolve({modelUsed: this.model, ...result}); };
      child.on('error', e => finish({status: 'failed', summary: `Kiro 无法启动：${e.message}`}));
      child.on('close', code => {
        reader.close();
        if (state.timedOut) return finish({status: 'failed', summary: 'Kiro 本轮执行超时，已停止；请核对已有文件后重新派发。'});
        if (state.outputExceeded) return finish({status: 'failed', summary: 'Kiro 输出异常，已停止本轮。'});
        if (state.cancelled) return finish({status: 'cancelled', summary: '本轮执行已停止。'});
        const run = parseRun(lines, workspace, stderr), text = (run.final?.finalText || '').trim();
        const ran = run.commands.length ? '\n\n实际运行的命令：\n' + run.commands.slice(0, 12).map(c => `- ${c.command}（${c.status === 'completed' ? '退出码 ' + c.exitCode : c.status}）`).join('\n') : '';
        const base = {sessionId: run.final?.sessionId || null, artifacts: run.artifacts, commands: run.commands, unknowns: stderr ? ['CLI 诊断已产生；未向聊天或群聊输出原始日志。'] : []};
        if (run.denied.length || run.stderrDenied) return finish({...base, status: 'blocked', blockedCode: 'permission_required', summary: `被权限规则拦住，未完整完成${run.denied.length ? '：' + run.denied.slice(0, 5).join('、') : ''}。\n${text}`.slice(0, 4000)});
        if (code !== 0 || !run.complete) return finish({...base, status: 'failed', summary: `Kiro 未完成本轮执行（退出 ${code}，${run.final?.status || '无完成收据'}）${/login|auth|expired/i.test(stderr) ? '，请检查 Kiro 登录状态' : ''}`});
        // The CLI reports `success` even when the model refuses to continue; never pass that off as finished work.
        if (MODEL_REFUSAL.test(text)) return finish({...base, status: 'failed', summary: 'Kiro 的模型拒绝继续本轮，工单没有被执行；请调整工单描述后重新派发。'});
        finish({...base, status: 'completed', finalText: text, summary: (text + ran).slice(0, 4000)});
      });
      // Keep the work order off the process command line.
      child.stdin.end(workInput(finalInput), 'utf8');
    });
  }
}

// The journal is written BEFORE the model starts and BEFORE reports are sent.
// A crashed attempt needs explicit redispatch, never automatic replay.
export class AttemptJournal {
  constructor(directory) { this.directory = directory; fs.mkdirSync(directory, {recursive: true}); }
  file(job) { return path.join(this.directory, createHash('sha256').update(job.jobId + '\0' + job.attemptId).digest('hex') + '.json'); }
  read(job) { const file = this.file(job); return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null; }
  save(job, value) { const file = this.file(job), tmp = file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(value), {mode: 0o600}); fs.renameSync(tmp, file); }
}

export async function handleKiroWorkJob({broker, manifest, session, job, runner, journal, signal, heartbeatMs = 5000}) {
  const previous = journal.read(job);
  if (previous?.report) return broker.report(previous.report);
  const reportId = 'kiro_' + job.attemptId;
  const deliver = async (outcome, summary, extra = {}) => {
    const report = {jobId: job.jobId, attemptId: job.attemptId, reportId, outcome, summary, artifacts: [], checks: [], checkpoint: null, unknowns: [], ...extra};
    journal.save(job, {report});
    return broker.report(report);
  };
  if (previous) return deliver('failed', '执行器曾中断；请核对已有文件后明确重新派发，未自动重复执行。');
  journal.save(job, {started: true});
  const context = await broker.context({jobId: job.jobId, attemptId: job.attemptId});
  if (!context.ok) return deliver(context.code === 'stale_attempt' ? 'cancelled' : 'failed', '未取得当前授权上下文，未启动 Kiro。');
  const packet = context.packet;
  const binding = verifyBinding({manifest, session, claim: job, packet});
  if (!binding.ok || job.kind !== 'work' || packet.job.kind !== 'work' || job.agentId !== manifest.agentId || job.executorId !== manifest.executorId || packet.executorId !== manifest.executorId || packet.homeId !== manifest.homeId) return deliver('failed', '身份、任务或批准目录核对失败，未启动 Kiro。');
  if (signal?.aborted) return deliver('cancelled', '本轮执行已停止。');
  const {finalInput, receipt} = assembleFinalInput(packet);
  const started = await broker.event({jobId: job.jobId, attemptId: job.attemptId, seq: 1, type: 'started', summary: 'Kiro 正在处理本轮工单', checkpoint: {receipt: {packetId: receipt.packetId, contextVersion: receipt.contextVersion, inputSha: receipt.inputSha}}});
  if (!started.ok) return deliver('cancelled', '执行轮次已失效，未启动 Kiro。');
  if (signal?.aborted) return deliver('cancelled', '本轮执行已停止。');
  let cancelled = false, busy = false, monitoring = true, lastHeartbeat = Date.now();
  const cancel = () => { if (!monitoring) return; cancelled = true; runner.abort(); };
  signal?.addEventListener('abort', cancel, {once: true});
  const timer = setInterval(async () => {
    if (busy) return; busy = true;
    try {
      const r = await broker.heartbeat({jobId: job.jobId, attemptId: job.attemptId});
      if (!monitoring) return;
      if (r.ok) { lastHeartbeat = Date.now(); if (r.contextVersion !== packet.contextVersion) cancel(); }
      else if (['stale_attempt', 'unauthenticated', 'forbidden'].includes(r.code) || Date.now() - lastHeartbeat > 20000) cancel();
    } finally { busy = false; }
  }, heartbeatMs);
  let result;
  try { result = await runner.execute({finalInput, workspace: packet.job.workspace, timeoutMs: job.timeoutMs || 900000}); }
  catch (e) { result = {status: 'failed', summary: `Kiro 无法执行：${e.message || '请检查 CLI 安装与本目录配置'}`}; }
  finally { monitoring = false; clearInterval(timer); signal?.removeEventListener('abort', cancel); }
  if (cancelled || signal?.aborted || result.status === 'cancelled') return deliver('cancelled', '本轮执行已停止。');
  const success = result.status === 'completed';
  return deliver(success ? 'submitted' : 'failed', result.summary || 'Kiro 未完成本轮执行。', {
    artifacts: success ? result.artifacts || [] : [],
    checkpoint: {jobId: job.jobId, attemptId: job.attemptId, workspace: job.workspace, sessionId: result.sessionId || null, modelUsed: result.modelUsed || null, completed: [], remaining: success ? [] : ['核对已有产物后重新派发'], nextAction: success ? '等待验收' : '检查执行阻塞'},
    unknowns: result.unknowns || []
  });
}

export async function runKiroWorkLoop({manifest, token, signal, runner, stateDir, onStop = () => {}, pollMs = 1500, heartbeatMs = 5000}) {
  const journal = new AttemptJournal(path.join(stateDir, 'attempts'));
  const broker = new BrokerClient({bridgeUrl: manifest.bridgeUrl, token});
  const session = await broker.session();
  if (!session.ok || session.agentId !== manifest.agentId || session.executorId !== manifest.executorId || session.homeId !== manifest.homeId || session.generation !== manifest.generation) { onStop(); return; }
  const pause = () => new Promise(resolve => {
    if (signal.aborted) return resolve();
    const end = () => { clearTimeout(timer); signal.removeEventListener('abort', end); resolve(); };
    const timer = setTimeout(end, pollMs); signal.addEventListener('abort', end, {once: true});
  });
  while (!signal.aborted) {
    const claim = await broker.claim({capabilities: {executor: 'kiro', kinds: ['work']}});
    if (!claim.ok) { if (['unauthenticated', 'forbidden'].includes(claim.code)) { onStop(); break; } await pause(); continue; }
    if (!claim.job) { await pause(); continue; }
    try { await handleKiroWorkJob({broker, manifest, session, job: claim.job, runner, journal, signal, heartbeatMs}); } catch { onStop(); break; }
  }
}
