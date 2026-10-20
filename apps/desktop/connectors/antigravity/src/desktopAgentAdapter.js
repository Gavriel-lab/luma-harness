import fs from 'fs';
import path from 'path';
import crypto from 'node:crypto';
import { BrokerClient } from './brokerClient.js';
import { AntigravityRunner } from './antigravityRunner.js';
import { ContextValidator } from './contextValidator.js';
import { CheckpointStore } from './checkpoint.js';
import { EVENT_TYPES, REPORT_OUTCOMES, ERROR_CODES, EXECUTION_MODES } from './types.js';

export class DesktopAgentAdapter {
  /**
   * @param {object} options
   * @param {BrokerClient} options.brokerClient
   * @param {AntigravityRunner} options.runner
   * @param {CheckpointStore} options.checkpointStore
   * @param {string} [options.agentId]
   * @param {string} [options.executorId]
   */
  constructor(options) {
    this.agentId = options.agentId || 'agent_editor';
    this.executorId = options.executorId || 'antigravity-adapter';
    this.brokerClient = options.brokerClient;
    this.runner = options.runner;
    this.checkpointStore = options.checkpointStore;

    this.currentJob = null;
    this.heartbeatTimer = null;
    this.seq = 0;
    this.isExecuting = false;
    this.activeAbortController = null;
  }

  _nextSeq() {
    return ++this.seq;
  }

  cancelCurrentJob() {
    if (this.activeAbortController) {
      this.activeAbortController.abort();
      return true;
    }
    return false;
  }

  async runOnce() {
    if (this.isExecuting) {
      console.warn('[DesktopAgentAdapter] Adapter is already executing a task. Skipping overlapping cycle.');
      return { status: 'busy', message: 'In-flight task execution in progress' };
    }

    this.isExecuting = true;
    try {
      return await this._executeCycle();
    } finally {
      this.isExecuting = false;
    }
  }

  /**
   * Extract declared required artifacts from goal, acceptance, and explicit job artifacts
   * @param {object} job
   * @returns {string[]}
   */
  _extractRequiredArtifacts(job) {
    // 1. If job explicitly specifies required artifacts array, use it directly!
    if (Array.isArray(job.requiredArtifacts) && job.requiredArtifacts.length > 0) {
      return Array.from(new Set(job.requiredArtifacts));
    }
    if (Array.isArray(job.artifacts) && job.artifacts.length > 0) {
      const explicit = job.artifacts.map(a => typeof a === 'string' ? a : (a.name || a.path)).filter(Boolean);
      if (explicit.length > 0) return Array.from(new Set(explicit));
    }

    // 2. Extract from explicit action phrases:
    // "新建/创建/生成/交付 [file]" or "new [file]" or "create a new [file]" or "report: [file]"
    const text = `${job.goal || ''} ${job.acceptance || ''}`;
    const explicitPatterns = [
      /(?:新建|创建|生成|交付|产物|写入|output|create(?:\s+a)?(?:\s+new)?)\s*(?:根目录交付文件|交付文件|文件)?\s*[`'"]?([a-zA-Z0-9_\-\.]+\.(?:txt|md|json|js|ts|html|css|py))[`'"]?/gi,
      /[`'"]([a-zA-Z0-9_\-\.]+\.(?:txt|md|json|js|ts|html|css|py))[`'"]\s*(?:must contain|包含)/gi,
      /([a-zA-Z0-9_\-\.]+\.(?:txt|md|json|js|ts|html|css|py))\s+must contain/gi,
    ];

    const results = new Set();
    for (const pattern of explicitPatterns) {
      let m;
      while ((m = pattern.exec(text)) !== null) {
        const file = m[1];
        if (file && file !== 'AGENTS.md' && file !== 'package.json') {
          results.add(file);
        }
      }
    }

    if (results.size > 0) {
      return Array.from(results);
    }

    // 3. Fallback: general match excluding common referenced metadata files
    const matches = text.match(/[a-zA-Z0-9_\-\.]+\.(txt|md|json|js|ts|html|css|py)/g);
    if (!matches) return [];
    const blacklist = new Set(['AGENTS.md', 'package.json', 'tsconfig.json', 'settings.json']);
    return Array.from(new Set(matches.filter(m => !blacklist.has(m))));
  }

  /**
   * Extract required canary / content snippet without swallowing trailing Chinese or punctuation
   * @param {object} job
   * @returns {string|null}
   */
  _extractRequiredContentSnippet(job) {
    if (job.canary) return job.canary;
    const text = `${job.goal || ''} ${job.acceptance || ''}`;

    // Match alphanumeric + underscores identifier, stopping strictly before Chinese characters or punctuation:
    // e.g. "must contain LUMA_SELF_CHECK_20261007。报告写本人身份" -> "LUMA_SELF_CHECK_20261007"
    const mustContain = text.match(/must contain\s+[`'"]?([A-Za-z0-9_\-]+)[`'"]?/i) ||
                        text.match(/包含[：:\s]*[`'"]?([A-Za-z0-9_\-]+)[`'"]?/);
    return mustContain ? mustContain[1] : null;
  }

  _matchesToken(content, token) {
    if (!token) return true;
    if (!content) return false;
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`(?:^|[^A-Za-z0-9_-])${escaped}(?:$|[^A-Za-z0-9_-])`);
    return regex.test(content);
  }

  _validateArtifactBinding(content, job) {
    if (!content || !job) return !job?.requireTaskBinding;
    // Treat Markdown labels/backticks as presentation, while retaining underscores in IDs.
    const plain = content.replace(/[`*]/g, '');
    const declared = label => [...plain.matchAll(new RegExp(`(?:^|\\n)\\s*(?:[-+]\\s*)?(?:${label})(?:\\s*ID)?\\s*[:：]\\s*([A-Za-z0-9_-]+)`, 'gi'))].map(m => m[1]);
    const tickets = declared('Ticket|工单'), tasks = declared('Task|任务');
    if (job.requireTaskBinding && (!job.ticketId || !job.taskId || !tickets.length || !tasks.length)) return false;
    if (tickets.some(id => job.ticketId && id !== job.ticketId) || tasks.some(id => job.taskId && id !== job.taskId)) return false;
    return true;
  }

  _artifactDigest(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }

  _sourceReceipt(packet, job, files, canary) {
    // Only host-owned checkpoints can establish provenance; a marker in a workspace file cannot.
    for (const name of fs.readdirSync(this.checkpointStore.storageDir)) {
      if (!/^checkpoint_[A-Za-z0-9_-]+\.json$/.test(name)) continue;
      let cp; try { cp = JSON.parse(fs.readFileSync(path.join(this.checkpointStore.storageDir, name), 'utf8')); } catch { continue; }
      if (!['review_ready','submitted'].includes(cp.phase) || !cp.reportId || !cp.attemptId || !cp.jobId) continue;
      if (cp.agentId !== packet.agentId || cp.executorId !== packet.executorId || cp.homeId !== packet.homeId || cp.ticketId !== job.ticketId || cp.taskId !== job.taskId) continue;
      if (path.resolve(cp.workspace || '') !== path.resolve(job.workspace)) continue;
      const verified = files.every(file => {
        const result = this._validateExistingArtifact(job.workspace, file, canary, {...job,requireTaskBinding:true});
        const prior = cp.artifacts?.find(a => path.resolve(a.path) === path.resolve(job.workspace, file));
        return result.valid && /^[a-f0-9]{64}$/.test(prior?.sha256 || '') && prior.sha256 === this._artifactDigest(result.path);
      });
      if (verified) return {jobId:cp.jobId,attemptId:cp.attemptId,reportId:cp.reportId,artifacts:cp.artifacts};
    }
    return null;
  }

  _isSafePathWithinWorkspace(filePath, workspaceDir) {
    const normWs = path.normalize(path.resolve(workspaceDir));
    const fullPath = path.normalize(path.resolve(normWs, filePath));
    const rel = path.relative(normWs, fullPath);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return false;
    try {
      const realWs = fs.realpathSync(normWs);
      let existing = fullPath;
      while (!fs.existsSync(existing)) {
        const parent = path.dirname(existing);
        if (parent === existing) return false;
        existing = parent;
      }
      const relReal = path.relative(realWs, fs.realpathSync(existing));
      if (relReal.startsWith('..') || path.isAbsolute(relReal)) return false;
    } catch (e) {
      return false;
    }
    return true;
  }

  _validateExistingArtifact(normWs, file, canary, job) {
    if (!this._isSafePathWithinWorkspace(file, normWs)) {
      return { valid: false, reason: 'outside_workspace' };
    }
    const fp = path.join(normWs, file);
    if (!fs.existsSync(fp)) return { valid: false, reason: 'file_not_found' };
    let stat;
    try {
      stat = fs.statSync(fp);
    } catch (e) {
      return { valid: false, reason: 'stat_failed' };
    }
    if (!stat.isFile()) return { valid: false, reason: 'not_a_file' };
    const text = fs.readFileSync(fp, 'utf8');
    if (canary && !this._matchesToken(text, canary)) {
      return { valid: false, reason: 'canary_missing' };
    }
    if (!this._validateArtifactBinding(text, job)) {
      return { valid: false, reason: 'task_binding_mismatch' };
    }
    return { valid: true, path: fp, size: stat.size };
  }

  async _executeCycle() {
    // 1. Session check
    const session = await this.brokerClient.getSession();
    if (session.agentId !== this.agentId) {
      throw {
        ok: false,
        code: ERROR_CODES.FORBIDDEN,
        message: `AgentId mismatch: expected ${this.agentId}, broker returned ${session.agentId}`,
        retryable: false,
      };
    }

    // 2. Claim job
    const claimRes = await this.brokerClient.claimJob(`req_claim_${Date.now()}`, {
      runner: 'antigravity',
      version: '1.2.14',
    });

    if (!claimRes || !claimRes.job) {
      return { status: 'idle', message: 'No job available for Worker' };
    }

    const job = claimRes.job;
    this.currentJob = job;
    this.seq = 0;

    // Start heartbeat
    this._startHeartbeat(job.jobId, job.attemptId);

    try {
      // 3. Fetch authoritative context packet first
      const contextRes = await this.brokerClient.getContext(
        `req_ctx_${Date.now()}`,
        job.jobId,
        job.attemptId
      );

      const packet = contextRes.packet;
      const validation = ContextValidator.validate(packet, {
        agentId: this.agentId,
        executorId: this.executorId,
        job: job,
      });

      if (!validation.valid) {
        await this.brokerClient.sendEvent(
          `req_evt_${Date.now()}`,
          job.jobId,
          job.attemptId,
          this._nextSeq(),
          EVENT_TYPES.BLOCKED,
          `ContextPacket validation failed: ${validation.errors.join('; ')}`
        );

        await this.brokerClient.report(
          `req_rep_${Date.now()}`,
          job.jobId,
          job.attemptId,
          {
            reportId: `rep_${Date.now()}`,
            outcome: REPORT_OUTCOMES.FAILED,
            summary: `ContextPacket validation failed: missing essential persona or job scope`,
            artifacts: [],
            checks: [{ name: 'context_validation', pass: false, error: validation.errors }],
            checkpoint: null,
            unknowns: validation.errors,
          }
        );

        return { status: 'failed', error: validation.errors };
      }

      // Options come only from the authoritative packet, never model text or a local override.
      for (const key of ['requiredArtifacts','canary','pureAnalysis','resubmitOnly','requireTaskBinding']) {
        if (packet.job[key] !== undefined) job[key] = packet.job[key];
      }
      if (job.pureAnalysis || job.resubmitOnly) job.requireTaskBinding = true;

      // Check existing checkpoint for this attempt, now with full authoritative binding check
      let existingCheckpoint = this.checkpointStore.load(job.jobId, {
        agentId: this.agentId,
        homeId: packet.homeId,
        executorId: this.executorId,
        workspace: job.workspace,
        attemptId: job.attemptId,
        contextVersion: packet.contextVersion,
      });

      // Idempotent guard: if this attempt is already submitted / review_ready, DO NOT rerun side effects!
      // Also check if valid report artifact already exists on disk from a previous attempt/round:
      const normWs = path.normalize(path.resolve(job.workspace));
      const requiredArtifactsEarly = this._extractRequiredArtifacts(job);
      const canaryEarly = this._extractRequiredContentSnippet(job);
      const hasExistingValidArtifacts = requiredArtifactsEarly.length > 0 && requiredArtifactsEarly.every(file => {
        const val = this._validateExistingArtifact(normWs, file, canaryEarly, job);
        return val.valid;
      });

      if (existingCheckpoint && (existingCheckpoint.phase === 'review_ready' || existingCheckpoint.phase === 'submitted')) {
        const receiptsValid = requiredArtifactsEarly.length > 0 && requiredArtifactsEarly.every(file => {
          const current = this._validateExistingArtifact(normWs, file, canaryEarly, job);
          const previous = existingCheckpoint.artifacts?.find(a => path.resolve(a.path) === path.resolve(normWs, file));
          return current.valid && /^[a-f0-9]{64}$/.test(previous?.sha256 || '') && previous.sha256 === this._artifactDigest(current.path);
        });
        if (!receiptsValid || !existingCheckpoint.lastReportPayload) throw new Error('Verified report receipt is missing, replaced, or changed; do not replay or restart the model');
        console.log(`[DesktopAgentAdapter] Job attempt ${job.jobId}/${job.attemptId} already completed in review_ready. Resubmitting idempotent report without rerun.`);
        const reportRes = await this.brokerClient.report(
          `req_rep_${existingCheckpoint.reportId || Date.now()}`,
          job.jobId,
          job.attemptId,
          existingCheckpoint.lastReportPayload || {
            reportId: existingCheckpoint.reportId || `rep_${Date.now()}`,
            outcome: REPORT_OUTCOMES.SUBMITTED,
            summary: `编辑助手已完成工单任务（幂等重报，未重复执行副作用）。`,
            artifacts: existingCheckpoint.artifacts || [],
            checks: [{ name: 'idempotent_replay', pass: true }],
            checkpoint: existingCheckpoint,
            unknowns: [],
          }
        );
        return { status: 'submitted', jobId: job.jobId, reportRes, checkpoint: existingCheckpoint, idempotent: true };
      }

      // If checkpoint has verified artifacts or files already exist with valid canary, allow explicit resubmission of existing report
      const sourceReceipt = hasExistingValidArtifacts && job.resubmitOnly ? this._sourceReceipt(packet, job, requiredArtifactsEarly, canaryEarly) : null;
      if (hasExistingValidArtifacts && sourceReceipt && job.resubmitOnly) {
        console.log(`[DesktopAgentAdapter] Job attempt ${job.jobId}/${job.attemptId} has valid existing artifacts on disk. Submitting existing report without rerunning model.`);
        const verifiedList = requiredArtifactsEarly.map(f => {
          const fp = path.join(normWs, f);
          return {
            name: f,
            path: fp,
            size: fs.statSync(fp).size,
            operation: 'resubmit_existing',
            isNewlyCreated: false,
            sha256: this._artifactDigest(fp),
            generatedJobId: sourceReceipt.artifacts.find(a => path.resolve(a.path) === path.resolve(fp))?.generatedJobId || sourceReceipt.jobId,
            generatedAttemptId: sourceReceipt.artifacts.find(a => path.resolve(a.path) === path.resolve(fp))?.generatedAttemptId || sourceReceipt.attemptId,
            generatedReportId: sourceReceipt.artifacts.find(a => path.resolve(a.path) === path.resolve(fp))?.generatedReportId || sourceReceipt.reportId,
          };
        });
        const reportId = `rep_${Date.now()}`;
        const reportPayload = {
          reportId,
          outcome: REPORT_OUTCOMES.SUBMITTED,
          summary: `编辑助手已递交既有报告（重交既有产物，未调用模型，保留原生成记录）。`,
          artifacts: verifiedList,
          checks: [
            { name: 'persona_loaded', pass: true },
            { name: 'artifacts_verified', pass: true },
            { name: 'resubmit_existing_artifact', pass: true },
          ],
          checkpoint: {
            homeId: packet.homeId,
            agentId: packet.agentId,
            executorId: packet.executorId,
            ticketId: job.ticketId,
            taskId: job.taskId,
            workspace: job.workspace,
            jobId: job.jobId,
            attemptId: job.attemptId,
            phase: 'review_ready',
            artifacts: verifiedList,
            reportId,
          },
          unknowns: [],
        };
        const saved = {...reportPayload.checkpoint, contextVersion:packet.contextVersion || 1, lastReportPayload:reportPayload};
        this.checkpointStore.save(job.jobId, saved);
        const reportRes = await this.brokerClient.report(`req_rep_${reportId}`, job.jobId, job.attemptId, reportPayload);
        return { status: 'submitted', jobId: job.jobId, reportRes, artifacts: verifiedList, resubmitted: true };
      }

      // If job explicitly asked for resubmitOnly but valid existing artifacts are missing or invalid, FAIL immediately without running model!
      if (job.resubmitOnly || packet.job?.resubmitOnly) {
        const errorReason = `Resubmit failed: required existing artifacts are missing, invalid, or task-binding mismatched.`;
        console.warn(`[DesktopAgentAdapter] ${errorReason}`);
        const reportId = `rep_${Date.now()}`;
        await this.brokerClient.report(
          `req_rep_${reportId}`,
          job.jobId,
          job.attemptId,
          {
            reportId,
            outcome: REPORT_OUTCOMES.FAILED,
            summary: errorReason,
            artifacts: [],
            checks: [
              { name: 'persona_loaded', pass: true },
              { name: 'resubmit_existing_artifact', pass: false, error: errorReason },
            ],
            checkpoint: existingCheckpoint || null,
            unknowns: [errorReason],
          }
        );
        return { status: 'failed', jobId: job.jobId, error: errorReason, resubmitFailed: true };
      }

      // Context version & session invalidation check
      let sessionId = null;
      if (existingCheckpoint && !existingCheckpoint.sessionInvalidated) {
        sessionId = existingCheckpoint.sessionId;
      }

      let checkpoint = existingCheckpoint || {
        jobId: job.jobId,
        ticketId: job.ticketId,
        taskId: job.taskId,
        attemptId: job.attemptId,
        homeId: packet.homeId,
        agentId: this.agentId,
        executorId: this.executorId,
        workspace: job.workspace,
        contextVersion: packet.contextVersion || 1,
        phase: 'started',
        sessionId: sessionId,
        continuity: {
          completed: [],
          remaining: [job.goal],
          blockers: null,
          nextAction: packet.continuity?.nextAction || 'Invoke Antigravity runner',
          otherOpenTasks: packet.continuity?.otherOpenTasks || [],
        },
      };

      // Ensure that if session was invalidated, checkpoint.sessionId is explicitly cleared!
      checkpoint.sessionId = sessionId;
      checkpoint.contextVersion = packet.contextVersion || checkpoint.contextVersion || 1;
      this.checkpointStore.save(job.jobId, checkpoint);

      await this.brokerClient.sendEvent(
        `req_evt_${Date.now()}`,
        job.jobId,
        job.attemptId,
        this._nextSeq(),
        EVENT_TYPES.STARTED,
        `编辑助手已领取任务：${job.goal}，准备启动 Antigravity 运行`,
        checkpoint
      );

      const prompt = ContextValidator.buildPrompt(packet, checkpoint);

      await this.brokerClient.sendEvent(
        `req_evt_${Date.now()}`,
        job.jobId,
        job.attemptId,
        this._nextSeq(),
        EVENT_TYPES.PROGRESS,
        `正在向 Antigravity 会话发送任务与记忆锚点...`,
        checkpoint
      );

      // Snapshot workspace before run to check NEW/MODIFIED files and contents
      const beforeFilesMap = new Map();
      if (fs.existsSync(normWs)) {
        for (const file of fs.readdirSync(normWs)) {
          const fp = path.join(normWs, file);
          try {
            const stat = fs.statSync(fp);
            if (stat.isFile()) {
              beforeFilesMap.set(file, {
                mtimeMs: stat.mtimeMs,
                size: stat.size,
                content: fs.readFileSync(fp, 'utf8'),
              });
            }
          } catch (e) {}
        }
      }

      this.activeAbortController = new AbortController();

      const execRes = await this.runner.runTurn({
        prompt,
        workspaceDir: job.workspace,
        conversationId: checkpoint.sessionId,
        timeoutMs: packet.job?.timeoutMs || 300000,
        maxTimeoutMs: 600000,
        model: packet.job?.model || this.runner.defaultModel,
        mode: packet.job?.pureAnalysis ? 'plan' : (packet.job?.mode || 'accept-edits'),
        skipPermissions: false,
        signal: this.activeAbortController.signal,
      });

      this.activeAbortController = null;

      if (!execRes.ok) {
        if (execRes.cancelled) {
          const reason = execRes.cancelReason || 'cancelled';
          const isTimeout = reason === 'timeout';
          checkpoint.phase = 'cancelled';
          checkpoint.continuity.remaining = [job.goal];
          checkpoint.continuity.blockers = isTimeout
            ? `Execution timed out after ${execRes.durationSeconds?.toFixed(1) || '?'}s (budget: ${(execRes.budgetMs || 300000) / 1000}s)`
            : `Execution cancelled by ${reason}`;
          checkpoint.continuity.nextAction = '等待重新调度';
          this.checkpointStore.save(job.jobId, checkpoint);

          await this.brokerClient.report(
            `req_rep_${Date.now()}`,
            job.jobId,
            job.attemptId,
            {
              reportId: `rep_${Date.now()}`,
              outcome: REPORT_OUTCOMES.CANCELLED,
              summary: isTimeout
                ? `任务执行超时（耗时 ${execRes.durationSeconds?.toFixed(1) || '?'}s，超出预算 ${(execRes.budgetMs || 300000) / 1000}s，子进程已安全收尾）。`
                : `任务执行已取消（原因: ${reason}，本地及子进程已终止，终态已上报）。`,
              artifacts: [],
              checks: [
                { name: 'execution_cancelled', pass: true, reason }
              ],
              checkpoint,
              unknowns: [reason],
            }
          );

          return { status: 'cancelled', jobId: job.jobId, reason };
        }

        if (execRes.permissionRequired) {
          await this.brokerClient.sendEvent(
            `req_evt_${Date.now()}`,
            job.jobId,
            job.attemptId,
            this._nextSeq(),
            EVENT_TYPES.PERMISSION_REQUIRED,
            execRes.error,
            checkpoint
          );

          await this.brokerClient.report(
            `req_rep_${Date.now()}`,
            job.jobId,
            job.attemptId,
            {
              reportId: `req_rep_${Date.now()}`,
              outcome: REPORT_OUTCOMES.FAILED,
              summary: `执行挂起：${execRes.error}。受限目录与操作需显式配置或在桌面端授权。`,
              artifacts: [],
              checks: [
                { name: 'persona_loaded', pass: true },
                { name: 'permission_granted', pass: false, error: execRes.error },
              ],
              checkpoint,
              unknowns: [execRes.error],
            }
          );

          return {
            status: 'permission_required',
            jobId: job.jobId,
            error: execRes.error,
            deniedActions: execRes.deniedActions,
            checkpoint,
          };
        }

        const failureDetail = execRes.error || execRes.raw || 'unknown execution error';
        checkpoint.phase = 'failed';
        checkpoint.continuity.blockers = failureDetail;
        this.checkpointStore.save(job.jobId, checkpoint);

        await this.brokerClient.report(
          `req_rep_${Date.now()}`,
          job.jobId,
          job.attemptId,
          {
            reportId: `rep_${Date.now()}`,
            outcome: REPORT_OUTCOMES.FAILED,
            summary: `Antigravity CLI 执行失败: ${failureDetail}`,
            artifacts: [],
            checks: [
              { name: 'persona_loaded', pass: true },
              { name: 'cli_execution', pass: false, error: failureDetail },
            ],
            checkpoint,
            unknowns: [failureDetail],
          }
        );

        return {
          status: 'failed',
          jobId: job.jobId,
          error: failureDetail,
          checkpoint,
        };
      }

      checkpoint.sessionId = execRes.conversationId || checkpoint.sessionId;

      // 6. Strict Artifact verification:
      // Verify SPECIFIC REQUIRED ARTIFACTS requested in goal/acceptance
      const requiredArtifacts = this._extractRequiredArtifacts(job);
      const isPureAnalysis = packet.job?.pureAnalysis === true || packet.job?.role === 'analysis';
      const requiredContentSnippet = this._extractRequiredContentSnippet(job);

      // If pure analysis task and response is available, allow bridge layer to persist response directly if requested
      if (isPureAnalysis && requiredArtifacts.length === 1 && execRes.response) {
        const targetFile = requiredArtifacts[0];
        if (this._isSafePathWithinWorkspace(targetFile, normWs)) {
          const fullPath = path.join(normWs, targetFile);
          if (!fs.existsSync(fullPath)) {
            // Pure analysis: persist model reply to artifact on behalf of model VERBATIM without injecting canary or metadata!
            fs.writeFileSync(fullPath, execRes.response, 'utf8');
          }
        }
      }

      const verifiedArtifacts = [];
      const missingArtifacts = [];

      // Check if job requires specific content or creation
      const textRequirement = `${job.goal || ''} ${job.acceptance || ''}`;
      const mustBeNew = /new|新建|新产物|create a new/i.test(textRequirement);

      for (const reqArt of requiredArtifacts) {
        if (!this._isSafePathWithinWorkspace(reqArt, normWs)) {
          missingArtifacts.push(`${reqArt} (path traversal or symlink outside workspace)`);
          continue;
        }

        const fullPath = path.join(normWs, reqArt);
        if (fs.existsSync(fullPath)) {
          const stat = fs.statSync(fullPath);
          if (stat.isFile()) {
            const beforeRecord = beforeFilesMap.get(reqArt);
            const isNewlyCreated = !beforeRecord;
            const currentContent = fs.readFileSync(fullPath, 'utf8');

            let passedContentCheck = true;
            if (requiredContentSnippet && !this._matchesToken(currentContent, requiredContentSnippet)) {
              passedContentCheck = false;
            }

            if (!this._validateArtifactBinding(currentContent, job)) {
              missingArtifacts.push(`${reqArt} (task/ticket binding mismatch)`);
              continue;
            }

            // If required to be newly created, and file existed before and content didn't change: FAIL!
            if (mustBeNew && !isNewlyCreated && beforeRecord && beforeRecord.content === currentContent) {
              missingArtifacts.push(`${reqArt} (unchanged pre-existing file without required new creation)`);
              continue;
            }

            if (!passedContentCheck) {
              missingArtifacts.push(`${reqArt} (content does not satisfy required pattern: ${requiredContentSnippet})`);
              continue;
            }

            verifiedArtifacts.push({
              name: reqArt,
              path: fullPath,
              size: stat.size,
              operation: isNewlyCreated ? 'create' : 'modify',
              isNewlyCreated,
              sha256: this._artifactDigest(fullPath),
              generatedJobId: job.jobId,
              generatedAttemptId: job.attemptId,
            });
          } else {
            missingArtifacts.push(reqArt);
          }
        } else {
          missingArtifacts.push(reqArt);
        }
      }

      // If specific files were required but none/some are missing, FAIL!
      if (requiredArtifacts.length > 0 && (verifiedArtifacts.length === 0 || missingArtifacts.length > 0)) {
        checkpoint.phase = 'execution_failed_artifact_missing';
        checkpoint.continuity.blockers = `Required artifacts missing: ${missingArtifacts.join(', ')}`;
        this.checkpointStore.save(job.jobId, checkpoint);

        await this.brokerClient.report(
          `req_rep_${Date.now()}`,
          job.jobId,
          job.attemptId,
          {
            reportId: `rep_${Date.now()}`,
            outcome: REPORT_OUTCOMES.FAILED,
            summary: `执行未生成指定产物：缺少 ${missingArtifacts.join(', ')}。旧文件或无关文件不能替代。`,
            artifacts: [],
            checks: [
              { name: 'persona_loaded', pass: true },
              { name: 'artifacts_created', pass: false, error: `Missing: ${missingArtifacts.join(', ')}` },
            ],
            checkpoint,
            unknowns: [`Artifact missing: ${missingArtifacts.join(', ')}`],
          }
        );

        return {
          status: 'failed',
          jobId: job.jobId,
          error: `Required artifacts missing: ${missingArtifacts.join(', ')}`,
          checkpoint,
        };
      }

      checkpoint.phase = 'review_ready';
      checkpoint.continuity.completed.push(job.goal);
      checkpoint.continuity.remaining = [];
      checkpoint.continuity.nextAction = '协调者验收工单交付';
      checkpoint.artifacts = verifiedArtifacts;
      checkpoint.reportId = `rep_${Date.now()}`;

      const reportPayload = {
        reportId: checkpoint.reportId,
        outcome: REPORT_OUTCOMES.SUBMITTED,
        summary: `编辑助手已通过 Antigravity 成功执行完成工单任务，指定产物已全部核实。\n核实产物：${verifiedArtifacts.map(a => a.name).join(', ')}`,
        artifacts: verifiedArtifacts,
        checks: [
          { name: 'persona_loaded', pass: true },
          { name: 'workspace_isolated', pass: true },
          { name: 'artifacts_verified', pass: true },
          { name: 'continuity_checkpointed', pass: true },
        ],
        checkpoint: { ...checkpoint },
        unknowns: [],
      };

      // Store payload without circular reference
      checkpoint.lastReportPayload = reportPayload;
      this.checkpointStore.save(job.jobId, checkpoint);

      const reportRes = await this.brokerClient.report(
        `req_rep_${checkpoint.reportId}`,
        job.jobId,
        job.attemptId,
        reportPayload
      );

      return {
        status: 'submitted',
        jobId: job.jobId,
        reportRes,
        checkpoint,
        antigravityResponse: execRes.response,
        artifacts: verifiedArtifacts,
      };

    } catch (err) {
      await this.brokerClient.sendEvent(
        `req_evt_${Date.now()}`,
        job.jobId,
        job.attemptId,
        this._nextSeq(),
        EVENT_TYPES.FAILED,
        `执行异常: ${err.message || JSON.stringify(err)}`
      );

      await this.brokerClient.report(
        `req_rep_${Date.now()}`,
        job.jobId,
        job.attemptId,
        {
          reportId: `rep_${Date.now()}`,
          outcome: REPORT_OUTCOMES.FAILED,
          summary: `执行失败: ${err.message}`,
          artifacts: [],
          checks: [{ name: 'execution', pass: false, error: err.message }],
          checkpoint: this.checkpointStore.load(job.jobId),
          unknowns: [err.message],
        }
      );

      throw err;
    } finally {
      this._stopHeartbeat();
      this.currentJob = null;
      this.activeAbortController = null;
    }
  }

  _startHeartbeat(jobId, attemptId) {
    this._stopHeartbeat();
    this.heartbeatTimer = setInterval(async () => {
      try {
        const hbRes = await this.brokerClient.sendHeartbeat(`req_hb_${Date.now()}`, jobId, attemptId);
        if (hbRes && (hbRes.revoked || hbRes.cancelled || hbRes.staleAttempt || hbRes.stale_attempt)) {
          console.warn(`[DesktopAgentAdapter] Heartbeat returned lease revocation or stale attempt for job ${jobId}/${attemptId}. Aborting current execution.`);
          this.cancelCurrentJob();
        }
      } catch (err) {
        console.error('Heartbeat error:', err.message || err.code);
        if (err.code === ERROR_CODES.STALE_ATTEMPT || err.code === ERROR_CODES.FORBIDDEN || (err.message && /stale|revok|cancel/i.test(err.message))) {
          console.warn(`[DesktopAgentAdapter] Heartbeat error indicates stale attempt or revocation: ${err.message || err.code}. Aborting current execution.`);
          this.cancelCurrentJob();
        }
      }
    }, 15000);
  }

  _stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }
}
