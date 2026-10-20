// 合成执行器：不调用模型，按注入的确定性动作执行。
// 动作来源：构造参数，或环境变量 LUMA_ZCODE_MOCK_ACTIONS_FILE 指向的 JSON（供子进程 e2e 使用）。
// 动作格式: { "<jobId>" | "default": { write: [{path, content}], waitMs, failWith, appendIfMissing } }

import { readFileSync, existsSync, writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

function loadActions() {
  const f = process.env.LUMA_ZCODE_MOCK_ACTIONS_FILE;
  if (f && existsSync(f)) return JSON.parse(readFileSync(f, "utf8"));
  return {};
}

export function createMockExecutor(actions = null) {
  const resolved = actions ?? loadActions();
  const calls = [];
  let pendingWaits = [];
  return {
    name: "mock",
    calls,
    async execute({ finalInput, workspace, jobId }) {
      calls.push({ finalInput, workspace, jobId, at: new Date().toISOString() });
      const action = resolved[jobId] ?? resolved.default;
      if (!action) throw new Error("mock executor: 未配置动作 (jobId=" + jobId + ")");
      // 先写文件（副作用落地），再挂起等待——用于"执行到一半被杀"的恢复场景
      const artifacts = [];
      for (const w of action.write ?? []) {
        const path = w.path; // 测试动作里的路径必须是绝对路径，边界校验在 run-loop 做
        mkdirSync(dirname(path), { recursive: true });
        if (action.appendIfMissing && existsSync(path)) {
          appendFileSync(path, "\n[mock] 恢复执行未重写已有副作用");
        } else if (!existsSync(path) || !action.appendIfMissing) {
          writeFileSync(path, w.content);
        }
        artifacts.push({ path, purpose: w.purpose ?? "mock 合成产物", checks: ["存在且内容匹配"], unverified: [] });
      }
      if (action.waitMs) {
        await new Promise((r) => {
          const t = setTimeout(() => { pendingWaits = pendingWaits.filter((x) => x.resolve !== r); r(); }, action.waitMs);
          pendingWaits.push({ resolve: r, timer: t });
        });
      }
      if (action.failWith) {
        return { status: "failed", summary: action.failWith, artifacts: [] };
      }
      // 从最终输入提取身份确认行（e2e 用于验证 packet 注入）
      const identityConfirmed = /你是「([^」]+)」/.exec(finalInput)?.[1] ?? null;
      return {
        status: "completed",
        summary: action.summary ?? `mock 执行完成（身份: ${identityConfirmed ?? "未知"}）`,
        artifacts,
        identityConfirmed,
      };
    },
    async abort() {
      // 中止挂起的等待（模拟执行被打断）；e2e 重启测试则直接杀进程
      for (const p of pendingWaits) { clearTimeout(p.timer); p.resolve(); }
      pendingWaits = [];
    },
  };
}
