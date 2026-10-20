import path from 'path';
import { ERROR_CODES, BRIDGE_SCHEMA_VERSION } from './types.js';

export class ContextValidator {
  /**
   * Validate ContextPacket and strictly match claim attributes
   * @param {object} packet
   * @param {object} expected
   * @param {string} expected.agentId
   * @param {string} [expected.executorId]
   * @param {object} [expected.job] Claimed job to cross-verify
   * @returns {{ valid: boolean, errors: string[] }}
   */
  static validate(packet, expected = {}) {
    const errors = [];

    if (!packet) {
      return { valid: false, errors: ['ContextPacket is empty or null'] };
    }

    if (packet.schemaVersion !== BRIDGE_SCHEMA_VERSION) {
      errors.push(`schemaVersion mismatch: expected ${BRIDGE_SCHEMA_VERSION}, got ${packet.schemaVersion}`);
    }

    if (!packet.agentId) {
      errors.push('agentId is missing from ContextPacket');
    } else if (expected.agentId && packet.agentId !== expected.agentId) {
      errors.push(`agentId mismatch: expected ${expected.agentId}, got ${packet.agentId}`);
    }

    if (expected.executorId && packet.executorId && packet.executorId !== expected.executorId) {
      errors.push(`executorId mismatch: expected ${expected.executorId}, got ${packet.executorId}`);
    }

    if (!packet.identity) {
      errors.push('identity section missing from ContextPacket');
    } else {
      if (!packet.identity.authorizedPersona) {
        errors.push('identity.authorizedPersona missing');
      }
      if (!packet.identity.authorizedRelationships) {
        errors.push('identity.authorizedRelationships missing');
      }
    }

    if (!packet.job) {
      errors.push('job section missing from ContextPacket');
    } else {
      if (!packet.job.jobId) errors.push('job.jobId missing');
      if (!packet.job.ticketId) errors.push('job.ticketId missing');
      if (!packet.job.workspace) errors.push('job.workspace missing');
      if (!packet.job.goal) errors.push('job.goal missing');

      // Cross-check with claimed job to prevent executing unclaimed context
      if (expected.job) {
        for (const key of ['ticketId', 'taskId']) {
          if (expected.job[key] && packet.job[key] !== expected.job[key]) errors.push(`${key} mismatch between claim and context`);
        }
        if (packet.job.jobId !== expected.job.jobId) {
          errors.push(`jobId mismatch between claim (${expected.job.jobId}) and context (${packet.job.jobId})`);
        }
        if (expected.job.attemptId && packet.job.attemptId !== expected.job.attemptId) {
          errors.push(`attemptId mismatch between claim (${expected.job.attemptId}) and context (${packet.job.attemptId})`);
        }
        if (expected.job.workspace) {
          const normClaimWs = path.normalize(path.resolve(expected.job.workspace));
          const normPacketWs = path.normalize(path.resolve(packet.job.workspace));
          if (normClaimWs !== normPacketWs) {
            errors.push(`workspace mismatch between claim (${normClaimWs}) and context (${normPacketWs})`);
          }
        }
      }
    }

    if (!packet.continuity) {
      errors.push('continuity section missing from ContextPacket');
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  /**
   * Formats ContextPacket into a structured instruction for the Antigravity session.
   * Latest authoritative continuity from packet overrides stale local actions.
   * @param {object} packet
   * @param {object} [existingCheckpoint]
   * @returns {string}
   */
  static buildPrompt(packet, existingCheckpoint = null) {
    const { identity, job, continuity, memory, discussion } = packet;

    const sections = [];

    // 1. Authoritative Identity & Persona Anchor
    sections.push(`=== 【身份与关系锚点】 ===
姓名/显示名：${identity.displayName || '编辑助手（编辑助手）'}
代号：${packet.agentId}
版本：${identity.personaVersion || 'v1'}
人格设定：
${identity.authorizedPersona}

关系锚点：
${typeof identity.authorizedRelationships === 'string' ? identity.authorizedRelationships : JSON.stringify(identity.authorizedRelationships, null, 2)}
`);

    // 2. Current Task & Job Scope
    sections.push(`=== 【当前派工任务】 ===
工单 ID：${job.ticketId}
任务 ID：${job.taskId || 'main'}
Job ID：${job.jobId} (Attempt: ${job.attemptId})
任务目标：
${job.goal}

工作范围与限制：
${job.scope || '仅限在批准工作目录内作业'}

批准工作目录：
${job.workspace}

验收标准：
${job.acceptance || '依工单要求完成交付产物并通过验证'}
`);

    // 3. Continuity & Checkpoint:
    // Packet (authoritative from house) is PRIMARY.
    // Checkpoint completed list is merged to avoid duplicating work,
    // but packet's nextAction & remaining takes precedence over stale checkpoint!
    const effectiveCompleted = Array.from(new Set([
      ...(Array.isArray(existingCheckpoint?.continuity?.completed) ? existingCheckpoint.continuity.completed : []),
      ...(Array.isArray(continuity?.completed) ? continuity.completed : [])
    ]));

    const effectiveRemaining = continuity?.remaining || existingCheckpoint?.continuity?.remaining || [];
    const effectiveNextAction = continuity?.nextAction || existingCheckpoint?.continuity?.nextAction || '按验收标准执行';
    const effectiveBlockers = continuity?.blockers || existingCheckpoint?.continuity?.blockers || '无';
    const otherTasks = continuity?.otherOpenTasks || existingCheckpoint?.continuity?.otherOpenTasks || [];

    sections.push(`=== 【工作连续性与检查点】 ===
当前阶段：${existingCheckpoint?.phase || '执行中'}
已完成工作（避免重复副作用）：
${effectiveCompleted.length > 0 ? effectiveCompleted.map(c => `- ${c}`).join('\n') : '无'}

待办工作：
${Array.isArray(effectiveRemaining) ? effectiveRemaining.map(r => `- ${r}`).join('\n') : (effectiveRemaining || '无')}

阻塞与问题：
${effectiveBlockers}

下一步动作（最新权威）：
${effectiveNextAction}

其他并行/挂起任务（切勿误标完成或重跑）：
${Array.isArray(otherTasks) ? otherTasks.map(t => `- ${typeof t === 'string' ? t : JSON.stringify(t)}`).join('\n') : (otherTasks || '无')}
`);

    // 4. Discussion & Latest Decisions
    if (discussion && (discussion.latestDecisions || discussion.relevantMessages)) {
      sections.push(`=== 【讨论与最新裁决】 ===
最新裁决：${discussion.latestDecisions || '无'}
相关消息要点：${discussion.relevantMessages ? JSON.stringify(discussion.relevantMessages) : '无'}
`);
    }

    // 5. Authorized Memories with Receipts
    if (memory) {
      sections.push(`=== 【授权相关记忆（含来源收据）】 ===
记忆条目：
${Array.isArray(memory.authorizedRelevantItems) ? memory.authorizedRelevantItems.map(m => `- [${m.id || 'mem'}] ${m.summary || m.content || m.title || ''}`).join('\n') : '无'}

来源收据：
${Array.isArray(memory.sourceReceipts) ? memory.sourceReceipts.map(r => `- [${r.id}] ${r.summary || r.scope} (ver: ${r.version || '1'})`).join('\n') : '无'}
`);
    }

    // 6. Execution Instructions tailored to approved capabilities
    const approvedTools = packet.job?.approvedTools || packet.capabilities?.tools || [];
    const hasTerminalApproval = approvedTools.includes('terminal') || approvedTools.includes('command') || packet.job?.allowTerminal === true;
    const hasFileWriteApproval = approvedTools.includes('file_write') || approvedTools.includes('fs');
    const isPureAnalysis = packet.job?.pureAnalysis === true || packet.job?.role === 'analysis';

    const toolInstructions = [];
    if (isPureAnalysis) {
      toolInstructions.push('本轮为纯分析与自查任务，请直接在最终回复中输出完整分析与自查结论，由接线层负责原样落盘并提交，无需调用文件或终端工具。');
    } else {
      if (hasFileWriteApproval) {
        toolInstructions.push('可在批准工作目录下使用受支持的文件操作工具创建或修改目标产物。');
      } else {
        toolInstructions.push('本轮未批准文件写入工具权限，若需写文件请由最终文本回复承载由接线层落盘，或显式报告所需权限。');
      }

      if (hasTerminalApproval) {
        toolInstructions.push('本轮已批准在受限工作空间内执行终端命令。');
      } else {
        toolInstructions.push('当前非交互式运行模式未批准终端执行权限，请勿发起需要交互确认的终端命令（如 bash / powershell 等），避免触发无交互挂起。');
      }
    }

    sections.push(`=== 【执行指令】 ===
请根据以上授权的人格、工单目标与工作目录严格执行。
【操作说明】：
1. ${toolInstructions.join('\n2. ')}
${isPureAnalysis ? '3' : String(toolInstructions.length + 1)}. 产物必须包含工单指定的唯一 canary、任务 ID 与姓名，不复制私人原话。
完成后输出执行结论。
`);

    if (isPureAnalysis) sections.push(`=== 【原样交付格式】 ===\n请在最终回复中写出以下行，再写任务要求的简短结论。内容由你生成，接线层不补写标识。\nCanary: ${job.canary || ''}\nTicket: ${job.ticketId}\nTask: ${job.taskId}\nJob: ${job.jobId}\nAttempt: ${job.attemptId}\n姓名: ${identity.displayName || '编辑助手（编辑助手）'}\n`);

    return sections.join('\n');
  }
}
