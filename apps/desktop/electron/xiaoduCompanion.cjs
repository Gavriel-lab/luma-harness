'use strict';
const http = require('node:http');
const crypto = require('node:crypto');

class XiaoduCompanionServer {
  constructor({ rpc, port = 58563, onLog = console.log }) {
    this.rpc = rpc;
    this.port = port;
    this.onLog = onLog;
    this.server = null;
  }

  start() {
    this.server = http.createServer((req, res) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

      if (url.pathname === '/api/xiaodu/status' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, companion: 'xiaodu-nv6001', target: 'agent_coordinator', status: 'ready' }));
        return;
      }

      if (url.pathname === '/api/xiaodu/chat' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => {
          body += chunk;
          if (body.length > 256 * 1024) {
            req.destroy();
          }
        });

        req.on('end', async () => {
          try {
            const data = JSON.parse(body || '{}');
            const text = (data.text || '').trim();
            if (!text) {
              res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
              res.end(JSON.stringify({ ok: false, error: 'text 不能为空' }));
              return;
            }

            const requestId = 'xiaodu_' + Date.now() + '_' + crypto.randomBytes(3).toString('hex');
            const conversationId = 'conv_dm_coordinator';
            const targetAgentId = 'agent_coordinator';

            this.onLog(`[XiaoduCompanion] 收到小度语音文本: "${text}", 发送给协调者...`);

            // 调用协调者现有的 MobileRpc 对话提交
            const submitResult = await this.rpc.submit({
              requestId,
              conversationId,
              targetAgentId,
              text,
            });

            if (submitResult.status !== 200) {
              this.onLog(`[XiaoduCompanion] 提交失败: ${JSON.stringify(submitResult)}`);
              res.writeHead(submitResult.status, { 'Content-Type': 'application/json; charset=utf-8' });
              res.end(JSON.stringify(submitResult.body));
              return;
            }

            // 轮询等待协调者的 Codex CLI 回复完成
            let replyText = '';
            let finished = false;
            for (let i = 0; i < 90; i++) {
              await new Promise(r => setTimeout(r, 1000));
              const jobStatus = this.rpc.lookup({ requestId });
              if (jobStatus.status === 200) {
                if (jobStatus.body.state === 'done') {
                  replyText = jobStatus.body.reply?.content || '';
                  finished = true;
                  break;
                } else if (jobStatus.body.state === 'failed') {
                  finished = true;
                  replyText = '呜… 刚才回答中断了一下，再跟他说一遍试试？';
                  break;
                }
              }
            }

            if (!finished) {
              replyText = '在呢，他在深入思考，稍后你可以在桌面上看到回复哦~';
            }

            this.onLog(`[XiaoduCompanion] 协调者回复完毕: "${replyText.slice(0, 50)}..."`);
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({
              ok: true,
              requestId,
              reply: replyText
            }));
          } catch (err) {
            this.onLog(`[XiaoduCompanion] 内部异常: ${err.message}`);
            res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: false, error: err.message }));
          }
        });
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'not_found' }));
    });

    this.server.listen(this.port, '0.0.0.0', () => {
      this.onLog(`[XiaoduCompanion] 局域网小度伴侣服务已在端口 ${this.port} 启动监听！`);
    });

    this.server.on('error', err => {
      this.onLog(`[XiaoduCompanion] 服务启动异常: ${err.message}`);
    });
  }

  stop() {
    if (this.server) {
      try {
        this.server.close();
      } catch (e) {}
      this.server = null;
    }
  }
}

module.exports = { XiaoduCompanionServer };
