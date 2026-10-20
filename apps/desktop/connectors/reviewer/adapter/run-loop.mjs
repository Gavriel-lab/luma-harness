// 适配器主循环：claim → context → 绑定核对 → 组装最终输入 → 执行 → events/heartbeat → report。
// R1：job/attempt 分离（同 attempt 重复投递重发原报告，新 attempt 独立执行）；
//     模型启动前完整绑定核对；恢复资料（登记会话+检查点）真接执行器；终态按事实映射。

import { BrokerClient } from "./broker.mjs";
import { assembleFinalInput, summarizeForReport } from "./packet.mjs";
import { verifyBinding, normalizePath } from "./binding.mjs";
import { shouldAbortAttempt, shouldReportBlocked } from "./errors.mjs";
import { isPathInside } from "./paths.mjs";

const POLL_IDLE_MS = 3000;
const heartbeatMs = () => Number(process.env.LUMA_ZCODE_HEARTBEAT_MS) || 15_000;

export async function runAdapter({ manifest, token, state, executor, log = console.log, signal }) {
  const broker = new BrokerClient({ bridgeUrl: manifest.bridgeUrl, token });
  const running = new Set();
  let stopped = false;

  const abortAll = async () => { stopped = true; await executor.abort?.(); };
  signal?.addEventListener("abort", () => { abortAll(); });

  // 1. 身份验证握手（不触发模型）
  const s = await broker.session();
  if (!s.ok) { log("session 握手失败", s); return { ok: false, phase: "session", error: s }; }
  if (s.agentId !== manifest.agentId) {
    log("身份不匹配", { manifest: manifest.agentId, broker: s.agentId });
    return { ok: false, phase: "session", error: { code: "forbidden", message: "broker 返回的 agentId 与 manifest 绑定不一致" } };
  }
  if (manifest.generation !== undefined && s.generation !== undefined && s.generation !== manifest.generation) {
    log("实例代次不一致，拒绝启动", { manifest: manifest.generation, broker: s.generation });
    return { ok: false, phase: "session", error: { code: "forbidden", message: "实例代次不一致" } };
  }
  if (manifest.homeId && s.homeId && s.homeId !== manifest.homeId) {
    log("小屋归属不一致，拒绝启动", { manifest: manifest.homeId, broker: s.homeId });
    return { ok: false, phase: "session", error: { code: "forbidden", message: "小屋归属不一致" } };
  }
  if (manifest.executorId && s.executorId && s.executorId !== manifest.executorId) {
    log("执行器标识不一致，拒绝启动", { manifest: manifest.executorId, broker: s.executorId });
    return { ok: false, phase: "session", error: { code: "forbidden", message: "执行器标识不一致" } };
  }
  log("session OK", { agentId: s.agentId, executorId: s.executorId, generation: s.generation, schemaVersion: s.schemaVersion });
  const sessionInfo = s;

  // 2. 主循环
  while (!stopped) {
    const claim = await broker.claim({ capabilities: { executor: manifest.executor, modes: ["build", "edit", "plan"] } });
    if (!claim.ok) {
      if (shouldAbortAttempt(claim)) { log("claim 被拒，停止轮询", claim); stopped = true; break; }
      await sleep(POLL_IDLE_MS);
      continue;
    }
    if (!claim.job) { await sleep(POLL_IDLE_MS); continue; }

    const { jobId, ticketId, taskId, attemptId, lease, workspace, contextVersion } = claim.job;
    if (running.has(jobId)) { log("重复投递，本进程已在执行，忽略", { jobId }); await sleep(POLL_IDLE_MS); continue; }

    running.add(jobId);
    try {
      await handleJob({ broker, manifest, sessionInfo, state, executor, log, jobId, ticketId, taskId, attemptId, lease, workspace, contextVersion, signal });
    } catch (e) {
      log("job 处理异常", { jobId, error: e.message });
      await sleep(1000); // 异常退避，避免失败 job 立即被重领造成紧循环
    } finally {
      running.delete(jobId);
    }
  }

  return { ok: true, stopped };
}

async function handleJob(ctx) {
  const { broker, manifest, sessionInfo, state, executor, log, jobId, attemptId, lease } = ctx;

  // R1-1: attempt 维度判定。同一 attempt 重复投递且已有终态报告 → 原样重发，不重复执行；
  //        新 attempt（broker 显式批准）→ 一律进入独立执行路径，旧失败/旧提交不重放。
  const prior = state.getAttemptReport(jobId, attemptId);
  if (prior) {
    log("同 attempt 重复投递：重发原报告（不重复执行）", { jobId, attemptId, outcome: prior.status });
    const r = await broker.report({
      jobId, attemptId, reportId: prior.reportId,
      outcome: prior.status,
      summary: prior.report.summary ?? "",
      artifacts: prior.report.artifacts ?? [],
      checks: prior.report.checks ?? [],
      checkpoint: prior.report.checkpoint ?? null,
      unknowns: prior.report.unknowns ?? [],
    });
    if (!r.ok) log("重发报告被拒", { code: r.code });
    state.update(jobId, { status: prior.status });
    return;
  }

  const recovering = state.resumableAttempt(jobId, attemptId);
  state.beginAttempt(jobId, { attemptId, ticketId: ctx.ticketId, taskId: ctx.taskId, workspace: ctx.workspace, contextVersion: ctx.contextVersion });

  // 拉取权威 ContextPacket（恢复时带 knownContextVersion 以便 broker 判定失效）
  let context = await broker.context({ jobId, attemptId, knownContextVersion: recovering ? ctx.contextVersion : undefined });
  if (!context.ok) {
    if (context.code === "stale_attempt") { log("旧 attempt，放弃", { jobId, attemptId }); state.update(jobId, { status: "abandoned" }); return; }
    if (context.code === "context_stale") {
      // 上下文失效：先重取权威 packet（不带旧版本号），旧内容不复活
      log("context_stale，重取最新 packet", { jobId });
      context = await broker.context({ jobId, attemptId });
    }
    if (!context.ok) {
      if (shouldReportBlocked(context)) await sendEvent(broker, state, jobId, attemptId, "blocked", `context 获取被拒: ${context.code}`);
      await doReport(broker, state, jobId, attemptId, "failed", `无法获取 ContextPacket: ${context.code}`, { unknowns: [`context:${context.code}`] });
      return;
    }
  }

  const packet = context.packet;

  // R1-2: 模型启动前的完整绑定核对（成员/执行器/小屋/代次/任务链/目录/版本）
  const binding = verifyBinding({ manifest, session: sessionInfo, claim: { jobId, ticketId: ctx.ticketId, taskId: ctx.taskId, attemptId, workspace: ctx.workspace, contextVersion: ctx.contextVersion }, packet });
  if (!binding.ok) {
    await sendEvent(broker, state, jobId, attemptId, "blocked", `绑定核对失败：${[...binding.reasons, ...binding.missing].join(", ")}；不启动模型、不改文件`);
    await doReport(broker, state, jobId, attemptId, "failed", "绑定核对失败（不启动模型）", { unknowns: [...binding.reasons, ...binding.missing].map((x) => `binding:${x}`) });
    return;
  }

  const job = packet.job;

  // R1-3: 恢复资料核对——只恢复匹配成员/目录/attempt 且已登记的会话与检查点
  let recovery = null;
  const jobState = state.job(jobId);
  if (recovering && jobState?.checkpoint?.sessionId) {
    const ck = jobState.checkpoint;
    const sameWorkspace = normalizePath(ck.workspace ?? ctx.workspace) && normalizePath(ck.workspace ?? ctx.workspace).toLowerCase() === normalizePath(ctx.workspace).toLowerCase();
    if (sameWorkspace && state.sessionIsRegistered(jobId, attemptId, ck.sessionId)) {
      recovery = { sessionId: ck.sessionId, checkpoint: ck, workspace: ctx.workspace };
    } else {
      log("登记会话与当前绑定不匹配，不续接旧会话；按最新 packet 开新会话恢复", { jobId, registered: ck.sessionId });
    }
  }

  // 组装最终输入 + 来源收据（检查实际送给模型的输入；恢复检查点真正进入输入）
  const { finalInput, receipt } = assembleFinalInput(packet, recovery?.checkpoint ?? null);
  await sendEvent(broker, state, jobId, attemptId, "started",
    recovering ? `恢复执行（${recovery ? `续接登记会话 ${recovery.sessionId}` : "新会话+检查点恢复"}；packet v${packet.contextVersion}）` : `开始执行：已注入身份/关系锚点与当前任务（packet v${packet.contextVersion}）`,
    { receipt: { packetId: receipt.packetId, contextVersion: receipt.contextVersion, inputSha: receipt.inputSha, recovery: recovery ? { sessionId: recovery.sessionId, checkpointHash: state.checkpointHash(recovery.checkpoint) } : null } });

  // 心跳维持租约；stale_attempt 视为取消/替换
  let cancelRequested = false;
  const hb = setInterval(async () => {
    const r = await broker.heartbeat({ jobId, attemptId });
    if (!r.ok && (r.code === "stale_attempt" || r.code === "unauthenticated")) {
      cancelRequested = true;
      executor.abort?.();
    }
  }, heartbeatMs());

  let execResult;
  try {
    execResult = await executor.execute({
      finalInput,
      workspace: job.workspace, // 已核对 = claim 批准目录（或其子目录）
      jobId,
      recovery, // R1-3: 受校验的登记会话 + 检查点，执行器实际用于续接
      timeoutMs: lease?.maxRuntimeMs ?? 15 * 60_000,
      onLog: (e) => {
        log(`[executor] ${e.tag}`, e.obj);
        // 执行期间会话建立即持久化登记信息：进程被杀后重启才有恢复资料可用
        if ((e.tag === "session-created" || e.tag === "session-resumed") && e.obj?.sessionId) {
          const cur = state.job(jobId);
          state.update(jobId, { checkpoint: { ...(cur?.checkpoint ?? {}), sessionId: e.obj.sessionId, workspace: ctx.workspace, jobId, attemptId } });
        }
      },
    });
  } finally {
    clearInterval(hb);
  }

  // R1-4: 终态按事实映射。cancelled → cancelled；completed → submitted（进 review）；
  //        blocked/failed/未知 → failed。取消时执行器内已真正停止子进程（abort/kill）。
  const outcome = execResult.status === "completed" ? "submitted"
    : execResult.status === "cancelled" ? "cancelled"
    : "failed"; // blocked / failed / unknown / 其他一律 failed，不冒充完成

  if (cancelRequested && outcome !== "cancelled") {
    // 心跳发现取消但执行器先返回：以取消事实收尾
    log("检测到取消/旧 attempt，以 cancelled 收尾", { jobId });
    state.update(jobId, { status: "cancelled" });
    await broker.report({ jobId, attemptId, reportId: repId(jobId, attemptId), outcome: "cancelled", summary: "检测到取消或 attempt 失效，执行已停止", artifacts: [], checkpoint: state.job(jobId)?.checkpoint ?? null });
    return;
  }

  if (execResult.status === "blocked" && execResult.blockedCode) {
    await sendEvent(broker, state, jobId, attemptId, "blocked", execResult.summary);
  } else if (outcome === "failed") {
    await sendEvent(broker, state, jobId, attemptId, "failed", execResult.summary);
  } else {
    await sendEvent(broker, state, jobId, attemptId, "progress", `执行完成（终态 ${execResult.status}），提交 review（产物 ${execResult.artifacts?.length ?? 0} 件）`);
  }

  // 产物路径校验：只接受批准工作目录内文件，目录外不自动上传
  const approved = ctx.workspace; // 以 claim 批准目录为准
  const artifacts = [];
  const unknowns = [];
  for (const a of execResult.artifacts ?? []) {
    if (a.path && isPathInside(a.path, approved)) artifacts.push(a);
    else unknowns.push(`artifact-outside-workspace:${a.path}`);
  }

  // 持久化检查点（含登记会话，供恢复路径核对）
  const checkpoint = {
    jobId, attemptId, sessionId: execResult.sessionId ?? jobState?.checkpoint?.sessionId ?? null,
    workspace: ctx.workspace,
    completed: outcome === "submitted" ? [job.goal ?? "任务目标"] : (jobState?.checkpoint?.completed ?? recovery?.checkpoint?.completed ?? []),
    remaining: outcome === "submitted" ? [] : ["等待阻塞解除后重试；已完成副作用见 completed/事件流"],
    blockers: execResult.blockedCode ? [execResult.blockedCode] : [],
    nextAction: outcome === "submitted" ? "等待 review 验收" : "解除阻塞后由 broker 重新派发",
    artifactPaths: artifacts.map((a) => a.path),
    recoveryMode: execResult.recoveryMode ?? null,
    modelUsed: execResult.modelUsed ?? null,
  };
  state.update(jobId, { status: outcome === "submitted" ? "submitted" : outcome === "cancelled" ? "cancelled" : "failed", checkpoint });

  await doReport(broker, state, jobId, attemptId, outcome, execResult.summary, { artifacts, checkpoint, unknowns, finalText: execResult.finalText, modelUsed: execResult.modelUsed, modelSwitch: execResult.modelSwitch });
}

async function sendEvent(broker, state, jobId, attemptId, type, summary, checkpoint) {
  const seq = state.nextSeq(jobId);
  const r = await broker.event({ jobId, attemptId, seq, type, summary, checkpoint });
  if (!r.ok) console.error("event 上报失败", { jobId, seq, type, code: r.code });
  return r;
}

function repId(jobId, attemptId) { return `rep_${jobId}_${attemptId}`; }

async function doReport(broker, state, jobId, attemptId, outcome, summary, extra = {}) {
  const jobState = state.job(jobId);
  const reportId = repId(jobId, attemptId);
  // 完整报告体：重发时原样保留（R1-1）
  const report = {
    outcome,
    summary: summary ?? "",
    artifacts: extra.artifacts ?? [],
    checks: extra.checks ?? [],
    checkpoint: extra.checkpoint ?? null,
    unknowns: extra.unknowns ?? [],
  };
  const receipt = summarizeForReport({
    packet: { job: { ticketId: jobState?.ticketId, taskId: jobState?.taskId } },
    outcome, summary,
    artifacts: report.artifacts,
    unknowns: report.unknowns,
  });
  const r = await broker.report({ jobId, attemptId, reportId, ...report });
  state.recordAttemptReport(jobId, attemptId, { status: outcome, reportId, report });
  state.update(jobId, { reportId, lastReport: receipt, status: outcome });
  if (!r.ok) console.error("report 上报失败", { jobId, code: r.code });
  return r;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
