import { deliverMobileMessages } from './reply-delivery.mjs';
export function routeOperation(path,method,url){
 if(method==='GET'&&path==='/api/autonomy')return {operation:'autonomy-status',payload:{}};
 if(method==='GET'&&path==='/api/autonomy/presence')return {operation:'autonomy-presence',payload:{}};
 if(method==='POST'&&path==='/api/autonomy/settings')return {operation:'autonomy-settings',payload:null};
 if(method==='POST'&&path==='/api/autonomy/wake')return {operation:'autonomy-wake',payload:null};
 if(method==='GET'&&path==='/api/members')return {operation:'members',payload:{}};
 if(method==='GET'&&path==='/api/conversations')return {operation:'conversations',payload:{}};
 if(method==='GET'&&path==='/api/messages')return {operation:'messages',payload:{conversationId:url.searchParams.get('conversationId'),after:url.searchParams.get('after')||undefined}};
 if(method==='POST'&&path==='/api/messages/delete')return {operation:'delete-message',payload:null};
 if(method==='POST'&&path==='/api/chat')return {operation:'chat',payload:null};
 if(method==='GET'&&/^\/api\/chat\/jobs\/[^/]+$/.test(path))return {operation:'job',payload:{jobId:decodeURIComponent(path.split('/').at(-1))}};
 if(method==='GET'&&path==='/api/memories')return {operation:'memories',payload:{scopeType:url.searchParams.get('scopeType')||undefined,scopeId:url.searchParams.get('scopeId')||undefined}};
 if(method==='POST'&&path==='/api/memories')return {operation:'save-memory',payload:null};
 if(method==='GET'&&path==='/api/sync-status')return {operation:'sync-status',payload:{}};
 if(method==='GET'&&path==='/api/memory-garden')return {operation:'memory-garden',payload:{cursor:url.searchParams.get('cursor')||undefined,limit:url.searchParams.get('limit')||undefined}};
 if(method==='GET'&&path==='/api/memory-garden/detail')return {operation:'memory-garden-detail',payload:{key:url.searchParams.get('key')||undefined}};
 if(method==='GET'&&path==='/api/memory-garden/related')return {operation:'memory-garden-related',payload:{key:url.searchParams.get('key')||undefined}};
 if(method==='GET'&&path==='/api/diary/owner')return {operation:'owner-journal-read',payload:{date:url.searchParams.get('date')||undefined}};
 if(method==='POST'&&path==='/api/diary/owner')return {operation:'owner-journal-save',payload:null};
 if(method==='GET'&&path==='/api/diary/books')return {operation:'diary-books',payload:{}};
 if(method==='GET'&&path==='/api/diary/catalog')return {operation:'diary-catalog',payload:{agentId:url.searchParams.get('agentId')||undefined,limit:url.searchParams.get('limit')||undefined,cursor:url.searchParams.get('cursor')||undefined}};
 if(method==='GET'&&path==='/api/diary/entry')return {operation:'diary-entry',payload:{agentId:url.searchParams.get('agentId')||undefined,date:url.searchParams.get('date')||undefined,version:url.searchParams.get('version')||undefined}};
 if(method==='POST'&&path==='/api/diary/generate')return {operation:'diary-generate',payload:null};
 if(method==='GET'&&/^\/api\/diary\/jobs\/[^/]+$/.test(path))return {operation:'diary-job',payload:{jobId:decodeURIComponent(path.split('/').at(-1))}};
 if(method==='GET'&&path==='/api/diary/settings')return {operation:'diary-settings-get',payload:{}};
 if(method==='POST'&&path==='/api/diary/settings')return {operation:'diary-settings-set',payload:null};
 if(method==='GET'&&path==='/api/moments')return {operation:'moments-list',payload:{cursor:url.searchParams.get('cursor')||undefined,limit:url.searchParams.get('limit')||undefined}};
 if(method==='POST'&&path==='/api/moments/post')return {operation:'moments-post',payload:null};
 if(method==='POST'&&path==='/api/moments/like')return {operation:'moments-like',payload:null};
 if(method==='POST'&&path==='/api/moments/comment')return {operation:'moments-comment',payload:null};
 if(method==='POST'&&path==='/api/moments/delete')return {operation:'moments-delete',payload:null};
 if(method==='GET'&&path==='/api/moments/image')return {operation:'moments-image',payload:{attachmentId:url.searchParams.get('attachmentId')}};
 if(method==='GET'&&path==='/api/study/books')return {operation:'study-books',payload:{}};
 if(method==='GET'&&path==='/api/study/book')return {operation:'study-book',payload:{bookId:url.searchParams.get('bookId')}};
 if(method==='POST'&&path==='/api/study/create')return {operation:'study-create',payload:null};
 if(method==='POST'&&path==='/api/study/append')return {operation:'study-append',payload:null};
 if(method==='POST'&&path==='/api/study/annotate')return {operation:'study-annotate',payload:null};
 if(method==='POST'&&path==='/api/study/mark-dry')return {operation:'study-mark-dry',payload:null};
 if(method==='POST'&&path==='/api/study/revision')return {operation:'study-revision',payload:null};
  if(method==='POST'&&path==='/api/study/section-hidden')return {operation:'study-section-hidden',payload:null};
  if(method==='POST'&&path==='/api/study/section-rewrite')return {operation:'study-section-rewrite',payload:null};
  if(method==='POST'&&path==='/api/study/cancel-rewrite')return {operation:'study-cancel-rewrite',payload:null};
 if(method==='GET'&&path==='/api/workbench')return {operation:'workbench-snapshot',payload:{}};
 return null;
}
export async function forwardMobile(request,env,operation){
 if(!env.LUMA_RELAY||!env.LUMA_RELAY_TOKEN)return new Response(JSON.stringify({error:{code:'house_offline',message:'桌面接线尚未配置',retryable:true}}),{status:503,headers:{'content-type':'application/json','cache-control':'no-store'}});
 if(operation.operation==='owner-journal-save'){
  const raw=await request.text();if(raw.length>380000)return new Response(JSON.stringify({error:{code:'invalid_request',message:'手记过长',retryable:false}}),{status:400,headers:{'content-type':'application/json','cache-control':'no-store'}});
  operation.payload=raw?JSON.parse(raw):{};
 }
 if(operation.operation==='chat'){
  const raw=await request.text();if(raw.length>380000)return new Response(JSON.stringify({error:{code:'invalid_request',message:'消息过长',retryable:false}}),{status:400,headers:{'content-type':'application/json','cache-control':'no-store'}});
  const body=JSON.parse(raw);
  const attachments = Array.isArray(body.attachments) ? body.attachments.slice(0, 4).map(a => ({
    name: typeof a.name === 'string' ? a.name.slice(0, 160) : 'image.jpg',
    dataBase64: typeof a.dataBase64 === 'string' ? a.dataBase64 : ''
  })).filter(a => a.dataBase64.length > 0) : undefined;
  operation.payload={requestId:body.requestId,conversationId:body.conversationId,targetAgentId:body.targetAgentId,text:body.text,...(attachments?.length ? { attachments } : {})};
 }
 if(operation.operation==='moments-post'){
  const raw=await request.text();if(raw.length>380000)return new Response(JSON.stringify({error:{code:'invalid_request',message:'内容过长',retryable:false}}),{status:400,headers:{'content-type':'application/json','cache-control':'no-store'}});
  const body=JSON.parse(raw);
  const attachments = Array.isArray(body.attachments) ? body.attachments.slice(0, 9).map(a => ({
    name: typeof a.name === 'string' ? a.name.slice(0, 160) : 'image.jpg',
    dataBase64: typeof a.dataBase64 === 'string' ? a.dataBase64 : ''
  })).filter(a => a.dataBase64.length > 0) : undefined;
  operation.payload={requestId:body.requestId,text:body.text,location:body.location,...(attachments?.length ? { attachments } : {})};
 }
 if(operation.operation==='delete-message'||operation.operation==='save-memory'||operation.operation==='diary-generate'||operation.operation==='diary-settings-set'||operation.operation==='autonomy-settings'||operation.operation==='autonomy-wake'||operation.operation==='moments-like'||operation.operation==='moments-comment'||operation.operation==='moments-delete'||operation.operation==='study-create'||operation.operation==='study-append'||operation.operation==='study-annotate'||operation.operation==='study-mark-dry'||operation.operation==='study-revision'||operation.operation==='study-section-hidden'||operation.operation==='study-section-rewrite'||operation.operation==='study-cancel-rewrite'){
  const raw=await request.text();if(raw.length>65536)return new Response(JSON.stringify({error:{code:'invalid_request',message:'内容过长',retryable:false}}),{status:400,headers:{'content-type':'application/json','cache-control':'no-store'}});
  operation.payload=raw?JSON.parse(raw):{};
 }
 const response=await env.LUMA_RELAY.fetch(new Request('https://relay.internal/rpc',{method:'POST',headers:{authorization:'Bearer '+env.LUMA_RELAY_TOKEN,'content-type':'application/json'},body:JSON.stringify(operation)}));
 if(response.ok&&operation.operation==='messages') {
  const body=await response.json();
  if(Array.isArray(body.messages))body.messages=deliverMobileMessages(body.messages);
  return new Response(JSON.stringify(body),{status:response.status,headers:response.headers});
 }
 return response;
}
export async function relayOnline(env){if(!env.LUMA_RELAY||!env.LUMA_RELAY_TOKEN)return false;try{const r=await env.LUMA_RELAY.fetch(new Request('https://relay.internal/status',{headers:{authorization:'Bearer '+env.LUMA_RELAY_TOKEN}}));return r.ok&&(await r.json()).online===true;}catch{return false;}}
