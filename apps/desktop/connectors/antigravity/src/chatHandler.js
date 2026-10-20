import { ContextValidator } from './contextValidator.js';
import { AntigravityRunner } from './antigravityRunner.js';
import { EXECUTION_MODES, ERROR_CODES } from './types.js';

export class ChatHandler {
  /**
   * @param {object} options
   * @param {AntigravityRunner} options.runner
   * @param {string} [options.agentId]
   * @param {string} [options.executorId]
   */
  constructor(options = {}) {
    this.runner = options.runner || new AntigravityRunner();
    this.agentId = options.agentId || 'agent_editor';
    this.executorId = options.executorId || 'antigravity-adapter';
    // Map bindingKey -> { cliSessionId, homeId, executorId, contextVersion }
    this.sessionMap = new Map();
    // In-flight request cancellation controllers
    this.activeRequests = new Map();
  }

  _makeBindingKey(homeId, executorId, conversationId) {
    return `${homeId || 'default'}::${executorId || 'default'}::${conversationId}`;
  }

  /**
   * Cancel an in-flight chat request by requestId
   * @param {string} requestId
   */
  cancelTurn(requestId) {
    const controller = this.activeRequests.get(requestId);
    if (controller) {
      controller.abort();
      this.activeRequests.delete(requestId);
      return true;
    }
    return false;
  }

  /**
   * Execute one chat turn for Xiaowu conversation dispatch
   * @param {object} params
   * @param {string} params.requestId
   * @param {string} params.homeId
   * @param {string} params.agentId
   * @param {string} params.executorId
   * @param {string} params.conversationId
   * @param {number} [params.contextVersion]
   * @param {object} params.authorizedContext Context packet containing identity, persona, memories, continuity
   * @param {string} params.input Current user input text
   * @param {string} [params.mode] 'chat' or 'work' (defaults to 'chat')
   * @param {string} [params.workspaceDir] Directory if needed
   * @param {string} [params.model] Explicit model to use
   * @param {function} [params.onProgress] Callback for streaming progress
   * @returns {Promise<{ ok: boolean, requestId: string, response: string, conversationId: string, usage?: object, error?: string }>}
   */
  async executeChatTurn(params) {
    const {
      requestId,
      homeId,
      agentId,
      executorId,
      conversationId,
      contextVersion = 1,
      authorizedContext,
      input,
      attachments,
      mode = EXECUTION_MODES.CHAT,
      workspaceDir = process.cwd(),
      model,
      onProgress,
    } = params;

    // 1. Identity & Binding validation
    if (!requestId) {
      throw { ok: false, code: ERROR_CODES.UNKNOWN, message: 'requestId is required' };
    }
    if (this.activeRequests.has(requestId)) {
      throw { ok: false, code: ERROR_CODES.FORBIDDEN, message: `Duplicate in-flight requestId: ${requestId}` };
    }
    if (agentId !== this.agentId) {
      throw {
        ok: false,
        code: ERROR_CODES.FORBIDDEN,
        message: `AgentId mismatch: expected ${this.agentId}, got ${agentId}`,
      };
    }
    if (!authorizedContext || !authorizedContext.identity || !authorizedContext.identity.authorizedPersona) {
      throw {
        ok: false,
        code: ERROR_CODES.CONTEXT_STALE,
        message: 'Missing authorized identity and persona in context',
      };
    }

    const isChat = mode === EXECUTION_MODES.CHAT;

    // 2. Strict Session mapping check across homeId / executorId / contextVersion
    const bindingKey = this._makeBindingKey(homeId, executorId, conversationId);
    let sessionRecord = this.sessionMap.get(bindingKey);
    let cliSessionId = null;

    if (sessionRecord) {
      // Invalidate if contextVersion is not compatible
      if (sessionRecord.contextVersion !== contextVersion) {
        sessionRecord = null; // Stale context, rebuild clean session
      } else {
        cliSessionId = sessionRecord.cliSessionId;
      }
    }

    // 3. Construct prompt retaining identity, relationships, memory receipts, and CONTINUITY (current work & open tasks)
    const { identity, memory, continuity } = authorizedContext;
    const promptSections = [
      `=== 【编辑助手（编辑助手）身份与关系锚点】 ===
代号：${agentId}
姓名：${identity.displayName || '编辑助手'}
设定：${identity.authorizedPersona}
关系：${typeof identity.authorizedRelationships === 'string' ? identity.authorizedRelationships : JSON.stringify(identity.authorizedRelationships)}
`,
    ];

    // Continuity in chat: retain current work & other open tasks so Worker doesn't forget ongoing work
    if (continuity) {
      const completedStr = Array.isArray(continuity.completed) && continuity.completed.length > 0
        ? continuity.completed.join('; ')
        : (typeof continuity.completed === 'string' && continuity.completed ? continuity.completed : '无');
      const remainingStr = Array.isArray(continuity.remaining) && continuity.remaining.length > 0
        ? continuity.remaining.join('; ')
        : (typeof continuity.remaining === 'string' && continuity.remaining ? continuity.remaining : '无');
      const blockersStr = Array.isArray(continuity.blockers) && continuity.blockers.length > 0
        ? continuity.blockers.join('; ')
        : (continuity.blockers || '无');

      promptSections.push(`=== 【当前工作检查点与挂起任务】 ===
已完成事项：${completedStr}
剩余事项：${remainingStr}
阻塞原因：${blockersStr}
当前动作：${continuity.nextAction || '无'}
其他并行/挂起任务：${Array.isArray(continuity.otherOpenTasks) ? continuity.otherOpenTasks.join('; ') : (continuity.otherOpenTasks || '无')}
`);
    }

    if (memory) {
      if (Array.isArray(memory.authorizedRelevantItems) && memory.authorizedRelevantItems.length > 0) {
        promptSections.push(`=== 【授权相关记忆】 ===
${memory.authorizedRelevantItems.map(m => `- ${m.summary || m.content || m.title || ''}`).join('\n')}
`);
      }
      if (Array.isArray(memory.sourceReceipts) && memory.sourceReceipts.length > 0) {
        promptSections.push(`=== 【记忆来源收据】 ===
${memory.sourceReceipts.map(r => `- [${r.id}] ${r.summary || r.title || r.scope || ''}`).join('\n')}
`);
      }
    }

    const hasAttachments = Array.isArray(attachments) && attachments.length > 0;
    if (hasAttachments) {
      const attLines = attachments.map(a => `[已授权本轮照片附件：${a.relativePath}]`).join('\n');
      promptSections.push(`=== 【已授权照片附件】 ===
${attLines}
你已获得授权使用 view_file 查看上述照片附件（除 view_file 查看已授权附件外，严禁调用任何其他工具修改文件或执行命令）。请在查看后直接自然口语化回复使用者。
`);
    }

    promptSections.push(`=== 【模式：${isChat ? '普通聊天（请自然口语化回复，' + (hasAttachments ? '除使用 view_file 查看已授权附件外，严禁调用系统工具修改文件或执行命令' : '严禁调用系统工具修改文件或执行命令') + '）' : '工作桌任务执行'}】 ===
=== 【客厅联动暗号】 ===
- 使用者明确让你去修/去做某件事时，回复末尾单独一行写 [[去客厅:一句话说要做什么]]，小屋会替你在客厅@协调者开单；不是她明确要求时不要写。
- 使用者明确让你去群里说/问时，回复末尾单独一行写 [[客厅传话:要说的话]]，原样以你的身份发到客厅，不建工单；不是她明确要求时不要写。

输入信息：
${input}
`);

    const fullPrompt = promptSections.join('\n');

    // Register active request
    const abortController = new AbortController();
    this.activeRequests.set(requestId, abortController);

    if (onProgress) {
      onProgress({ type: 'started', requestId, conversationId });
    }

    try {
      const runnerRes = await this.runner.runTurn({
        prompt: fullPrompt,
        workspaceDir,
        conversationId: cliSessionId,
        model,
        timeoutMs: 120000, // Chat turns default to 2 minutes
        skipPermissions: false,
        disableSlashCommands: true,
        signal: abortController.signal, // Pass AbortSignal to runner!
      });

      // Handle cancellation race
      if (runnerRes.cancelled || abortController.signal.aborted) {
        const cancelReason = runnerRes.cancelReason || 'client_cancelled';
        return {
          ok: false,
          cancelled: true,
          cancelReason,
          requestId,
          conversationId,
          error: cancelReason === 'timeout'
            ? 'Chat execution timed out'
            : `Execution cancelled by ${cancelReason}`,
          response: null,
        };
      }

      if (!runnerRes.ok) {
        return {
          ok: false,
          requestId,
          conversationId,
          error: runnerRes.error || 'Runner execution failed',
          response: null,
        };
      }

      // Record CLI session ID for this conversation binding
      if (runnerRes.conversationId) {
        this.sessionMap.set(bindingKey, {
          cliSessionId: runnerRes.conversationId,
          homeId,
          executorId,
          contextVersion,
        });
      }

      if (onProgress) {
        onProgress({ type: 'completed', requestId, conversationId, response: runnerRes.response });
      }

      return {
        ok: true,
        requestId,
        conversationId,
        cliSessionId: runnerRes.conversationId,
        response: runnerRes.response,
        usage: runnerRes.usage,
      };
    } finally {
      this.activeRequests.delete(requestId);
    }
  }
}
