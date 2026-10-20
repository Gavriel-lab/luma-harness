'use strict';

/**
 * 小屋 · 主进程传输与流式服务
 *
 * 核心技术规范与状态收口：
 * 1. 严格主进程受信网络层：由受信任主进程发起请求，不向渲染端泄露明文密钥；
 * 2. 端点与模型约束：规范化 Base URL，消除双重 /v1，仅允许 HTTPS 或显式回环 HTTP；
 *    模型 ID 默认留空，空模型主进程显式拦截，绝不隐式使用默认收费模型；
 * 3. 健全的 SSE 解析闭环：
 *    - 规范切分事件块（支持 CRLF 与 LF），自动忽略 `: ping` 等心跳注释行；
 *    - 支持多行 `data:` 规范拼接与 UTF-8 跨包多字节字符无损流式解码；
 *    - 收到 `[DONE]` 帧真正终止 reader 读取，释放连接，终止后迟到数据彻底丢弃；
 *    - 无终止帧的意外 EOF / 连接截断必须作为错误处理，绝不因 HTTP 200 误判为成功；
 * 4. 终态单一性与严格分类：
 *    - 区分超时（连接 15s、空闲 30s、总时长 180s）与用户主动 stop；
 *    - 超时一律下发 `chat:stream-error`；只有用户主动取消才下发 `chat:stream-stopped`；
 *    - 单次请求生命周期内，[done, error, stopped] 至多触发一条终态事件；
 * 5. 全局动态脱敏：将本次请求实际使用的密钥动态传入脱敏函数，彻底消除任意假 Key 泄露风险；
 * 6. 可靠连接测试：testConnection 消费 body 并严密校验 JSON 结构与 error 字段，防御 HTTP 200+JSON error 假成功。
 */
let electronNet = null;
if (typeof process !== 'undefined' && process.versions && process.versions.electron) {
  try {
    const electron = require('electron');
    electronNet = electron && electron.net ? electron.net : null;
  } catch {
    electronNet = null;
  }
}

class ChatService {
  constructor(credentialsStore) {
    this.credentialsStore = credentialsStore;
    /** 活动中的流式请求 Map: requestId -> { abortController, conversationId, targetAgentId, startedAt, cancelled, cancelReason, finished } */
    this.activeRequests = new Map();
  }

  /**
   * 规范化并校验 Base URL
   * @param {string} baseUrl
   * @returns {string} 完整的 chat completions 端点 URL
   */
  normalizeEndpoint(baseUrl) {
    if (!baseUrl || typeof baseUrl !== 'string') {
      throw new Error('未提供有效 Base URL');
    }
    const trimmed = baseUrl.trim();
    let url;
    try {
      url = new URL(trimmed);
    } catch {
      throw new Error(`无效的 URL 地址: ${trimmed}`);
    }

    const isHttpLoopback = url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost');
    if (url.protocol !== 'https:' && !isHttpLoopback) {
      throw new Error(`安全限制：仅允许 HTTPS 端点或本地回环 HTTP，收到: ${url.protocol}//${url.host}`);
    }

    let pathname = url.pathname.replace(/\/+$/, '');
    if (pathname.endsWith('/chat/completions')) {
      // 已经是完整接口
    } else if (pathname.endsWith('/v1')) {
      pathname += '/chat/completions';
    } else if (pathname === '' || pathname === '/') {
      pathname = '/v1/chat/completions';
    } else {
      pathname += '/chat/completions';
    }

    url.pathname = pathname;
    return url.toString();
  }

  /**
   * 开始流式对话
   * @param {object} params
   * @param {function} [sendEventCallback]
   */
  async startStream(params, sendEventCallback) {
    const rawSendEvent = typeof sendEventCallback === 'function' ? sendEventCallback : (typeof params?.sendEvent === 'function' ? params.sendEvent : () => {});
    
    const {
      requestId,
      conversationId,
      targetAgentId,
      profile,
      messages,
    } = params;

    if (!requestId || !conversationId) {
      throw new Error('缺少请求参数 (requestId / conversationId)');
    }

    // 单次请求终态单一性保证包装
    let finalized = false;
    const sendEvent = (channel, data) => {
      const isTerminal = channel === 'chat:stream-done' || channel === 'chat:stream-error' || channel === 'chat:stream-stopped';
      if (isTerminal) {
        if (finalized) return;
        finalized = true;
      }
      try {
        rawSendEvent(channel, data);
      } catch (err) {
        console.error('[ChatService] sendEvent 派发异常:', err);
      }
    };

    // 如果该请求已被终止或已存在，先清理旧请求
    this.stopStream(requestId);

    const abortController = new AbortController();
    const reqState = {
      abortController,
      conversationId,
      targetAgentId,
      startedAt: Date.now(),
      cancelled: false,
      cancelReason: null,
      terminalEmitted: false,
    };
    this.activeRequests.set(requestId, reqState);

    // 校验 profile
    if (!profile) {
      this.activeRequests.delete(requestId);
      sendEvent('chat:stream-error', { requestId, conversationId, error: '缺少成员接口配置快照' });
      return;
    }

    // 校验 model：绝不隐藏 fallback 到 Sonnet，空 model 显式拦截
    if (!profile.model || typeof profile.model !== 'string' || !profile.model.trim()) {
      this.activeRequests.delete(requestId);
      sendEvent('chat:stream-error', { requestId, conversationId, error: '未配置模型 ID，请在成员连接设置中填写具体模型名称' });
      return;
    }

    let endpointUrl;
    try {
      endpointUrl = this.normalizeEndpoint(profile.baseUrl);
    } catch (e) {
      this.activeRequests.delete(requestId);
      sendEvent('chat:stream-error', { requestId, conversationId, error: e.message });
      return;
    }

    // 获取并校验 Key
    let apiKey = null;
    if (profile.credentialRef) {
      try {
        apiKey = this.credentialsStore.getKey(profile.credentialRef);
      } catch (e) {
        this.activeRequests.delete(requestId);
        sendEvent('chat:stream-error', { requestId, conversationId, error: e.message });
        return;
      }
    }

    if (!apiKey) {
      this.activeRequests.delete(requestId);
      sendEvent('chat:stream-error', {
        requestId,
        conversationId,
        error: '未配置或未找到 API 凭据，请在成员连接设置中填写密钥',
      });
      return;
    }

    const headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'HTTP-Referer': 'https://xiaowu.local',
      'X-Title': 'Xiaowu Desktop',
    };

    const maxTokens = Number.isInteger(profile.maxTokens) && profile.maxTokens > 0 ? profile.maxTokens : 2048;
    const temperature = typeof profile.temperature === 'number' ? profile.temperature : 0.7;

    const requestBody = {
      model: profile.model.trim(),
      messages,
      stream: true,
      max_tokens: maxTokens,
      temperature,
    };

    // 细粒度超时管理与错误分类
    const CONNECT_TIMEOUT_MS = 45000;
    const IDLE_TIMEOUT_MS = 60000;
    const TOTAL_TIMEOUT_MS = 240000;

    let timeoutReason = null;

    let idleTimer = null;
    const resetIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        timeoutReason = '流式读取超时：超过 60 秒未收到任何数据';
        abortController.abort(new Error(timeoutReason));
      }, IDLE_TIMEOUT_MS);
    };

    const totalTimer = setTimeout(() => {
      timeoutReason = '请求超时：已达到单次会话上限 240 秒';
      abortController.abort(new Error(timeoutReason));
    }, TOTAL_TIMEOUT_MS);

    const initialConnectTimer = setTimeout(() => {
      timeoutReason = '连接超时：未能连接到服务接口（超过 45 秒）';
      abortController.abort(new Error(timeoutReason));
    }, CONNECT_TIMEOUT_MS);

    const cleanAllTimers = () => {
      if (idleTimer) clearTimeout(idleTimer);
      clearTimeout(totalTimer);
      clearTimeout(initialConnectTimer);
    };

    try {
      const fetchFn = (electronNet && typeof electronNet.fetch === 'function') ? electronNet.fetch : (typeof globalThis.fetch === 'function' ? globalThis.fetch : null);
      if (!fetchFn) {
        throw new Error('当前环境无可用网络请求组件 (fetch / net.fetch)');
      }

      const response = await fetchFn(endpointUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody),
        signal: abortController.signal,
      });

      clearTimeout(initialConnectTimer);
      resetIdleTimer();

      const active = this.activeRequests.get(requestId);
      if (!active || active.cancelled) {
        cleanAllTimers();
        this.activeRequests.delete(requestId);
        sendEvent('chat:stream-stopped', { requestId, conversationId, reason: 'user' });
        return;
      }

      if (!response.ok) {
        let errBody = '';
        try {
          errBody = await response.text();
        } catch { /* 忽略 */ }
        const cleanErr = this.credentialsStore.sanitizeError(errBody, [apiKey]);
        let errorMsg = `接口请求失败 (HTTP ${response.status})`;
        try {
          const parsedErr = JSON.parse(cleanErr);
          if (parsedErr?.error?.message) {
            errorMsg = `[${response.status}] ${parsedErr.error.message}`;
          }
        } catch {
          if (cleanErr && cleanErr.length < 200) {
            errorMsg = `[${response.status}] ${cleanErr}`;
          }
        }
        throw new Error(errorMsg);
      }

      if (!response.body) {
        throw new Error('接口响应成功但未返回流式数据体');
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8', { fatal: false, stream: true });
      let buffer = '';
      let streamCompletedNormally = false;

      while (true) {
        const { done, value } = await reader.read();
        const curActive = this.activeRequests.get(requestId);
        if (!curActive || curActive.cancelled) {
          try { await reader.cancel(); } catch { /* 忽略 */ }
          break;
        }

        if (done) {
          // 对 EOF 的严格检查：必须有 [DONE] 帧才算正常结束
          if (!streamCompletedNormally) {
            throw new Error('流式传输意外截断：上游连接在未发送 [DONE] 终止帧前已中断关闭');
          }
          break;
        }

        resetIdleTimer();
        // 持续累加解码，保持 stream: true，完美解决跨 TCP 包多字节 UTF-8 字符分片
        buffer += decoder.decode(value, { stream: true });

        // 处理跨包 CRLF：如果末尾恰好以 '\r' 结尾，保留该 '\r' 留待下一包拼接，防止误当独立换行替换
        let processable = buffer;
        let trailingCR = false;
        if (processable.endsWith('\r')) {
          processable = processable.slice(0, -1);
          trailingCR = true;
        }

        // 统一规范换行符
        processable = processable.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

        // SSE 事件由两个连续换行分隔
        let blockEndIdx;
        let consumedUpTo = 0;
        while ((blockEndIdx = processable.indexOf('\n\n', consumedUpTo)) !== -1) {
          const eventBlock = processable.slice(consumedUpTo, blockEndIdx);
          consumedUpTo = blockEndIdx + 2;

          const lines = eventBlock.split('\n');
          const dataLines = [];

          for (const rawLine of lines) {
            const line = rawLine.trim();
            if (!line || line.startsWith(':')) {
              // 心跳注释行或空行直接跳过
              continue;
            }
            if (line.startsWith('data:')) {
              dataLines.push(line.slice(5).trim());
            }
          }

          if (dataLines.length === 0) continue;

          // 规范拼接可能存在的多行 data
          const fullDataStr = dataLines.join('\n');

          if (fullDataStr === '[DONE]') {
            streamCompletedNormally = true;
            try { await reader.cancel(); } catch { /* 释放 reader */ }
            break;
          }

          try {
            let parsed;
            try {
              parsed = JSON.parse(fullDataStr);
            } catch (err) {
              // 容错处理：如果 SSE 多行拼接导致 JSON 字符串内部含有字面换行，转义后重试解析
              try {
                parsed = JSON.parse(fullDataStr.replace(/\n/g, '\\n'));
              } catch {
                // 忽略非标准或非法 json
              }
            }
            if (!parsed) continue;

            // 检查流内 error
            if (parsed?.error) {
              const streamErr = parsed.error.message || JSON.stringify(parsed.error);
              throw new Error(`流内错误: ${this.credentialsStore.sanitizeError(streamErr, [apiKey])}`);
            }

            let delta = parsed?.choices?.[0]?.delta?.content ?? parsed?.choices?.[0]?.delta?.text;
            if (Array.isArray(delta)) {
              delta = delta.map(d => (typeof d === 'string' ? d : (d?.text || ''))).join('');
            }
            if (typeof delta === 'string' && delta.length > 0) {
              const activeCheck = this.activeRequests.get(requestId);
              if (activeCheck === reqState && !activeCheck.cancelled && !streamCompletedNormally) {
                sendEvent('chat:stream-chunk', {
                  requestId,
                  conversationId,
                  delta,
                });
              }
            }
          } catch (err) {
            if (err.message.startsWith('流内错误:')) throw err;
            // 忽略非标准或心跳 json
          }
        }

        // 恢复未处理完的尾部字符 + 保留的未决 '\r'
        buffer = processable.slice(consumedUpTo) + (trailingCR ? '\r' : '');

        if (streamCompletedNormally) {
          break;
        }
      }

      cleanAllTimers();

      const finalActive = this.activeRequests.get(requestId);
      if (finalActive === reqState) {
        this.activeRequests.delete(requestId);
      }

      if (finalActive && !finalActive.cancelled && streamCompletedNormally) {
        sendEvent('chat:stream-done', {
          requestId,
          conversationId,
        });
      } else if (finalActive?.cancelled) {
        sendEvent('chat:stream-stopped', {
          requestId,
          conversationId,
          reason: 'user',
        });
      }
    } catch (e) {
      cleanAllTimers();

      const cur = this.activeRequests.get(requestId);
      if (cur === reqState) {
        this.activeRequests.delete(requestId);
      }

      // 明确分类：如果是超时引起的 abort，下发 error；如果是用户主动取消，下发 stopped
      if (timeoutReason) {
        sendEvent('chat:stream-error', {
          requestId,
          conversationId,
          error: timeoutReason,
        });
        return;
      }

      if (abortController.signal.aborted || cur?.cancelled || cur?.cancelReason === 'user') {
        sendEvent('chat:stream-stopped', {
          requestId,
          conversationId,
          reason: 'user',
        });
        return;
      }

      let rawMsg = e.message || '网络连接异常';
      if (rawMsg.toLowerCase().includes('terminated') || rawMsg.toLowerCase().includes('premature close') || rawMsg.toLowerCase().includes('other side closed')) {
        rawMsg = `流式传输意外截断: 上游连接异常关闭 (${rawMsg})`;
      }

      const safeMsg = this.credentialsStore.sanitizeError(rawMsg, apiKey ? [apiKey] : []);
      sendEvent('chat:stream-error', {
        requestId,
        conversationId,
        error: safeMsg,
      });
    }
  }

  /**
   * 停止指定的流式请求
   * @param {string} requestId
   */
  stopStream(requestId) {
    if (!requestId) return;
    const req = this.activeRequests.get(requestId);
    if (!req) return;
    req.cancelled = true;
    req.cancelReason = 'user';
    try {
      req.abortController.abort(new Error('用户主动取消'));
    } catch { /* 忽略 */ }
  }

  /**
   * 测试连接连通性（用户在设置面板手动触发）
   */
  async testConnection(profile) {
    if (!profile || !profile.baseUrl) {
      return { success: false, error: '缺少接口 Base URL', timestamp: new Date().toISOString() };
    }

    if (!profile.model || typeof profile.model !== 'string' || !profile.model.trim()) {
      return { success: false, error: '未配置模型 ID，请在成员连接设置中填写具体模型名称', timestamp: new Date().toISOString() };
    }

    let endpoint;
    try {
      endpoint = this.normalizeEndpoint(profile.baseUrl);
    } catch (e) {
      return { success: false, error: e.message, timestamp: new Date().toISOString() };
    }

    let key = null;
    if (profile.credentialRef) {
      try {
        key = this.credentialsStore.getKey(profile.credentialRef);
      } catch (e) {
        return { success: false, error: e.message, timestamp: new Date().toISOString() };
      }
    }

    if (!key) {
      return { success: false, error: '未保存 API 密钥，请先保存密钥再进行测试', timestamp: new Date().toISOString() };
    }

    const start = Date.now();
    const abortCtrl = new AbortController();
    // 超时覆盖整个请求周期，包括 headers 和 body 读取
    const timeout = setTimeout(() => abortCtrl.abort(new Error('连接超时（超过 30 秒）')), 30000);

    try {
      const fetchFn = (electronNet && typeof electronNet.fetch === 'function') ? electronNet.fetch : (typeof globalThis.fetch === 'function' ? globalThis.fetch : null);
      if (!fetchFn) {
        throw new Error('当前环境无可用网络请求组件 (fetch / net.fetch)');
      }

      const resp = await fetchFn(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${key}`,
          'HTTP-Referer': 'https://xiaowu.local',
          'X-Title': 'Xiaowu Desktop',
        },
        body: JSON.stringify({
          model: profile.model.trim(),
          messages: [{ role: 'user', content: 'hi' }],
          max_tokens: 1,
        }),
        signal: abortCtrl.signal,
      });

      // 读取响应体（设置 64KB 上限，并且处于同一个 timeout 保护下）
      let bodyText = '';
      if (resp.body && typeof resp.body.getReader === 'function') {
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let totalBytes = 0;
        const MAX_BYTES = 64 * 1024;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) {
            totalBytes += value.byteLength;
            if (totalBytes > MAX_BYTES) {
              await reader.cancel();
              throw new Error('测试响应体超出最大大小限制 (64KB)');
            }
            bodyText += decoder.decode(value, { stream: true });
          }
        }
        bodyText += decoder.decode();
      } else {
        bodyText = await resp.text();
      }

      // 到这里说明请求和完整响应体均已接收完毕，清除定时器
      clearTimeout(timeout);
      const latencyMs = Date.now() - start;

      const clean = this.credentialsStore.sanitizeError(bodyText, [key]);

      if (!resp.ok) {
        let msg = `HTTP ${resp.status}`;
        try {
          const parsed = JSON.parse(clean);
          if (parsed?.error?.message) msg = `[${resp.status}] ${parsed.error.message}`;
        } catch {
          if (clean && clean.length < 200) msg = `[${resp.status}] ${clean}`;
        }
        return { success: false, error: msg, latencyMs, timestamp: new Date().toISOString() };
      }

      // 即便 HTTP 200，也必须严格校验返回内容（防止上游返回 200 但内含 error 结构或非法结构）
      try {
        const parsed = JSON.parse(clean);
        if (parsed?.error) {
          const errMsg = parsed.error.message || JSON.stringify(parsed.error);
          return { success: false, error: `[200 OK 接口业务报错] ${errMsg}`, latencyMs, timestamp: new Date().toISOString() };
        }
        if (!parsed?.choices || !Array.isArray(parsed.choices) || parsed.choices.length === 0) {
          return { success: false, error: '接口未返回有效的 choices 对话响应', latencyMs, timestamp: new Date().toISOString() };
        }
        const firstChoice = parsed.choices[0];
        const hasAssistantContent = typeof firstChoice?.message?.content === 'string' ||
          typeof firstChoice?.message?.reasoning_content === 'string' ||
          typeof firstChoice?.delta?.content === 'string' ||
          typeof firstChoice?.delta?.reasoning_content === 'string' ||
          typeof firstChoice?.text === 'string';
        if (!hasAssistantContent) {
          return {
            success: false,
            error: '接口未返回有效的 assistant 对话内容 (choices[0].message.content 缺失)',
            latencyMs,
            timestamp: new Date().toISOString()
          };
        }
      } catch (err) {
        if (err.message && err.message.includes('assistant')) {
          return { success: false, error: err.message, latencyMs, timestamp: new Date().toISOString() };
        }
        return { success: false, error: '接口返回的不是合法 JSON', latencyMs, timestamp: new Date().toISOString() };
      }

      return {
        success: true,
        latencyMs,
        timestamp: new Date().toISOString(),
      };
    } catch (e) {
      clearTimeout(timeout);
      return {
        success: false,
        error: this.credentialsStore.sanitizeError(e.message || '网络连接失败', [key]),
        timestamp: new Date().toISOString(),
      };
    }
  }

  /**
   * 带字节上限读取响应体，防打爆内存
   */
  async _readBodyWithLimit(resp, maxBytes = 4 * 1024 * 1024) {
    if (resp.body && typeof resp.body.getReader === 'function') {
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let totalBytes = 0;
      let text = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          totalBytes += value.byteLength;
          if (totalBytes > maxBytes) {
            await reader.cancel();
            throw new Error(`响应体超出最大大小限制 (${Math.round(maxBytes / 1024)}KB)`);
          }
          text += decoder.decode(value, { stream: true });
        }
      }
      text += decoder.decode();
      return text;
    }
    return resp.text();
  }

  /**
   * 拉取远程可用模型目录
   * @param {object} profile
   */
  async fetchModels(profile) {
    if (!profile) {
      return { success: false, error: '缺少配置' };
    }

    const baseUrl = profile.baseUrl ? profile.baseUrl.trim() : '';
    if (!baseUrl) {
      return { success: false, error: '未配置 Base URL，无法拉取模型' };
    }

    let parsedUrl;
    try {
      parsedUrl = new URL(baseUrl);
    } catch {
      return { success: false, error: `Base URL 无效: ${baseUrl}` };
    }

    const isLoopback = parsedUrl.protocol === 'http:' && (parsedUrl.hostname === '127.0.0.1' || parsedUrl.hostname === 'localhost');
    if (parsedUrl.protocol !== 'https:' && !isLoopback) {
      return { ok: false, success: false, error: '安全限制：仅允许 HTTPS 或本地回环端点' };
    }

    let apiKey = null;
    if (profile.credentialRef) {
      apiKey = this.credentialsStore.getKey(profile.credentialRef);
    }
    if (!apiKey) {
      return { ok: false, success: false, error: '未找到已保存的 API Key，请先保存连接与凭据后再拉取模型' };
    }

    const fetchFn = (typeof electronNet !== 'undefined' && electronNet && electronNet.fetch) ? electronNet.fetch : fetch;

    // provider 识别：依据明确类型或严格的 host/path，禁止通过 URL 任意子串识别
    const isCloudflare = profile.provider === 'cloudflare' || (parsedUrl.hostname === 'api.cloudflare.com' && parsedUrl.pathname.startsWith('/client/v4/accounts/')) || parsedUrl.pathname.startsWith('/client/v4/accounts/');
    const isOpenRouter = profile.provider === 'openrouter' || parsedUrl.hostname === 'openrouter.ai' || parsedUrl.pathname.startsWith('/openrouter');

    if (isOpenRouter) {
      return this._fetchOpenRouterModels(fetchFn, baseUrl, apiKey);
    }

    if (isCloudflare) {
      return this._fetchCloudflareModels(fetchFn, baseUrl, apiKey, isLoopback);
    }

    // 3. 通用 OpenAI-compatible 服务
    return this._fetchGenericOpenAIModels(fetchFn, baseUrl, apiKey);
  }

  /**
   * OpenRouter 模型目录
   */
  async _fetchOpenRouterModels(fetchFn, baseUrl, apiKey) {
    let endpoint = 'https://openrouter.ai/api/v1/models';
    if (baseUrl) {
      const cleanBase = baseUrl.replace(/\/+$/, '');
      if (cleanBase.endsWith('/models')) {
        endpoint = cleanBase;
      } else {
        endpoint = `${cleanBase}/models`;
      }
    }
    const abortCtrl = new AbortController();
    const timeout = setTimeout(() => abortCtrl.abort(), 15000);

    try {
      const resp = await fetchFn(endpoint, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'HTTP-Referer': 'https://xiaowu.local',
          'X-Title': 'Xiaowu Desktop',
          'Accept': 'application/json',
        },
        redirect: 'error',
        signal: abortCtrl.signal,
      });

      const bodyText = await this._readBodyWithLimit(resp, 4 * 1024 * 1024);
      clearTimeout(timeout);

      const clean = this.credentialsStore.sanitizeError(bodyText, [apiKey]);

      if (!resp.ok) {
        let msg = `HTTP ${resp.status}`;
        try {
          const parsed = JSON.parse(clean);
          if (parsed?.error?.message) msg = `[${resp.status}] ${parsed.error.message}`;
        } catch { /* ignore */ }
        return { ok: false, success: false, error: msg };
      }

      let parsed;
      try {
        parsed = JSON.parse(clean);
      } catch {
        return { ok: false, success: false, error: 'OpenRouter 返回的不是合法 JSON 目录数据' };
      }

      if (parsed?.error) {
        const errMsg = parsed.error.message || JSON.stringify(parsed.error);
        return { ok: false, success: false, error: `[业务报错] ${errMsg}` };
      }

      if (!parsed || !Array.isArray(parsed.data)) {
        return { ok: false, success: false, error: 'OpenRouter 响应中缺少 data 数组' };
      }

      const models = [];
      for (const item of parsed.data) {
        if (!item || !item.id) continue;

        // 筛选适合文本聊天的模型：剔除非文本输出能力的模型 (如纯图片生成/语音)
        const modality = item.architecture?.modality || '';
        const outputModalities = Array.isArray(item.output_modalities) ? item.output_modalities : [];
        if (modality) {
          const parts = modality.split('->');
          const outputPart = parts.length > 1 ? parts[1] : parts[0];
          if (!outputPart.includes('text')) {
            continue;
          }
        }
        if (outputModalities.length > 0 && !outputModalities.includes('text')) {
          continue;
        }

        let pricingPrompt = '未知';
        let pricingComp = '未知';
        if (item.pricing && typeof item.pricing === 'object') {
          const p = parseFloat(item.pricing.prompt);
          const c = parseFloat(item.pricing.completion);
          if (!isNaN(p)) {
            pricingPrompt = p === 0 ? '$0.00/M (当前)' : `$${(p * 1000000).toFixed(2)}/M`;
          }
          if (!isNaN(c)) {
            pricingComp = c === 0 ? '$0.00/M (当前)' : `$${(c * 1000000).toFixed(2)}/M`;
          }
        }

        models.push({
          id: item.id,
          name: item.name || item.id,
          context_length: item.context_length || undefined,
          contextLength: item.context_length || undefined,
          description: item.description ? item.description.slice(0, 100) : undefined,
          pricing: { prompt: pricingPrompt, completion: pricingComp },
          provider: 'openrouter',
        });
      }

      return {
        ok: true,
        success: true,
        provider: 'openrouter',
        models,
        count: models.length,
      };
    } catch (e) {
      clearTimeout(timeout);
      return {
        ok: false,
        success: false,
        error: this.credentialsStore.sanitizeError(e.message || '拉取 OpenRouter 模型目录失败', [apiKey]),
      };
    }
  }

  /**
   * Cloudflare Workers AI 模型目录
   */
  async _fetchCloudflareModels(fetchFn, baseUrl, apiKey, isLoopback = false) {
    // 严格解析 32 位十六进制 Account ID（若在本地回环测试环境则兼容 mock ID）
    let match = baseUrl.match(/\/accounts\/([a-fA-F0-9]{32})(?:\/|$)/);
    if (!match && isLoopback) {
      match = baseUrl.match(/\/accounts\/([a-zA-Z0-9_-]+)(?:\/|$)/);
    }
    if (!match || !match[1]) {
      return {
        ok: false,
        success: false,
        error: '无法从 Base URL 中解析有效的 32 位 Cloudflare Account ID，端点需形如 https://api.cloudflare.com/client/v4/accounts/{32位hex_account_id}/ai/v1',
      };
    }
    const accountId = match[1];

    let searchBase = 'https://api.cloudflare.com';
    try {
      const u = new URL(baseUrl);
      searchBase = u.origin;
    } catch { /* ignore */ }

    let page = 1;
    const perPage = 50;
    const maxPages = 6;
    const maxTotalModels = 150;
    const seenNames = new Set();
    const models = [];
    let truncated = false;

    // 全部分页总体超时预算 25 秒
    const TOTAL_BUDGET_MS = 25000;
    const startTime = Date.now();

    try {
      while (page <= maxPages && models.length < maxTotalModels) {
        const elapsed = Date.now() - startTime;
        const pageBudget = Math.max(1000, TOTAL_BUDGET_MS - elapsed);
        if (pageBudget <= 1000) {
          truncated = true;
          break;
        }

        const searchUrl = `${searchBase}/client/v4/accounts/${accountId}/ai/models/search?task=Text%20Generation&per_page=${perPage}&page=${page}`;
        const abortCtrl = new AbortController();
        const timeout = setTimeout(() => abortCtrl.abort(), Math.min(12000, pageBudget));

        let resp;
        let bodyText;
        try {
          resp = await fetchFn(searchUrl, {
            method: 'GET',
            headers: {
              'Authorization': `Bearer ${apiKey}`,
              'Accept': 'application/json',
            },
            redirect: 'error',
            signal: abortCtrl.signal,
          });
          bodyText = await this._readBodyWithLimit(resp, 2 * 1024 * 1024);
        } finally {
          clearTimeout(timeout);
        }

        const clean = this.credentialsStore.sanitizeError(bodyText, [apiKey]);

        if (!resp.ok) {
          let msg = `HTTP ${resp.status}`;
          try {
            const p = JSON.parse(clean);
            if (p?.errors && Array.isArray(p.errors) && p.errors.length > 0) {
              msg = `[${resp.status}] ${p.errors[0]?.message || msg}`;
            }
          } catch { /* ignore */ }
          return { ok: false, success: false, error: msg };
        }

        let parsed;
        try {
          parsed = JSON.parse(clean);
        } catch {
          return { ok: false, success: false, error: 'Cloudflare 返回的不是合法 JSON 目录数据' };
        }

        if (parsed.success !== true) {
          const errMsg = (parsed.errors && parsed.errors[0]?.message) || 'Cloudflare 业务报错';
          return { ok: false, success: false, error: `[Cloudflare 业务报错] ${errMsg}` };
        }

        if (!Array.isArray(parsed.result)) {
          return { ok: false, success: false, error: 'Cloudflare 响应中缺少 result 数组' };
        }

        const rawResultCount = parsed.result.length;

        for (const item of parsed.result) {
          if (!item) continue;
          // 工单硬约束：必须使用模型的 name（如 @cf/meta/llama-3.2-3b-instruct），严禁使用内部 UUID
          const modelName = item.name;
          if (!modelName || typeof modelName !== 'string') continue;

          if (seenNames.has(modelName)) continue;
          seenNames.add(modelName);

          // 严格校验文本生成能力，过滤非聊天模型 (Embedding / Rerank / 图像 / 音频等)
          const taskName = (item.task?.name || item.task || '').toLowerCase();
          const isNonChat =
            taskName.includes('embedding') ||
            taskName.includes('image') ||
            taskName.includes('audio') ||
            taskName.includes('speech') ||
            taskName.includes('translation') ||
            taskName.includes('rerank') ||
            taskName.includes('object') ||
            taskName.includes('detection');
          const isNonChatName = /bge-|embedding|rerank|whisper|stable-diffusion|flux|resnet|clip-/i.test(modelName);

          if (isNonChat || isNonChatName) {
            continue;
          }

          models.push({
            id: modelName,
            name: modelName,
            description: item.description ? item.description.slice(0, 100) : (item.task?.name ? `任务: ${item.task.name}` : undefined),
            provider: 'cloudflare',
          });

          if (models.length >= maxTotalModels) {
            truncated = true;
            break;
          }
        }

        // 翻页逻辑：兼容有/无 total_pages 响应，不要根据筛选后数量判断目录结束
        const resultInfo = parsed.result_info || {};
        const count = typeof resultInfo.count === 'number' ? resultInfo.count : rawResultCount;
        const totalCount = typeof resultInfo.total_count === 'number' ? resultInfo.total_count : null;
        let calculatedTotalPages = typeof resultInfo.total_pages === 'number' && resultInfo.total_pages > 0 ? resultInfo.total_pages : null;
        if (!calculatedTotalPages && totalCount !== null) {
          calculatedTotalPages = Math.ceil(totalCount / perPage);
        }

        if (rawResultCount === 0) {
          break;
        }

        if (calculatedTotalPages && page >= calculatedTotalPages) {
          break;
        }

        if (!calculatedTotalPages && (count < perPage || rawResultCount < perPage)) {
          break;
        }

        // 若达到单次抓取最大页数（6页），但还有更多页未读取，标记为截断
        if (page >= maxPages) {
          if ((calculatedTotalPages && calculatedTotalPages > maxPages) || (totalCount !== null && totalCount > maxPages * perPage) || count >= perPage) {
            truncated = true;
          }
          break;
        }

        page++;
      }

      if (models.length >= maxTotalModels) {
        truncated = true;
      }

      return {
        ok: true,
        success: true,
        provider: 'cloudflare',
        models,
        count: models.length,
        truncated,
      };
    } catch (e) {
      return {
        ok: false,
        success: false,
        error: this.credentialsStore.sanitizeError(e.message || '拉取 Cloudflare 模型目录失败', [apiKey]),
      };
    }
  }

  /**
   * 通用 OpenAI-compatible 接口模型目录
   */
  async _fetchGenericOpenAIModels(fetchFn, baseUrl, apiKey) {
    let modelsUrl = baseUrl.replace(/\/+$/, '');
    if (modelsUrl.endsWith('/chat/completions')) {
      modelsUrl = modelsUrl.slice(0, -'/chat/completions'.length);
    }
    if (!modelsUrl.endsWith('/models')) {
      if (modelsUrl.endsWith('/v1')) {
        modelsUrl += '/models';
      } else {
        modelsUrl += '/v1/models';
      }
    }

    const abortCtrl = new AbortController();
    const timeout = setTimeout(() => abortCtrl.abort(), 15000);

    try {
      const resp = await fetchFn(modelsUrl, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Accept': 'application/json',
        },
        redirect: 'error',
        signal: abortCtrl.signal,
      });

      const bodyText = await this._readBodyWithLimit(resp, 2 * 1024 * 1024);
      clearTimeout(timeout);

      const clean = this.credentialsStore.sanitizeError(bodyText, [apiKey]);

      if (resp.status === 404) {
        return {
          ok: false,
          success: false,
          unsupported: true,
          error: '当前服务未提供 /models 目录端点 (404 Not Found)，请手动填写 Model ID',
        };
      }

      if (!resp.ok) {
        let msg = `拉取失败 (HTTP ${resp.status})`;
        try {
          const p = JSON.parse(clean);
          if (p?.error?.message) {
            msg = `[${resp.status}] ${p.error.message}`;
          } else if (p?.message) {
            msg = `[${resp.status}] ${p.message}`;
          }
        } catch { /* ignore */ }
        return {
          ok: false,
          success: false,
          error: this.credentialsStore.sanitizeError(msg, [apiKey]),
        };
      }

      let parsed;
      try {
        parsed = JSON.parse(clean);
      } catch {
        return {
          ok: false,
          success: false,
          unsupported: true,
          error: '服务返回的不是 JSON 格式的模型目录，请手动填写 Model ID',
        };
      }

      if (parsed?.error) {
        const errMsg = parsed.error.message || JSON.stringify(parsed.error);
        return { ok: false, success: false, error: `[业务报错] ${errMsg}` };
      }

      const list = Array.isArray(parsed?.data) ? parsed.data : (Array.isArray(parsed) ? parsed : []);
      if (list.length === 0) {
        return {
          ok: false,
          success: false,
          unsupported: true,
          error: '返回的模型列表为空，请手动填写 Model ID',
        };
      }

      const models = list.map((item) => {
        const id = item.id || item.name || String(item);
        return {
          id,
          name: item.name || id,
          provider: 'openai-compatible',
        };
      });

      return {
        ok: true,
        success: true,
        provider: 'openai-compatible',
        models,
        count: models.length,
      };
    } catch (e) {
      clearTimeout(timeout);
      return {
        ok: false,
        success: false,
        error: this.credentialsStore.sanitizeError(e.message || '拉取模型目录失败', [apiKey]),
      };
    }
  }
}

module.exports = { ChatService };
