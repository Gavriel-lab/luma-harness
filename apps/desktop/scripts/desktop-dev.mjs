// 本机桌面开发：一条命令负责 Vite 开发服务的启停与 Electron 启停。
// 运行：npm run desktop:dev
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import electronPath from 'electron';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5183;
const URL_ = `http://127.0.0.1:${PORT}/`;

function run(cmd, args, opts = {}) {
  return spawn(cmd, args, { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32', ...opts });
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForServer(url, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { method: 'GET' });
      if (res.ok) return true;
    } catch {
      /* 还没起来 */
    }
    await wait(500);
  }
  throw new Error(`开发服务器 ${url} 在 ${timeoutMs / 1000} 秒内没有就绪`);
}

console.log('[小屋] 启动 Vite 开发服务…');
const vite = run('npx', ['vite', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort']);

let electron = null;
let closing = false;

async function shutdown(code = 0) {
  if (closing) return;
  closing = true;
  if (electron && !electron.killed) electron.kill();
  if (vite && !vite.killed) vite.kill();
  process.exit(code);
}

process.on('SIGINT', () => void shutdown(0));
process.on('SIGTERM', () => void shutdown(0));

try {
  await waitForServer(URL_);
  console.log('[小屋] 启动 Electron 开发窗口…');
  electron = run(String(electronPath), ['.'], {
    env: { ...process.env, XIAOWU_DEV_URL: URL_, ELECTRON_ENABLE_LOGGING: '1' },
  });
  electron.on('exit', (code) => {
    console.log('[小屋] 窗口已退出，关闭开发服务。');
    void shutdown(code ?? 0);
  });
} catch (err) {
  console.error('[小屋] 启动失败：', err.message);
  await shutdown(1);
}