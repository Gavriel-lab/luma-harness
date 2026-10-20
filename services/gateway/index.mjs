import { authenticate, AccessError } from './access.mjs';
import { handleSpeech } from './speech-api.mjs';
import {routeOperation,forwardMobile,relayOnline} from './mobile-api.mjs';

const HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};

function reply(body, status, head = false, extra = {}) {
  return new Response(head ? null : JSON.stringify(body), {
    status,
    headers: { ...HEADERS, ...extra },
  });
}

export function createWorker(checkAccess = authenticate) { return {
  async fetch(request, env = {}) {
    const head = request.method === "HEAD";
    const url = new URL(request.url);
    const path = url.pathname;
    let operation;try{operation=routeOperation(path,request.method,url);}catch{return reply({error:{code:'invalid_request',message:'无效地址',retryable:false}},400,head);}
    if (path === "/health") {
      if (request.method !== "GET" && !head) {
        return reply({ error: "method_not_allowed" }, 405,
          false, { allow: "GET, HEAD" });
      }
      return reply({ ok: true, schema: "health/1" }, 200, head);
    }
    // Unknown routes without assets remain 404; no speculative business calls.
    const isMusicApi = path.startsWith('/api/music/');
    const isSpeechApi = path === '/api/tts' || path === '/api/stt';
    if (path !== '/api/bootstrap' && path !== '/api/session' && !operation && !isMusicApi && !isSpeechApi && !env.ASSETS) {
      return reply({ error: 'not_found' }, 404, head);
    }
    if (request.method !== 'GET' && !head && !operation && !isSpeechApi && !isMusicApi) {
      return reply({ error: "method_not_allowed" }, 405,
        false, { allow: "GET, HEAD" });
    }
    let owner;
    try { owner = await checkAccess(request, env); }
    catch (error) {
      const code = error instanceof AccessError ? error.code : 'identity_unavailable';
      const status = error instanceof AccessError ? error.status : 503;
      return reply({ error: operation ? {code,message:status===401?'请重新登录小屋':status===403?'此账号没有小屋权限':'身份验证暂不可用',retryable:status===503}:code }, status, head);
    }
    if (isMusicApi) {
      const musicEndpoint = env.MUSIC_API_ENDPOINT;
      if(!musicEndpoint||!env.LUMA_MUSIC_SECRET)return reply({error:'music_not_configured'},503,head);
      const targetUrl = new URL(musicEndpoint + path + url.search);
      const reqHeaders = new Headers(request.headers);
      reqHeaders.set('x-luma-music-secret', env.LUMA_MUSIC_SECRET);

      try {
        const backendRes = await fetch(targetUrl.toString(), {
          method: request.method,
          headers: reqHeaders,
          body: (request.method !== 'GET' && request.method !== 'HEAD') ? request.body : null,
          redirect: 'follow'
        });
        const resHeaders = new Headers(backendRes.headers);
        resHeaders.set('cache-control', 'no-store, no-cache, must-revalidate');
        return new Response(head ? null : backendRes.body, {
          status: backendRes.status,
          headers: resHeaders
        });
      } catch (err) {
        return reply({ error: 'music_service_offline', message: '音乐服务连接暂不可用: ' + err.message }, 503, head);
      }
    }
    if(operation){
      if(request.method==='POST'&&request.headers.get('origin')&&request.headers.get('origin')!==url.origin)return reply({error:{code:'forbidden',message:'来源不符',retryable:false}},403);
      try{return await forwardMobile(request,env,operation);}catch(error){return reply({error:{code:error instanceof SyntaxError?'invalid_request':'house_offline',message:error instanceof SyntaxError?'请求JSON无效':'桌面连接暂不可用，请稍后重试',retryable:!(error instanceof SyntaxError)}},error instanceof SyntaxError?400:503);}
    }
    if (isSpeechApi) return handleSpeech(request, env);
    if (path === '/api/session') {
      return reply({ schema: 'luma.session/1', user: owner }, 200, head);
    }
    if (path === '/api/bootstrap') {
      const online=await relayOnline(env);
      return reply({
        schema: 'luma.bootstrap/1', name: 'Luma', release: env.LUMA_RELEASE || 'development',
        user: owner,
        endpoints: { session: '/api/session', bootstrap: '/api/bootstrap',members:'/api/members',conversations:'/api/conversations',messages:'/api/messages',chat:'/api/chat' },
        capabilities: {
          authentication: { ready: true, provider: 'cloudflare-access' },
          chat: { ready: online, reason: online ? null : 'house_offline' },
          memory: { ready: false, authority: 'cloudSync', protocol: 'memoryGateway', reason: 'not_connected' },
          workbench: { ready: false, reason: 'local_broker_not_connected' },
        },
      }, 200, head);
    }
    // An SPA fallback must never turn an unknown API into index.html.
    if (path === '/api' || path.startsWith('/api/') || path === '/v1' || path.startsWith('/v1/')) {
      return reply({ error: 'not_found' }, 404, head);
    }
    const asset = await env.ASSETS.fetch(request);
    const headers = new Headers(asset.headers);
    headers.set('cache-control', 'private, no-store');
    headers.set('x-content-type-options', 'nosniff');
    headers.set('referrer-policy', 'same-origin');
    return new Response(head ? null : asset.body, { status: asset.status, headers });
  },
}; }

export default createWorker();
