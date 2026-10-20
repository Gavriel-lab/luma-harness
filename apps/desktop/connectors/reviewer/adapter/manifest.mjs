// runtime manifest 读取与校验。manifest 不放明文凭据——会话凭据走 tokenFile 引用。

import { readFileSync, existsSync } from "node:fs";

export function loadManifest(path) {
  if (!path) throw new Error("缺少 --manifest <path>；适配器不允许扫描全盘寻找服务");
  if (!existsSync(path)) throw new Error(`manifest 不存在: ${path}`);
  const m = JSON.parse(readFileSync(path, "utf8"));

  const problems = [];
  if (m.schemaVersion !== 1) problems.push(`不支持的 schemaVersion: ${m.schemaVersion}`);
  if (typeof m.bridgeUrl !== "string" || !/^http:\/\/127\.0\.0\.1:\d+\/?$/.test(m.bridgeUrl)) {
    problems.push("bridgeUrl 必须是本机 loopback HTTP（127.0.0.1）");
  }
  if (!Number.isInteger(m.generation) || m.generation < 0) problems.push("缺少实例代次 generation");
  if (typeof m.agentId !== "string" || !m.agentId) problems.push("缺少 agentId 绑定");
  if (typeof m.tokenFile !== "string" || !m.tokenFile) problems.push("缺少 tokenFile 引用（manifest 不放明文凭据）");
  else if (!existsSync(m.tokenFile)) problems.push(`tokenFile 不存在: ${m.tokenFile}`);

  if (problems.length) {
    const e = new Error("manifest 校验失败:\n  - " + problems.join("\n  - "));
    e.code = "unsupported_schema";
    throw e;
  }
  return {
    schemaVersion: 1,
    bridgeUrl: m.bridgeUrl.replace(/\/$/, ""),
    generation: m.generation,
    agentId: m.agentId,
    executorId: m.executorId ?? "zcode",
    homeId: m.homeId ?? null,
    modelChain: Array.isArray(m.modelChain) ? m.modelChain : [],
    tokenFile: m.tokenFile,
    executor: m.executor ?? "zcode-app-server",
    issuedAt: m.issuedAt ?? null,
  };
}

export function readSessionToken(manifest) {
  // 凭据只从 tokenFile 读取，不进 CLI 参数、日志或报告。
  return readFileSync(manifest.tokenFile, "utf8").trim();
}
