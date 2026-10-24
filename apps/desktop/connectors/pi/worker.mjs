import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { PiRunner } from './runner.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 运行 Pi Managed Bridge Worker
 * @param {object} options
 * @param {string} options.manifestPath
 * @param {AbortSignal} [options.signal]
 * @param {boolean} [options.runOnce=false] 单次执行模式（供测试使用）
 */
export async function runPiBridge({ manifestPath, signal: externalSignal, runOnce = false }) {
  if (!manifestPath || !fs.existsSync(manifestPath)) {
    throw new Error(`找不到 Pi Worker 声明文件: ${manifestPath}`);
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const token = fs.readFileSync(manifest.tokenFile, 'utf8').trim();

  const controller = new AbortController();
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort();
    externalSignal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  const stop = () => {
    controller.abort();
  };

  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  if (process.stdin.isTTY === false) {
    process.stdin.on('data', (data) => {
      if (String(data).trim() === 'stop') stop();
    });
  }

  const call = async (route, body) => {
    const response = await fetch(manifest.bridgeUrl + '/v1/bridge/' + route, {
      method: body ? 'POST' : 'GET',
      headers: {
        authorization: 'Bearer ' + token,
        'content-type': 'application/json'
      },
      body: body ? JSON.stringify({ schemaVersion: 1, requestId: crypto.randomUUID(), ...body }) : undefined,
      signal: AbortSignal.timeout(15000)
    });
    return response.json();
  };

  while (!controller.signal.aborted) {
    let job = null;
    let seq = 0;
    let heartbeatTimer = null;
    let runner = null;

    try {
      // 1. Claim: 领取任务
      const claim = await call('claim', { capabilities: { kinds: ['work', 'chat'] } });
      if (!claim.ok || !claim.job) {
        if (runOnce) break;
        await sleep(1500);
        continue;
      }

      job = claim.job;

      // 2. Context: 获取上下文
      const context = await call('context', { jobId: job.jobId, attemptId: job.attemptId });
      if (!context.ok) {
        await call('report', {
          jobId: job.jobId,
          attemptId: job.attemptId,
          reportId: 'rep_' + job.attemptId,
          outcome: context.code === 'stale_attempt' ? 'cancelled' : 'failed',
          summary: '未取得当前授权上下文，无法执行任务',
          artifacts: [],
          checks: [],
          checkpoint: null,
          unknowns: ['未取得授权上下文']
        });
        if (runOnce) break;
        await sleep(1500);
        continue;
      }

      const packet = context.packet;
      let cancelled = false;

      // 3. 心跳循环
      heartbeatTimer = setInterval(async () => {
        try {
          const hb = await call('heartbeat', { jobId: job.jobId, attemptId: job.attemptId });
          if (!hb.ok || hb.attemptState === 'cancelling') {
            cancelled = true;
            if (runner) runner.abort();
          }
        } catch {
          // 网络抖动忽略，Broker 允许超时宽限
        }
      }, 5000);

      // 4. 串行事件队列：严格保证顺序并在 report 前等待全部事件送达
      let eventSeq = 0;
      let eventChain = Promise.resolve();
      const eventErrors = [];

      const enqueueEvent = (type, summary) => {
        eventSeq++;
        const currentSeq = eventSeq;
        eventChain = eventChain.then(async () => {
          try {
            const res = await call('events', {
              jobId: job.jobId,
              attemptId: job.attemptId,
              seq: currentSeq,
              type,
              summary
            });
            if (!res?.ok) {
              eventErrors.push(`事件 #${currentSeq} (${type}) 提交未被接受: ${res?.reason || '未知原因'}`);
            }
          } catch (err) {
            eventErrors.push(`事件 #${currentSeq} (${type}) 发送网络失败: ${err.message}`);
          }
        });
        return eventChain;
      };

      await enqueueEvent('started', 'Pi worker 已接单，正在初始化 Pi SDK 执行环境...');

      // 5. 实例化并运行 PiRunner
      const modelBridgeUrl = manifest.modelBridgeUrl || (manifest.bridgeUrl + '/v1/bridge/model');
      runner = new PiRunner({
        workspace: manifest.workspace,
        modelBridgeUrl,
        model: manifest.model || 'pi-default',
        token,
        onEvent: async (ev) => {
          await enqueueEvent(ev.type || 'progress', ev.summary || '执行中');
        }
      });

      const taskGoal = job.goal || packet?.job?.goal || '受控执行任务';
      // 发现 4 彻底修复：将完整的 packet 权威上下文传入 runner
      const result = await runner.runTask({
        goal: taskGoal,
        packet,
        timeoutMs: job.lease?.maxRuntimeMs || 180000,
        signal: controller.signal
      });

      // 返修 2 核心保证：等待全部待发送事件排队完成，确保最终 report 晚于所有过程事件
      try {
        await eventChain;
      } catch (err) {
        eventErrors.push('事件队列清空异常: ' + err.message);
      }

      cancelled = Boolean(cancelled || controller.signal.aborted || result.cancelled);

      // 若事件队列有失败项，加入 unknowns 留存审计证据，绝不伪装成功
      const unknowns = Array.isArray(result.unknowns) ? [...result.unknowns] : [];
      if (eventErrors.length > 0) {
        unknowns.push(...eventErrors);
      }

      // 发现 1 彻底修复：严格分流 outcome，只有切实成功且未被取消才 report submitted
      const outcome = cancelled ? 'cancelled' : result.ok ? 'submitted' : 'failed';
      const summary = cancelled
        ? '任务已取消停止'
        : result.ok
        ? result.response
        : result.error || 'Pi 任务执行失败';

      await call('report', {
        jobId: job.jobId,
        attemptId: job.attemptId,
        reportId: 'rep_' + job.attemptId,
        outcome,
        summary,
        artifacts: result.artifacts || [],
        checks: result.checks || [],
        checkpoint: null,
        unknowns
      });

      if (runOnce) break;
    } catch (err) {
      console.error('[PiWorker] 执行轮次异常:', err);
      if (job) {
        try {
          await call('report', {
            jobId: job.jobId,
            attemptId: job.attemptId,
            reportId: 'rep_' + job.attemptId,
            outcome: 'failed',
            summary: `执行发生未捕获异常: ${err.message}`,
            artifacts: [],
            checks: [],
            checkpoint: null,
            unknowns: [err.message]
          });
        } catch {}
      }
      if (runOnce) break;
      await sleep(1500);
    } finally {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
    }
  }
}
