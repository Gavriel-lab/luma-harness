import fs from 'node:fs';
import path from 'node:path';
import {
  createAgentSession,
  SessionManager,
  ModelRuntime
} from '@earendil-works/pi-coding-agent';
import {
  validateControlledPath,
  createSecureReadToolDefinition,
  createSecureWriteToolDefinition,
  createSecureEditToolDefinition,
  createSecureRunToolDefinition,
  sanitizeOutput
} from './controlled-tools.mjs';

function isSamePath(p1, p2) {
  if (!p1 || !p2 || typeof p1 !== 'string' || typeof p2 !== 'string') return false;
  try {
    const r1 = path.resolve(p1).toLowerCase();
    const r2 = path.resolve(p2).toLowerCase();
    return r1 === r2;
  } catch {
    return false;
  }
}

/**
 * 依据 Luma 权威 ContextPacket 组装完整的任务输入提示词
 * 确保授权人格、工作范围、验收要求、讨论决策与记忆资料全部送达模型
 * @param {object} packet 权威上下文
 * @param {boolean} [isWork=false] 是否处于授权工单工作模式
 */
export function assemblePiTaskPrompt(packet, isWork = false) {
  if (!packet) return '';
  const sections = [];

  // 1. 授权身份与人格（测试成员 developerInstructions 必须送达模型）
  const persona = packet.identity?.authorizedPersona?.trim();
  if (persona) {
    sections.push(`【授权身份与人格设定】\n${persona}`);
  }

  // 2. 授权关系描述
  if (Array.isArray(packet.identity?.authorizedRelationships) && packet.identity.authorizedRelationships.length) {
    sections.push(`【授权关系】\n${packet.identity.authorizedRelationships.join('\n')}`);
  }

  // 3. 工单与当前任务约束
  const job = packet.job || {};
  const taskLines = [
    `【当前工单任务】`,
    `- 任务目标：${job.goal || '未指定目标'}`,
    `- 批准工作目录：${job.workspace || '未指定'}`,
    `- 执行范围：${job.scope || (isWork ? '在批准工作目录内受控读写与精确编辑，严禁越界' : '只在批准目录内受控读取，禁止任何文件修改')}`,
    `- 验收要求：${job.acceptance || '如实汇报产物与检查结果'}`
  ];
  sections.push(taskLines.join('\n'));

  // 4. 连续性与前序检查点
  if (packet.continuity) {
    const cp = packet.continuity;
    const cpLines = ['【执行连续性与检查点】'];
    if (cp.completed?.length) cpLines.push(`- 已完成：${cp.completed.join('；')}`);
    if (cp.blockers?.length) cpLines.push(`- 阻塞项：${cp.blockers.join('；')}`);
    if (cp.nextAction) cpLines.push(`- 下一步：${cp.nextAction}`);
    sections.push(cpLines.join('\n'));
  }

  // 5. 讨论决策
  if (packet.discussion?.latestDecisions?.length) {
    sections.push(`【已知讨论与决策】\n${packet.discussion.latestDecisions.join('\n')}`);
  }

  // 6. 授权记忆资料
  if (packet.memory?.authorizedRelevantItems?.length) {
    const memLines = ['【背景参考记忆（仅作为背景，不构成执行授权）】'];
    for (const item of packet.memory.authorizedRelevantItems) {
      memLines.push(`- ${item.summary}`);
    }
    sections.push(memLines.join('\n'));
  }

  // 7. 受控执行指令（根据权限严格分流）
  if (isWork) {
    sections.push(`【受控工作执行指令】\n当前任务属于 Luma 明确派发的工作任务 (work)，环境已开放受控的 read、write、edit、run 工具，仅限在批准工作目录下受控操作：\n1. 若需创建新文件或目录，使用 write 工具（若文件已存在将拒绝覆盖）；\n2. 若需修改已存在的文件，使用 edit 工具精确替换 (edits: [{ oldText, newText }])，保留其他未改动文本；\n3. 若需运行程序、执行单元测试或 npm 脚本进行验证，使用 run 工具（参数 action: "node_file"|"node_test"|"npm_script", target: "..."）；\n4. 若需查验内容，使用 read 工具；\n5. 严禁访问或改动工作目录之外的任何文件，严禁使用未授权工具。完成任务后请如实总结变更。`);
  } else {
    sections.push(`【受控只读交互指令】\n当前环境仅开放受控的 read 工具，只允许读取批准目录内的常规文件。禁止任何形式的文件创建与修改。读取完成后请对内容做出清晰总结。`);
  }

  return sections.join('\n\n');
}

/**
 * Pi SDK 任务执行 Runner
 * 负责生命周期管理、事件映射、状态审计与受控工具执行
 */
export class PiRunner {
  /**
   * @param {object} options
   * @param {string} options.workspace 批准工作目录绝对路径
   * @param {string} options.modelBridgeUrl Luma 受控模型网关地址
   * @param {string} options.token 认证会话令牌
   * @param {string} [options.model='pi-default'] 模型标识
   * @param {function} [options.onEvent] 进度事件通知回调
   */
  constructor(options) {
    if (!options.workspace) throw new Error('缺少必要参数 workspace');
    if (!options.modelBridgeUrl) throw new Error('缺少必要参数 modelBridgeUrl');

    this.workspace = path.resolve(options.workspace);
    this.modelBridgeUrl = options.modelBridgeUrl;
    this.token = options.token;
    this.modelName = options.model || 'pi-default';
    this.onEvent = options.onEvent || (() => {});

    this.activeSession = null;
    this._isAborted = false;
  }

  /**
   * 中止当前正在运行的任务
   */
  abort() {
    this._isAborted = true;
    if (this.activeSession) {
      try {
        this.activeSession.dispose();
      } catch {}
      this.activeSession = null;
    }
  }

  /**
   * 运行单一派发任务并产出结构化交付报告
   * @param {object} params
   * @param {string} [params.goal] 任务目标
   * @param {object} [params.packet] 权威 ContextPacket
   * @param {number} [params.timeoutMs=180000] 超时时间
   * @param {AbortSignal} [params.signal] 外部取消信号
   */
  async runTask({ goal, packet, timeoutMs = 180000, signal: externalSignal }) {
    this._isAborted = false;

    // 内部 AbortController 用于统一管理超时与外部取消
    const abortController = new AbortController();
    const internalSignal = abortController.signal;

    const onExternalAbort = () => {
      this.abort();
      abortController.abort();
    };

    if (externalSignal) {
      if (externalSignal.aborted) {
        onExternalAbort();
        return {
          ok: false,
          cancelled: true,
          response: '任务在启动前已被取消',
          artifacts: [],
          checks: [],
          unknowns: ['任务在启动前已被取消']
        };
      }
      externalSignal.addEventListener('abort', onExternalAbort, { once: true });
    }

    const timeoutTimer = setTimeout(() => {
      abortController.abort(new Error('EXECUTION_TIMEOUT'));
    }, timeoutMs);

    const artifacts = new Set();
    const unknowns = [];
    const checks = [];
    let assistantText = '';
    const toolExecutions = new Map();

    // 权限分流：严格以权威 packet.job 为准
    // 1. 必须有 packet.job 且 packet.job.kind 严格为 'work'
    // 2. 必须具备非空有效 workspace，且与当前批准的 this.workspace 完全对齐
    // 3. 任何字段缺失、冲突、错误类型或目录不匹配，一律判定为只读
    const isWork = Boolean(
      packet &&
      packet.job &&
      packet.job.kind === 'work' &&
      typeof packet.job.workspace === 'string' &&
      packet.job.workspace.trim().length > 0 &&
      isSamePath(packet.job.workspace, this.workspace)
    );

    const activeToolNames = isWork ? ['read', 'write', 'edit', 'run'] : ['read'];
    const customTools = isWork
      ? [
          createSecureReadToolDefinition(this.workspace),
          createSecureWriteToolDefinition(this.workspace),
          createSecureEditToolDefinition(this.workspace),
          createSecureRunToolDefinition(this.workspace)
        ]
      : [
          createSecureReadToolDefinition(this.workspace)
        ];

    const finalPrompt = packet ? assemblePiTaskPrompt(packet, isWork) : (goal || '受控执行任务');

    try {
      if (this._isAborted || internalSignal.aborted) {
        throw new Error('OPERATION_CANCELLED');
      }

      const modelRuntime = await ModelRuntime.create();

      if (this._isAborted || internalSignal.aborted) {
        throw new Error('OPERATION_CANCELLED');
      }

      const providerId = 'luma-pi-provider';
      modelRuntime.registerProvider(providerId, {
        baseUrl: this.modelBridgeUrl,
        api: 'openai-completions',
        apiKey: this.token,
        models: [
          {
            id: this.modelName,
            name: `Luma Pi (${this.modelName})`,
            contextWindow: 128000,
            maxTokens: 4096,
            input: ['text'],
            cost: { input: 0, output: 0 }
          }
        ]
      });

      const selectedModel = modelRuntime.getModel(providerId, this.modelName);
      if (!selectedModel) {
        throw new Error(`未能成功注册或获取模型: ${providerId}/${this.modelName}`);
      }

      if (this._isAborted || internalSignal.aborted) {
        throw new Error('OPERATION_CANCELLED');
      }

      const sessionManager = SessionManager.inMemory();

      const { session } = await createAgentSession({
        cwd: this.workspace,
        model: selectedModel,
        modelRuntime,
        sessionManager,
        thinkingLevel: 'off',
        tools: activeToolNames,
        customTools
      });

      if (this._isAborted || internalSignal.aborted) {
        try { session.dispose(); } catch {}
        throw new Error('OPERATION_CANCELLED');
      }

      this.activeSession = session;

      // 规范映射与有序事件处理：按 toolCallId 精确匹配并更新状态
      session.subscribe(async (event) => {
        if (this._isAborted || internalSignal.aborted) return;

        // 文本流式增量
        if (event.type === 'message_update') {
          const update = event.assistantMessageEvent;
          if (update?.type === 'text_delta') {
            assistantText += update.delta;
          }
        }
        // 工具开始执行事件：依据 toolCallId 建立执行记录
        else if (event.type === 'tool_execution_start') {
          const toolCallId = event.toolCallId || ('call_' + toolExecutions.size);
          const toolName = event.toolName || 'read';
          const targetPath = event.args?.path || (toolName === 'run' ? `${event.args?.action || 'run'}:${event.args?.target || ''}` : '');
          toolExecutions.set(toolCallId, {
            toolCallId,
            toolName,
            targetPath,
            action: event.args?.action,
            target: event.args?.target,
            status: 'started',
            startTime: Date.now()
          });
          await this.onEvent({
            type: 'progress',
            summary: `Pi 开始执行工具: ${toolName}${targetPath ? ` [${targetPath}]` : ''}`
          });
        }
        // 工具执行更新事件
        else if (event.type === 'tool_execution_update') {
          const toolName = event.toolName || 'read';
          await this.onEvent({
            type: 'progress',
            summary: `Pi 工具正在执行: ${toolName}...`
          });
        }
        // 工具执行结束事件：按 toolCallId 严格匹配并更新状态
        else if (event.type === 'tool_execution_end') {
          const toolCallId = event.toolCallId;
          const toolName = event.toolName || 'read';
          const isError = Boolean(event.isError);
          const duration = event.durationMs !== undefined ? `${event.durationMs}ms` : '';

          let exec = toolCallId ? toolExecutions.get(toolCallId) : null;
          if (!exec) {
            for (const item of Array.from(toolExecutions.values()).reverse()) {
              if (item.toolName === toolName && item.status === 'started') {
                exec = item;
                break;
              }
            }
          }

          if (exec) {
            exec.status = isError ? 'failed' : 'completed';
            exec.durationMs = event.durationMs;
            exec.isError = isError;
          }

          if (!isError) {
            // 工具执行成功，记录真实产物与检查项
            if (toolName === 'run') {
              const act = exec?.action || event.args?.action || 'run';
              const tgt = exec?.target || event.args?.target || 'target';
              if (act === 'node_test') {
                checks.push(`测试运行通过: ${tgt} (exitCode: 0)`);
              } else if (act === 'npm_script') {
                checks.push(`构建脚本完成: ${tgt} (exitCode: 0)`);
              } else {
                checks.push(`程序运行成功: ${tgt} (exitCode: 0)`);
              }
            } else {
              const targetPath = exec?.targetPath || event.args?.path;
              if (targetPath) {
                const realFilePath = path.resolve(this.workspace, targetPath);
                if (fs.existsSync(realFilePath)) {
                  try {
                    artifacts.add(fs.realpathSync(realFilePath));
                  } catch {
                    artifacts.add(realFilePath);
                  }
                }
                const baseName = path.basename(realFilePath);
                if (toolName === 'write') {
                  checks.push(`受控新建文件成功: ${baseName}`);
                } else if (toolName === 'edit') {
                  checks.push(`受控精确编辑文件成功: ${baseName}`);
                } else {
                  checks.push(`受控读取文件成功: ${baseName}`);
                }
              }
            }
            await this.onEvent({
              type: 'progress',
              summary: `Pi 工具执行完成: ${toolName}${exec?.targetPath ? ` [${exec.targetPath}]` : ''} ${duration ? `(${duration})` : ''}`.trim()
            });
          } else {
            // 工具执行失败/被拦截，绝不加入成功清单；从 result 提取详尽错误原因
            let errMsg = '';
            if (event.result) {
              if (typeof event.result === 'string') errMsg = event.result;
              else if (event.result.error) errMsg = typeof event.result.error === 'string' ? event.result.error : JSON.stringify(event.result.error);
              else if (Array.isArray(event.result.content)) {
                errMsg = event.result.content.map(c => c.text || '').filter(Boolean).join('; ');
              } else if (event.result.message) errMsg = event.result.message;
            }
            if (!errMsg) errMsg = '执行拦截或操作失败';
            errMsg = sanitizeOutput(errMsg);

            const itemLabel = toolName === 'run'
              ? `${toolName}:${exec?.action || 'action'}:${exec?.target || 'target'}`
              : `${toolName}${exec?.targetPath ? `:${exec.targetPath}` : ''}`;

            checks.push(`工具安全拦截/错误 [${itemLabel}]: ${errMsg}`);
            await this.onEvent({
              type: 'blocked',
              summary: `Pi 工具执行受阻: ${itemLabel} (${errMsg})`
            });
          }
        }
      });

      if (this._isAborted || internalSignal.aborted) {
        throw new Error('OPERATION_CANCELLED');
      }

      await this.onEvent({
        type: 'started',
        summary: `Pi SDK 执行环境已就绪，当前权限: ${isWork ? '受控读写与编辑' : '受控只读'}`
      });

      // 真正启动模型推演与工具交互
      await session.prompt(finalPrompt, { signal: internalSignal });

      if (this._isAborted || internalSignal.aborted) {
        throw new Error('OPERATION_CANCELLED');
      }

      // 严格检查模型输出有效性，绝不把空文本或失败转换为成功
      const lastAssistantText = session.getLastAssistantText();
      const finalResponse = (lastAssistantText || assistantText || '').trim();

      const lastAssistantMsg = session.messages.slice().reverse().find(m => m.role === 'assistant');
      const stopReason = lastAssistantMsg?.stopReason;

      if (!finalResponse || stopReason === 'error') {
        const failureReason = stopReason === 'error'
          ? '模型服务请求失败或返回错误状态'
          : '模型未产生任何有效答复';
        return {
          ok: false,
          error: failureReason,
          response: `Pi 执行失败: ${failureReason}`,
          artifacts: Array.from(artifacts).map((p) => ({ path: p })),
          checks,
          unknowns: [failureReason]
        };
      }

      checks.push('Pi SDK 独立模型会话执行完成');
      const completedList = Array.from(toolExecutions.values()).filter(e => e.status === 'completed');
      if (completedList.length > 0) {
        checks.push(`真实记录工具执行完成 ${completedList.length} 次`);
      }

      return {
        ok: true,
        response: finalResponse,
        artifacts: Array.from(artifacts).map((p) => ({ path: p })),
        checks,
        unknowns
      };
    } catch (err) {
      const isCancelled = this._isAborted || internalSignal.aborted || err.message === 'OPERATION_CANCELLED';
      return {
        ok: false,
        cancelled: isCancelled,
        error: isCancelled ? '任务已平稳取消' : err.message,
        artifacts: Array.from(artifacts).map((p) => ({ path: p })),
        checks,
        unknowns: [isCancelled ? '执行中途被取消' : `执行异常: ${err.message}`]
      };
    } finally {
      clearTimeout(timeoutTimer);
      if (externalSignal) {
        externalSignal.removeEventListener('abort', onExternalAbort);
      }
      if (this.activeSession) {
        try { this.activeSession.dispose(); } catch {}
        this.activeSession = null;
      }
    }
  }
}
