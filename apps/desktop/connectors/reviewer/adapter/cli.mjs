// 适配器 CLI 入口：--manifest <path> [--state-dir <dir>] [--once]
// 显式 manifest，不扫描全盘；凭据从 tokenFile 读，不进参数/日志。

import { parseArgs } from "node:util";
import { loadManifest, readSessionToken } from "./manifest.mjs";
import { StateStore } from "./state.mjs";
import { runAdapter } from "./run-loop.mjs";
import { createMockExecutor } from "./executor/mock-executor.mjs";
import { createZcodeExecutor } from "./executor/zcode-app-server.mjs";

const args = parseArgs({
  options: {
    manifest: { type: "string" },
    "state-dir": { type: "string" },
    once: { type: "boolean", default: false },
    executor: { type: "string" }, // 覆盖 manifest.executor
  },
});

const manifest = loadManifest(args.values.manifest);
const stateDir = args.values["state-dir"] ?? "./.adapter-state";
const state = new StateStore(stateDir);
const token = readSessionToken(manifest);

const executorName = args.values.executor ?? manifest.executor ?? "zcode-app-server";
const executor = executorName === "mock"
  ? createMockExecutor()
  : createZcodeExecutor({ mode: "build", modelChain: manifest.modelChain ?? [] });

console.log("[reviewer-adapter] 启动", {
  bridgeUrl: manifest.bridgeUrl,
  generation: manifest.generation,
  agentId: manifest.agentId,
  executor: executorName,
});

const controller = new AbortController();
process.on("SIGINT", () => controller.abort());
process.on("SIGTERM", () => controller.abort());

const result = await runAdapter({ manifest, token, state, executor, signal: controller.signal });
console.log("[reviewer-adapter] 退出", result);
process.exit(result.ok ? 0 : 2);
