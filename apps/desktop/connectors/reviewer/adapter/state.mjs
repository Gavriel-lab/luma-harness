// 状态存储：job/attempt/session/checkpoint 映射的持久化（原子写 JSON）。
// R1：报告、seq、检查点、会话绑定按 attempt 管理；
//     同一 attempt 重复投递重发同一份完整报告；新 attempt 走独立执行路径。

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";

const TERMINAL = new Set(["submitted", "failed", "cancelled"]);

export class StateStore {
  constructor(stateDir) {
    this.file = join(stateDir, "adapter-state.json");
    this.tmp = join(stateDir, "adapter-state.json.tmp");
    mkdirSync(stateDir, { recursive: true });
    this.data = { schemaVersion: 2, jobs: {}, lastClaimAt: null };
    if (existsSync(this.file)) {
      const loaded = JSON.parse(readFileSync(this.file, "utf8"));
      this.data = { ...this.data, ...loaded };
      // v1 状态文件兼容：旧字段提升为当前 attempt 的记录
      for (const job of Object.values(this.data.jobs)) {
        job.attemptResults ??= {};
        if (job.attemptId && job.reportId && !job.attemptResults[job.attemptId] && TERMINAL.has(job.status)) {
          job.attemptResults[job.attemptId] = {
            status: job.status, reportId: job.reportId,
            report: { ...(job.lastReport ?? {}), ...(job.checkpoint ? { checkpoint: job.checkpoint } : {}) },
          };
        }
      }
    }
  }

  flush() {
    writeFileSync(this.tmp, JSON.stringify(this.data, null, 2));
    renameSync(this.tmp, this.file);
  }

  job(jobId) {
    return this.data.jobs[jobId] ?? null;
  }

  // job 级终态（任一已知 attempt 终态且无更新活动）——仅用于粗判，attempt 判定用 attemptTerminal
  isTerminal(jobId) {
    const j = this.data.jobs[jobId];
    return !!j && TERMINAL.has(j.status);
  }

  // R1: attempt 级终态
  attemptTerminal(jobId, attemptId) {
    const rec = this.attemptRecord(jobId, attemptId);
    return !!rec && TERMINAL.has(rec.status);
  }

  attemptRecord(jobId, attemptId) {
    return this.data.jobs[jobId]?.attemptResults?.[attemptId] ?? null;
  }

  beginAttempt(jobId, attempt) {
    const prev = this.data.jobs[jobId] ?? { history: [] };
    const attemptId = attempt.attemptId;
    prev.attemptResults ??= {};
    prev.history ??= [];
    const sameAttempt = prev.attemptId === attemptId;
    // 种子注入（测试/兼容）：attempt 参数里直接带终态与已发报告时，登记为该 attempt 的记录
    if (!prev.attemptResults[attemptId] && attempt.reportId && (attempt.lastReport || TERMINAL.has(attempt.status))) {
      prev.attemptResults[attemptId] = {
        status: attempt.status,
        reportId: attempt.reportId,
        report: { ...(attempt.lastReport ?? {}) },
      };
    }
    if (!prev.attemptResults[attemptId]) prev.attemptResults[attemptId] = { status: "running" };
    const seed = prev.attemptResults[attemptId];
    const record = {
      jobId,
      ticketId: attempt.ticketId ?? prev.ticketId,
      taskId: attempt.taskId ?? prev.taskId,
      workspace: attempt.workspace ?? prev.workspace,
      contextVersion: attempt.contextVersion ?? prev.contextVersion,
      attemptId,
      // 同 attempt 重入 = 恢复；新 attempt = 全新执行，不重放旧状态
      status: seed.status && TERMINAL.has(seed.status) ? seed.status : (sameAttempt ? (prev.status === "running" ? "resuming" : prev.status) : "running"),
      seq: sameAttempt ? (prev.seq ?? 0) : 0,
      checkpoint: (sameAttempt ? prev.checkpoint : null) ?? seed.checkpoint ?? null,
      history: prev.history,
      attemptResults: prev.attemptResults,
      sessionId: sameAttempt ? prev.sessionId : undefined,
      updatedAt: Date.now(),
    };
    if (prev.attemptId && !sameAttempt) record.history.push(prev.attemptId);
    this.data.jobs[jobId] = record;
    this.flush();
    return record;
  }

  update(jobId, patch) {
    const j = this.data.jobs[jobId];
    if (!j) return null;
    Object.assign(j, patch, { updatedAt: Date.now() });
    this.flush();
    return j;
  }

  nextSeq(jobId) {
    const j = this.data.jobs[jobId];
    if (!j) return 0;
    j.seq = (j.seq ?? 0) + 1;
    this.flush();
    return j.seq;
  }

  // 恢复判定：attempt 匹配且仍在活动状态（共享约定：不随便 continue 最近会话）
  resumableAttempt(jobId, attemptId) {
    const j = this.data.jobs[jobId];
    return !!j && j.attemptId === attemptId && ["running", "resuming", "blocked"].includes(j.status);
  }

  // R1: 登记会话 = 该 attempt 检查点里记录且匹配的 sessionId
  sessionIsRegistered(jobId, attemptId, sessionId) {
    const j = this.data.jobs[jobId];
    if (!j || j.attemptId !== attemptId) return false;
    const registered = j.checkpoint?.sessionId ?? j.sessionId;
    return !!registered && registered === sessionId;
  }

  // R1: 记录某 attempt 的完整报告（重发时原样保留）
  recordAttemptReport(jobId, attemptId, { status, reportId, report }) {
    const j = this.data.jobs[jobId];
    if (!j) return;
    j.attemptResults ??= {};
    j.attemptResults[attemptId] = {
      ...(j.attemptResults[attemptId] ?? {}),
      status, reportId, report, checkpoint: report?.checkpoint ?? j.attemptResults[attemptId]?.checkpoint ?? null,
    };
    this.flush();
  }

  // R1: 取某 attempt 已发出的完整报告（同 attempt 重复投递时重发）
  getAttemptReport(jobId, attemptId) {
    const rec = this.attemptRecord(jobId, attemptId);
    if (!rec || !TERMINAL.has(rec.status) || !rec.reportId) return null;
    return { status: rec.status, reportId: rec.reportId, report: rec.report ?? {} };
  }

  checkpointHash(checkpoint) {
    return createHash("sha256").update(JSON.stringify(checkpoint ?? {})).digest("hex").slice(0, 16);
  }
}
