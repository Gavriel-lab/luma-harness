// 真实 ZCode 执行器：经 ZCode Protocol stdio（app-server）驱动已安装的 Zcode 客户端。
// 实测协议（zcode 0.16.9，与 Codex app-server 不同，非 JSON-RPC 2.0）：
//   - NDJSON 行帧；请求 {id, method, params}；响应 {id, result|error}
//   - 服务器会向客户端发请求（session/requestRuntimePreferences 等），必须应答否则挂起
//   - session/create {workspace:{workspaceKey,workspacePath}, mode?, model?}
//   - session/resume {sessionId, workspace:{workspaceKey,workspacePath}}（实测可读回历史与模型选择）
//   - session/send {sessionId, content}；通知 v4/telemetry/event kind=turn.terminal 携带回合终态
//
// R1：恢复续接（受验 session 实际调用 session/resume，失败才走新会话并保留检查点）；
//     终态按事实映射（completed/cancelled/failed/未知）；取消真正停止子进程；
//     文件工单收集批准目录内回合期间实际变更的产物与检查结果；模型切换按 model-policy（每回合最多一次）。

import { spawn } from "node:child_process";
import { readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { decideModelSwitch } from "../model-policy.mjs";
import { resolveZcodeStartupEnv } from './zcode-startup-env.mjs';

const ZCODE_CJS = process.env.LUMA_ZCODE_CJS || '';

const SKIP_DIRS = new Set(["node_modules", ".git", ".adapter-state", ".wrangler", ".zcode", "release", "dist", ".mock-run"]);

// 收集回合期间在批准目录内实际新增/修改的文件（产物实证；纯聊天无文件变更则返回空，不硬造）
function collectWorkspaceArtifacts(workspace, sinceMs, cap = 50) {
  const found = [];
  const walk = (dir, depth) => {
    if (depth > 6 || found.length >= cap) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (found.length >= cap) return;
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(p, depth + 1);
        continue;
      }
      if (!e.isFile()) continue;
      try {
        const st = statSync(p);
        if (st.mtimeMs >= sinceMs - 1000) {
          found.push({ path: p, purpose: "turn 期间新增/修改", checks: { exists: true, bytes: st.size }, unverified: [] });
        }
      } catch { /* 单文件 stat 失败忽略 */ }
    }
  };
  try { walk(workspace, 0); } catch { /* workspace 不可读则无产物 */ }
  return found;
}

export function createZcodeExecutor({ mode = "build", modelChain = [] } = {}) {
  let child = null;
  let aborted = false;

  async function abort() {
    aborted = true;
    try { child?.kill(); } catch { /* 已退出 */ }
  }

  async function execute({ finalInput, workspace, timeoutMs = 15 * 60_000, recovery = null, onLog = () => {} }) {
    aborted = false;
    if(!ZCODE_CJS||!existsSync(ZCODE_CJS)||!statSync(ZCODE_CJS).isFile())throw Error('Configure LUMA_ZCODE_CJS with your installed ZCode entry file');
    const startedAt = Date.now();
    const log = (tag, obj) => { onLog?.({ tag, obj }); };
    child = spawn("node", [ZCODE_CJS, "app-server"], { cwd: workspace,windowsHide:true,env:resolveZcodeStartupEnv(ZCODE_CJS) });

    const waiters = new Map();
    let nextId = 1;
    let sessionId = null;
    let modelUsed = modelChain[0] ?? null;
    let fallbackUsed = false;
    let modelSwitch = null;

    const result = await new Promise((resolve) => {
      let buf = "";
      let settled = false;
      const timer = setTimeout(() => finish({ status: "failed", summary: "执行器超时", terminalEvent: { errorCode: "TIMEOUT" } }), timeoutMs);

      function finish(r) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { child.kill(); } catch { /* 忽略 */ }
        resolve(r);
      }

      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (!line) continue;
          let msg;
          try { msg = JSON.parse(line); } catch { continue; }

          if (msg.method && msg.id !== undefined && msg.result === undefined && msg.error === undefined) {
            if (msg.method === "session/requestRuntimePreferences") {
              child.stdin.write(JSON.stringify({
                id: msg.id,
                result: {
                  nativeSearchEnhancementsEnabled: false,
                  memoryEnabled: false, // 小屋记忆由 broker 提供，不启用客户端私有记忆
                  askUserQuestionAutoResolutionEnabled: true,
                  modelContextBudgetStrategy: "legacy",
                },
              }) + "\n");
            } else {
              log("srv-request-denied", { method: msg.method });
              child.stdin.write(JSON.stringify({ id: msg.id, error: { code: -32601, message: "adapter: request not permitted: " + msg.method } }) + "\n");
            }
            continue;
          }

          if (msg.method === "v4/telemetry/event" && msg.params?.kind === "turn.terminal") {
            const terminal = { status: msg.params.status, errorCode: msg.params.errorCode ?? null, errorMessage: msg.params.errorMessage ?? null };
            log("turn-terminal", terminal);

            // R1 模型规则：仅明确额度耗尽且链内有下一模型 → 每回合一次自动切换，重发同一输入
            const sw = decideModelSwitch({ terminal, modelUsed, fallbackUsed, modelChain });
            if (sw) {
              fallbackUsed = true;
              modelUsed = sw.next;
              modelSwitch = { from: sw.from, to: sw.next, reason: sw.reason };
              log("model-switch", modelSwitch);
              (async () => {
                try {
                  try {
                    await request("session/setModel", { sessionId, model: sw.next }, 20000);
                  } catch {
                    // setModel 不可用（如注册表缺该模型）→ 新会话携带模型参数再试一次
                    const created = await request("session/create", {
                      workspace: { workspaceKey: "reviewer-bridge-" + Date.now(), workspacePath: workspace },
                      mode, model: sw.next,
                    }, 30000);
                    sessionId = created.session.sessionId;
                  }
                  await request("session/send", { sessionId, content: finalInput }, 30000);
                  log("prompt-resent-after-switch", { sessionId });
                } catch (e) {
                  log("model-switch-failed", { error: e.message });
                  finish({
                    status: "failed",
                    summary: `模型切换尝试失败: ${e.message}`,
                    blockedCode: "executor_unavailable",
                    terminalEvent: terminal, modelUsed, modelSwitch,
                  });
                }
              })();
              continue;
            }

            // R1 终态按事实映射：仅客户端确认成功 → completed；cancelled → cancelled；
            // failed → failed/blocked；未知状态 → failed(unknown)。取消即刻停止子进程。
            if (terminal.status === "cancelled") {
              finish({ status: "cancelled", summary: `客户端回合被取消（${terminal.errorCode ?? "no-code"}）`, terminalEvent: terminal, modelUsed, modelSwitch });
              return;
            }
            if (terminal.status === "completed" || terminal.status === "finished" || terminal.status === "success") {
              Promise.all([readFinalText()]).then(([text]) => {
                const artifacts = collectWorkspaceArtifacts(workspace, startedAt);
                finish({
                  status: "completed",
                  summary: text ?? "(模型无文本输出)",
                  artifacts, // 实际产物与检查结果；纯聊天为空数组
                  terminalEvent: terminal, modelUsed, modelSwitch,
                  finalText: text ?? null,
                });
              });
              return;
            }
            if (terminal.status === "failed") {
              const code = terminal.errorCode === "CONFIGURATION_ERROR" ? "executor_unavailable" : "unknown";
              readFinalText().then((text) => finish({
                status: "blocked",
                summary: `ZCode 回合失败: ${terminal.errorMessage ?? terminal.errorCode}`,
                blockedCode: code, terminalEvent: terminal, modelUsed, modelSwitch, finalText: text ?? null,
              }));
              return;
            }
            // 未知终态
            finish({ status: "failed", summary: `未知客户端终态: ${terminal.status}`, terminalEvent: terminal, modelUsed, modelSwitch });
            return;
          }

          if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
            const w = waiters.get(msg.id);
            if (w) { waiters.delete(msg.id); w(msg); }
          }
        }
      });
      child.stderr.on("data", (d) => log("stderr", { text: d.toString().slice(0, 300) }));
      child.on("exit", (code) => {
        if (settled) return;
        if (aborted) finish({ status: "cancelled", summary: "适配器取消，子进程已停止", modelUsed, modelSwitch });
        else finish({ status: "failed", summary: `ZCode app-server 提前退出 (code ${code})` });
      });

      function request(method, params, timeoutMsReq = 30000) {
        return new Promise((res, rej) => {
          const id = nextId++;
          const t = setTimeout(() => { waiters.delete(id); rej(new Error("timeout " + method)); }, timeoutMsReq);
          waiters.set(id, (m) => { clearTimeout(t); m.error ? rej(new Error(m.error.message)) : res(m.result); });
          child.stdin.write(JSON.stringify({ id, method, ...(params ? { params } : {}) }) + "\n");
        });
      }

      async function readFinalText() {
        try {
          const r = await request("session/read", { sessionId }, 15000);
          const msgs = r?.messages ?? [];
          const last = [...msgs].reverse().find((m) => m?.info?.role === "assistant" || m?.info?.agent);
          const parts = last?.parts ?? [];
          return parts.filter((p) => p?.type === "text").map((p) => p.text ?? "").join("") || null;
        } catch { return null; }
      }

      (async () => {
        try {
          await new Promise((r) => setTimeout(r, 2000)); // 等 startup/storageState ready
          if (recovery?.sessionId) {
            // R1-3: 实际调用已核实的恢复方法续接登记会话；失败才开新会话并保留检查点
            try {
              const resumed = await request("session/resume", {
                sessionId: recovery.sessionId,
                workspace: { workspaceKey: "reviewer-bridge-resume-" + Date.now(), workspacePath: workspace },
              }, 30000);
              sessionId = resumed.session?.sessionId ?? recovery.sessionId;
              log("session-resumed", { sessionId, mode: "registered-session" });
            } catch (e) {
              log("session-resume-unavailable", { error: e.message, mode: "new-session-with-checkpoint" });
              const created = await request("session/create", {
                workspace: { workspaceKey: "reviewer-bridge-" + Date.now(), workspacePath: workspace },
                mode,
              }, 30000);
              sessionId = created.session.sessionId;
            }
          } else {
            const created = await request("session/create", {
              workspace: { workspaceKey: "reviewer-bridge-" + Date.now(), workspacePath: workspace },
              mode,
            }, 30000);
            sessionId = created.session.sessionId;
            log("session-created", { sessionId });
          }
          await request("session/send", { sessionId, content: finalInput }, 30000);
          log("prompt-sent", { sessionId });
        } catch (e) {
          finish({ status: "failed", summary: "ZCode 会话建立/发送失败: " + e.message, blockedCode: "executor_unavailable" });
        }
      })();
    });

    return {
      sessionId,
      recoveryMode: recovery ? (result.recoveryMode ?? (recovery.sessionId ? "attempted" : null)) : null,
      ...result,
    };
  }

  return { name: "zcode-app-server", execute, abort };
}
