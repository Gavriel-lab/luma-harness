// Windows 打包：自动包含前端构建，产出免安装的完整运行目录到 release/
// 运行：npm run desktop:pack
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const isWin = process.platform === 'win32';

function step(label, cmd, args, extraEnv = {}) {
  console.log(`\n[小屋] ${label}`);
  const r = spawnSync(cmd, args, {
    cwd: ROOT,
    stdio: 'inherit',
    shell: isWin,
    env: { ...process.env, ...extraEnv },
  });
  if (r.status !== 0) {
    console.error(`[小屋] ${label} 失败，退出码 ${r.status}`);
    process.exit(r.status ?? 1);
  }
}

step('构建前端…', 'npx', ['tsc', '-b']);
step('打包 Vite 产物…', 'npx', ['vite', 'build']);

// Electron 运行时下载走国内镜像，避免官方 CDN 超时
step('打包 Windows 运行目录…', 'npx', ['electron-builder', '--win', '--dir'], {
  ELECTRON_MIRROR: process.env.ELECTRON_MIRROR ?? 'https://npmmirror.com/mirrors/electron/',
  ELECTRON_BUILDER_BINARIES_MIRROR: process.env.ELECTRON_BUILDER_BINARIES_MIRROR ?? 'https://npmmirror.com/mirrors/electron-builder-binaries/',
});

const releaseDir = path.join(ROOT, 'release');
const exes = [];
function walk(dir) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full);
    else if (name.toLowerCase().endsWith('.exe')) exes.push(full);
  }
}
if (existsSync(releaseDir)) {
  walk(releaseDir);
  console.log('\n[小屋] 交付运行目录：');
  for (const e of exes) console.log(`  - ${path.relative(ROOT, e)}`);
  if (exes.length === 0) {
    console.error('[小屋] 没有找到 exe，请检查上面的打包输出');
    process.exit(1);
  }
} else {
  console.error('[小屋] release/ 不存在，打包未产出');
  process.exit(1);
}