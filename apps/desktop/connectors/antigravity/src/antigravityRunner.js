import { spawn,spawnSync } from 'child_process';
import path from 'path';
import fs from 'fs';

export class AntigravityRunner {
  /**
   * @param {object} options
   * @param {string} [options.agyPath] Path to agy.exe
   * @param {string} [options.defaultModel]
   */
  constructor(options = {}) {
    const found=spawnSync(process.platform==='win32'?'where.exe':'which',['agy'],{encoding:'utf8',windowsHide:true});
    this.agyPath = options.agyPath || process.env.LUMA_ANTIGRAVITY_CLI || (found.status===0?found.stdout.trim().split(/\r?\n/)[0]:'');
    this.defaultModel = options.defaultModel || process.env.LUMA_ANTIGRAVITY_MODEL || '';
    this.activeChild = null;
  }

  isAvailable() {
    return Boolean(this.agyPath) && fs.existsSync(this.agyPath) && fs.statSync(this.agyPath).isFile();
  }

  /**
   * Run turn in Antigravity CLI print mode
   * @param {object} params
   * @param {string} params.prompt
   * @param {string} params.workspaceDir
   * @param {string} [params.conversationId]
   * @param {string} [params.model]
   * @param {number} [params.timeoutMs]
   * @param {boolean} [params.skipPermissions] MUST default to false
   * @param {boolean} [params.disableSlashCommands]
   * @param {AbortSignal} [params.signal] AbortSignal for immediate cancellation
   * @returns {Promise<{ ok: boolean, conversationId: string, response: string, usage: object, raw: any, cancelled?: boolean, permissionRequired?: boolean, deniedActions?: any[], error?: string }>}
   */
  async runTurn(params) {
    if (!this.isAvailable()) {
      throw new Error(`Antigravity executable not found at ${this.agyPath}`);
    }

    const {
      prompt,
      workspaceDir,
      conversationId,
      model,
      mode,
      timeoutMs = 300000, // Default 5 minutes (bounded budget, max 10 minutes)
      maxTimeoutMs = 600000,
      skipPermissions = false,
      disableSlashCommands = true,
      signal,
    } = params;

    const startTime = Date.now();
    const effectiveTimeoutMs = Math.min(Math.max(timeoutMs, 1000), maxTimeoutMs);

    // Check if already aborted before starting
    if (signal && signal.aborted) {
      return {
        ok: false,
        cancelled: true,
        cancelReason: 'signal_aborted',
        conversationId: null,
        response: null,
        durationSeconds: 0,
        budgetMs: effectiveTimeoutMs,
        error: 'Execution aborted before start',
      };
    }

    // Windows argument length limit is ~8191 characters.
    // If prompt is large, we pass it via stdin using --input-format text to prevent ENAMETOOLONG.
    const useStdin = prompt && prompt.length > 2000;

    let args;
    if (params.customArgsBuilder) {
      args = params.customArgsBuilder({ prompt, useStdin, mode });
    } else {
      args = [
        '--output-format', 'json'
      ];

      if (useStdin) {
        args.push('--input-format', 'text');
      } else {
        args.push('-p', prompt);
      }

      if (mode) {
        args.push('--mode', mode);
      }

      if (disableSlashCommands) {
        args.push('--disable-slash-commands');
      }

      if (model) {
        args.push('--model', model);
      }

      if (conversationId) {
        args.push('--conversation', conversationId);
      }

      if (skipPermissions) {
        args.push('--dangerously-skip-permissions');
      }
    }

    return new Promise((resolve, reject) => {
      let stdoutData = '';
      let stderrData = '';
      let timer = null;
      let hasFinished = false;
      let isCancelled = false;
      let cancelReason = null;

      let child;
      try {
        child = spawn(this.agyPath, args, {
          cwd: workspaceDir,
          env: { ...process.env },
          windowsHide: true,
          stdio: [useStdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
        });
      } catch (err) {
        return resolve({
          ok: false,
          conversationId: null,
          response: null,
          durationSeconds: (Date.now() - startTime) / 1000,
          budgetMs: effectiveTimeoutMs,
          errorType: 'process_spawn_error',
          error: `Failed to spawn CLI process: ${err.message}`,
          raw: err.message,
        });
      }

      this.activeChild = child;

      if (useStdin && child.stdin) {
        child.stdin.write(prompt, 'utf8', (err) => {
          if (!err) {
            child.stdin.end();
          }
        });
        child.stdin.on('error', () => {
          // Ignore EPIPE if child exited early
        });
      }

      const terminateChild = (reason) => {
        if (hasFinished) return;
        isCancelled = true;
        cancelReason = reason;
        try {
          child.kill('SIGTERM');
        } catch (e) {}
        setTimeout(() => {
          if (!hasFinished) {
            try { child.kill('SIGKILL'); } catch (e) {}
          }
        }, 1000);
      };

      if (signal) {
        signal.addEventListener('abort', () => {
          terminateChild('signal_aborted');
        }, { once: true });
      }

      if (effectiveTimeoutMs > 0) {
        timer = setTimeout(() => {
          terminateChild('timeout');
        }, effectiveTimeoutMs);
      }

      child.stdout.on('data', (data) => {
        stdoutData += data.toString();
      });

      child.stderr.on('data', (data) => {
        stderrData += data.toString();
      });

      child.on('close', (code) => {
        hasFinished = true;
        if (timer) clearTimeout(timer);
        this.activeChild = null;

        const durationSeconds = (Date.now() - startTime) / 1000;

        if (isCancelled || (signal && signal.aborted)) {
          const finalCancelReason = cancelReason || (signal && signal.aborted ? 'signal_aborted' : 'cancelled');
          return resolve({
            ok: false,
            cancelled: true,
            cancelReason: finalCancelReason,
            conversationId: null,
            response: null,
            durationSeconds,
            budgetMs: effectiveTimeoutMs,
            error: finalCancelReason === 'timeout'
              ? `Execution timed out after ${durationSeconds.toFixed(1)}s (budget: ${effectiveTimeoutMs / 1000}s)`
              : `Execution cancelled by ${finalCancelReason}`,
            raw: stderrData || stdoutData,
          });
        }

        if (code !== 0) {
          return resolve({
            ok: false,
            conversationId: null,
            response: null,
            durationSeconds,
            budgetMs: effectiveTimeoutMs,
            errorType: 'cli_exit_error',
            exitCode: code,
            error: `agy exited with code ${code}: ${(stderrData || stdoutData).slice(0, 300)}`,
            raw: stderrData || stdoutData
          });
        }

        const trimmed = stdoutData.trim();
        const firstBrace = trimmed.indexOf('{');
        const lastBrace = trimmed.lastIndexOf('}');
        if (firstBrace === -1 || lastBrace === -1) {
          return resolve({
            ok: false,
            conversationId: null,
            response: null,
            durationSeconds,
            budgetMs: effectiveTimeoutMs,
            errorType: 'output_parse_error',
            error: `Non-JSON output from CLI: ${trimmed.slice(0, 200)}`,
            raw: trimmed
          });
        }

        const jsonStr = trimmed.substring(firstBrace, lastBrace + 1);
        let parsed;
        try {
          parsed = JSON.parse(jsonStr);
        } catch (e) {
          return resolve({
            ok: false,
            conversationId: null,
            response: null,
            durationSeconds,
            budgetMs: effectiveTimeoutMs,
            errorType: 'output_parse_error',
            error: `Malformed JSON from CLI: ${e.message}`,
            raw: trimmed
          });
        }

        const isSuccess = parsed.status === 'SUCCESS';
        const deniedActions = parsed.denied_actions || [];
        const isPermissionDenied = deniedActions.length > 0;

        return resolve({
          ok: isSuccess && !isPermissionDenied,
          conversationId: parsed.conversation_id || null,
          response: parsed.response || null,
          usage: parsed.usage || null,
          durationSeconds: parsed.duration_seconds || durationSeconds,
          budgetMs: effectiveTimeoutMs,
          deniedActions,
          permissionRequired: isPermissionDenied,
          error: isPermissionDenied
            ? `Permission required: tool '${deniedActions[0]?.display_name || deniedActions[0]?.action}' requires permission in headless mode (workspace: ${workspaceDir})`
            : (!isSuccess ? `CLI reported status: ${parsed.status}` : null),
          raw: parsed
        });
      });

      child.on('error', (err) => {
        hasFinished = true;
        if (timer) clearTimeout(timer);
        this.activeChild = null;
        resolve({
          ok: false,
          conversationId: null,
          response: null,
          durationSeconds: (Date.now() - startTime) / 1000,
          budgetMs: effectiveTimeoutMs,
          errorType: 'process_error',
          error: `Process error: ${err.message}`,
          raw: err.message,
        });
      });
    });
  }
}
