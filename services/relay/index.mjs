const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json;charset=utf-8','cache-control':'no-store'}});
const failure=(code,message,status=503)=>json({error:{code,message,retryable:status>=500}},status);
function sameSecret(a,b){if(typeof a!=='string'||typeof b!=='string'||a.length!==64||b.length!==64)return false;let n=0;for(let i=0;i<64;i++)n|=a.charCodeAt(i)^b.charCodeAt(i);return n===0;}
export class LumaRelay {
 constructor(ctx,env){this.ctx=ctx;this.env=env;this.pending=new Map();}
 desktops(){return this.ctx.getWebSockets().filter(ws=>ws.deserializeAttachment()?.authenticated===true&&ws.readyState===1);}
 async fetch(request){
  const path=new URL(request.url).pathname;
  if(path==='/internal/relay'){
   if(request.headers.get('origin')||request.headers.get('upgrade')?.toLowerCase()!=='websocket')return failure('forbidden','仅允许受控桌面连接',403);
   for(const stale of this.ctx.getWebSockets())if(!stale.deserializeAttachment()?.authenticated&&Date.now()-(stale.deserializeAttachment()?.createdAt||0)>15000)stale.close(1008,'authentication expired');
   if(this.ctx.getWebSockets().filter(ws=>ws.readyState===1).length>=8)return failure('busy','连接数量已达上限',503);
   const [client,server]=Object.values(new WebSocketPair());this.ctx.acceptWebSocket(server);
   server.serializeAttachment({authenticated:false,createdAt:Date.now()});
   return new Response(null,{status:101,webSocket:client});
  }
  if(!sameSecret(request.headers.get('authorization')?.replace(/^Bearer /,''),this.env.RELAY_TOKEN))return failure('forbidden','未获授权',403);
  if(path==='/status')return json({online:this.desktops().length>0});
  if(path!=='/rpc'||request.method!=='POST')return failure('not_found','接口不存在',404);
  const raw=await request.text();if(raw.length>380000)return failure('invalid_request','请求过长',400);
  let message;try{message=JSON.parse(raw);}catch{return failure('invalid_request','无效JSON',400);}
  if(!['members','conversations','messages','delete-message','chat','job','memories','save-memory','sync-status','memory-garden','memory-garden-detail','memory-garden-related','diary-books','diary-catalog','diary-entry','diary-generate','diary-job','diary-settings-get','diary-settings-set','study-books','study-book','study-section','study-create','study-append','study-annotate','study-mark-dry','study-prompt-next','study-revision','study-section-hidden','study-section-rewrite','study-cancel-rewrite','study-set-status','autonomy-presence','autonomy-status','autonomy-settings','autonomy-wake','moments-list','moments-post','moments-like','moments-comment','moments-delete','moments-image','workbench-snapshot','owner-journal-read','owner-journal-save'].includes(message.operation)||typeof message.payload!=='object'||!message.payload)return failure('invalid_request','无效操作',400);
  if(!['chat','save-memory','moments-post','owner-journal-save'].includes(message.operation)&&raw.length>20000)return failure('invalid_request','请求过长',400);
  const ds=this.desktops();const ws=ds[ds.length-1];if(!ws)return failure('house_offline','电脑离线，暂时无法回复',503);
  if(this.pending.size>=32)return failure('busy','请稍后重试',503);
  const id=crypto.randomUUID();
  return new Promise(resolve=>{
   const timer=setTimeout(()=>{
     this.pending.delete(id);
     try{ws.close(1006,'rpc_timeout');}catch{}
     resolve(failure('house_offline','桌面没有及时响应，请保留消息后重试',503));
   },12000);
   this.pending.set(id,{resolve,timer,ws});
   try{ws.send(JSON.stringify({type:'request',id,operation:message.operation,payload:message.payload}));}
   catch{clearTimeout(timer);this.pending.delete(id);try{ws.close();}catch{}resolve(failure('house_offline','电脑连接已断开',503));}
  });
 }
 async webSocketMessage(ws,raw){
  if(typeof raw!=='string'||raw.length>1000000){ws.close(1008,'invalid frame');return;}
  let m;try{m=JSON.parse(raw);}catch{ws.close(1008,'invalid json');return;}
  const attachment=ws.deserializeAttachment();
  if(!attachment?.authenticated){
   if(m.type!=='auth'||!sameSecret(m.token,this.env.RELAY_TOKEN)||m.homeId!==this.env.HOME_ID||Date.now()-attachment.createdAt>15000){ws.close(1008,'unauthorized');return;}
   for(const old of this.desktops())if(old!==ws)old.close(1000,'desktop replaced');
   ws.serializeAttachment({authenticated:true,homeId:this.env.HOME_ID});ws.send(JSON.stringify({type:'ready'}));return;
  }
  if(m.type==='ping'){ws.send(JSON.stringify({type:'pong'}));return;}
  if(m.type!=='response'||typeof m.id!=='string')return;
  const p=this.pending.get(m.id);if(!p||p.ws!==ws)return;
  clearTimeout(p.timer);this.pending.delete(m.id);
  if(!Number.isInteger(m.status)||m.status<200||m.status>599||typeof m.body!=='object'||!m.body){p.resolve(failure('invalid_response','桌面返回无效数据',502));return;}
  p.resolve(json(m.body,m.status));
 }
 disconnected(ws){for(const [id,p]of this.pending)if(p.ws===ws){clearTimeout(p.timer);this.pending.delete(id);p.resolve(failure('house_offline','电脑连接已断开',503));}}
 webSocketClose(ws){this.disconnected(ws);}
 webSocketError(ws){this.disconnected(ws);try{ws.close(1011,'relay error');}catch{}}
}
export default {fetch(request,env){const p=new URL(request.url).pathname;if(p==='/health')return json({ok:true,schema:'luma-relay/1'});return env.RELAY.get(env.RELAY.idFromName(env.HOME_ID)).fetch(request);}};
