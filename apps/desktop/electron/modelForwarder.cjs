'use strict';
const http = require('node:http');
const https = require('node:https');
const { URL } = require('node:url');

/**
 * 创建受控模型转发服务（为 Pi SDK 提供安全受控的 OpenAI 兼容接口）
 * @param {object} options
 * @param {function} options.getAuthoritativeData 获取主进程权威数据快照
 * @param {object} options.credentialsStore 凭据存储管理服务
 * @returns {function} modelForwarder(req, res, modelBody, reg)
 */
function createModelForwarder({ getAuthoritativeData, credentialsStore }) {
  return async function modelForwarder(req, res, modelBody, reg) {
    let baseUrl = process.env.LUMA_PI_MODEL_BASE_URL;
    let apiKey = process.env.LUMA_PI_MODEL_API_KEY;
    let modelName = process.env.LUMA_PI_MODEL_NAME;

    // 若环境变量未显式配置，严格从发起任务的成员授权配置中提取，严禁跨成员借用
    if (!baseUrl || !apiKey) {
      try {
        const authData = typeof getAuthoritativeData === 'function' ? getAuthoritativeData() : null;
        const targetAgent = authData?.agents?.find((a) => a.id === reg?.agentId);
        if (!targetAgent) {
          res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' });
          return res.end(JSON.stringify({
            error: {
              message: `未找到发起任务的成员登记信息 (${reg?.agentId})，严禁跨成员借用模型配置`,
              type: 'service_unavailable',
              code: 'AGENT_NOT_FOUND'
            }
          }));
        }

        const authProfile = Array.isArray(authData?.chatProfiles) && targetAgent.profileId
          ? authData.chatProfiles.find((p) => p.id === targetAgent.profileId)
          : null;

        if (!authProfile) {
          res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' });
          return res.end(JSON.stringify({
            error: {
              message: `成员 ${targetAgent.name || reg?.agentId} 未绑定模型配置 (profileId: ${targetAgent.profileId || '无'})，严禁借用其他成员配置`,
              type: 'service_unavailable',
              code: 'PROFILE_NOT_CONFIGURED'
            }
          }));
        }

        if (!authProfile.baseUrl || !authProfile.baseUrl.trim()) {
          res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' });
          return res.end(JSON.stringify({
            error: {
              message: `成员 ${targetAgent.name || reg?.agentId} 绑定的配置缺少有效 Base URL`,
              type: 'service_unavailable',
              code: 'BASE_URL_MISSING'
            }
          }));
        }

        baseUrl = authProfile.baseUrl.trim();
        modelName = modelName || authProfile.model;

        if (authProfile.credentialRef && credentialsStore) {
          try {
            apiKey = credentialsStore.getKey(authProfile.credentialRef);
          } catch (err) {
            console.warn(`[modelForwarder] 成员 ${reg?.agentId} 凭据解密失败:`, err.message);
          }
        }

        if (!apiKey) {
          res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' });
          return res.end(JSON.stringify({
            error: {
              message: `成员 ${targetAgent.name || reg?.agentId} 缺少已授权的模型密钥 (${authProfile.credentialRef || '未配置凭据引用'})`,
              type: 'service_unavailable',
              code: 'CREDENTIAL_UNAVAILABLE'
            }
          }));
        }
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({
          error: {
            message: `读取成员授权配置异常: ${err.message}`,
            type: 'internal_error',
            code: 'MODEL_CONFIG_LOOKUP_ERROR'
          }
        }));
      }
    }

    if (!baseUrl || !apiKey) {
      res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({
        error: {
          message: '未找到可用模型配置：请为当前成员配置有效模型与凭据，或配置 LUMA_PI_MODEL_BASE_URL 环境变量。',
          type: 'service_unavailable',
          code: 'MODEL_FORWARDER_UNAVAILABLE'
        }
      }));
    }

    // 规范化目标 URL
    let targetUrlStr = baseUrl.trim();
    let parsedUrl;
    try {
      parsedUrl = new URL(targetUrlStr);
    } catch {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ error: { message: `无效的模型 Base URL: ${targetUrlStr}` } }));
    }

    let pathname = parsedUrl.pathname.replace(/\/+$/, '');
    if (pathname.endsWith('/chat/completions')) {
      // 已是完整端点
    } else if (pathname.endsWith('/v1')) {
      pathname += '/chat/completions';
    } else if (pathname === '' || pathname === '/') {
      pathname = '/v1/chat/completions';
    } else {
      pathname += '/chat/completions';
    }
    parsedUrl.pathname = pathname;

    // 构造请求 payload
    const forwardedBody = { ...modelBody };
    if ((!forwardedBody.model || forwardedBody.model === 'pi-default') && modelName) {
      forwardedBody.model = modelName;
    }
    const payloadStr = JSON.stringify(forwardedBody);

    const isHttps = parsedUrl.protocol === 'https:';
    const client = isHttps ? https : http;

    const requestOptions = {
      protocol: parsedUrl.protocol,
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (isHttps ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'Content-Length': Buffer.byteLength(payloadStr)
      }
    };

    let upstreamReq = null;

    const abortUpstream = () => {
      if (upstreamReq && !upstreamReq.destroyed) {
        upstreamReq.destroy();
      }
    };

    // 响应端生命周期监听：若客户端在中途断开（取消/停止），必须立即销毁上游请求
    if (res && typeof res.on === 'function') {
      res.on('close', () => {
        if (!res.writableEnded) {
          abortUpstream();
        }
      });
      res.on('error', () => {
        abortUpstream();
      });
    }
    if (req && typeof req.on === 'function') {
      req.on('close', () => {
        if (!res.writableEnded) {
          abortUpstream();
        }
      });
    }

    upstreamReq = client.request(requestOptions, (upstreamRes) => {
      const headers = { ...upstreamRes.headers };
      headers['access-control-allow-origin'] = '*';
      res.writeHead(upstreamRes.statusCode || 200, headers);
      upstreamRes.pipe(res);

      upstreamRes.on('error', () => {
        if (!res.writableEnded) {
          res.end();
        }
      });
    });

    upstreamReq.setTimeout(120000, () => {
      abortUpstream();
      if (!res.headersSent) {
        res.writeHead(504, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: { message: '上游模型服务响应超时' } }));
      }
    });

    upstreamReq.on('error', (err) => {
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: { message: `模型上游请求失败: ${err.message}` } }));
      } else if (!res.writableEnded) {
        res.end();
      }
    });

    upstreamReq.write(payloadStr);
    upstreamReq.end();
  };
}

module.exports = { createModelForwarder };
