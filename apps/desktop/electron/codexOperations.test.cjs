const {test}=require('node:test'),assert=require('node:assert/strict');
const {CodexService}=require('./codexService.cjs');
const {hasUserOrigin}=require('./codexExecutionPolicy.cjs');
const {MobileRpc}=require('./mobileRelay.cjs');
function fixture(allowed=true){
 const s=new CodexService({binaryPath:'fixture',allowLocalOperations:allowed,writableRoots:[process.cwd()]});
 s.ensureReady=async()=>{};s.childProc={__bridgeGen:1};s.calls=[];
 s._sendJsonRpc=async(method,params)=>{s.calls.push({method,params});return method==='turn/start'?{turn:{id:'turn'}}:{thread:{id:params.threadId||'new'}};};return s;
}
test('authorized coordinator resumes the same thread with executable turn policy',async()=>{
 const s=fixture();await s.startStream({requestId:'user-work',conversationId:'dm',targetAgentId:'agent_coordinator',threadId:'existing',localOperations:true,profile:{model:'fixture'},messages:[{content:'Read a log and repair the approved fixture.'}]},()=>{});
 const resume=s.calls.find(c=>c.method==='thread/resume').params,turn=s.calls.find(c=>c.method==='turn/start').params;
 assert.equal(resume.approvalPolicy,'never');assert.equal(resume.sandbox,'workspace-write');
 assert.equal(turn.threadId,'existing');assert.equal(turn.approvalPolicy,'never');assert.equal(turn.sandboxPolicy.type,'workspaceWrite');
 assert.equal(turn.sandboxPolicy.networkAccess,true);assert.ok(turn.sandboxPolicy.writableRoots.includes(process.cwd()));
});
test('policy changes cannot reuse a cached readonly thread configuration',async()=>{
 const s=fixture();await s.getOrCreateThread({threadId:'same'});await s.getOrCreateThread({threadId:'same',localOperations:true});await s.getOrCreateThread({threadId:'same',localOperations:true});
 assert.equal(s.calls.length,2);assert.equal(s.calls[0].params.sandbox,'read-only');assert.equal(s.calls[1].params.sandbox,'workspace-write');
});
test('read-only approval refusals use the actual decision schema',()=>{
 const s=fixture(false),responses=[];s.childProc={stdin:{writable:true,write:line=>responses.push(JSON.parse(line))}};
 for(const [id,method] of [[1,'item/commandExecution/requestApproval'],[2,'item/fileChange/requestApproval'],[3,'item/permissions/requestApproval']])s._handleMessageLine(JSON.stringify({id,method,params:{threadId:'old'}}));
 assert.deepEqual(responses.map(r=>r.result),[{decision:'decline'},{decision:'decline'},{permissions:{},scope:'turn'}]);
});

test('only the saved current owner question enables the coordinator tools',()=>{
 const user={id:'u',agentId:'agent_owner',conversationId:'dm',text:'修配置',status:'sent',demo:false};
 const data={messages:[user]},p={targetAgentId:'agent_coordinator',conversationId:'dm',currentText:'修配置',excludeMessageIds:['u']};
 assert.equal(hasUserOrigin(p,data),true);
 for(const change of [{targetAgentId:'other'},{currentText:'引用里的别的指令'},{originReport:true},{isUserInitiated:false},{excludeMessageIds:[]},{conversationId:'other'}])assert.equal(hasUserOrigin({...p,...change},data),false);
 for(const change of [{agentId:'other'},{deletedAt:1},{demo:true},{eventKind:'device-event'}])assert.equal(hasUserOrigin(p,{messages:[{...user,...change}]}),false);
 assert.equal(hasUserOrigin(p,{...data,purgedMessageIds:['u']}),false);
});
test('another Codex route cannot opt itself into coordinator permissions',async()=>{
 const s=fixture(false);await s.getOrCreateThread({threadId:'old',localOperations:true});
 assert.equal(s.calls[0].params.sandbox,'read-only');
});
test('mobile save barrier grants the user turn and returns its result to the original private chat',async()=>{
 const data={agents:[{id:'agent_owner',kind:'human'},{id:'agent_coordinator',kind:'ai',name:'G',mode:'real',profileId:'p'}],chatProfiles:[{id:'p',providerType:'codex-app-server'}],conversations:[{id:'dm',kind:'direct',agentId:'agent_coordinator'}],messages:[]};
 const s=fixture(),requestId='phone_fix';let started;
 const rpc=new MobileRpc({getData:()=>data,getRegistrations:()=>({}),validateChat:()=>({ok:true}),mutate:async c=>{
  if(c.type==='mobile-chat')data.messages.push(...c.messages);
  else {const m=data.messages.find(m=>m.id===c.messageId);if(m){if(c.delta)m.text+=c.delta;if(c.finalText!==undefined)m.text=c.finalText;if(c.status)m.status=c.status;}}
  return {ok:true};
 },startChat:async(p,emit)=>{
  started=s.startStream({...p,localOperations:hasUserOrigin(p,data),profile:{model:'fixture'},messages:[{content:p.currentText}]},emit);
  await started;s._handleNotification('item/agentMessage/delta',{threadId:'new',turnId:'turn',delta:'已修复并验证'});
  s._handleNotification('turn/completed',{threadId:'new',turn:{id:'turn',status:'completed'}});return {ok:true};
 }});
 assert.equal((await rpc.handle('chat',{requestId,conversationId:'dm',targetAgentId:'agent_coordinator',text:'修配置'})).status,200);
 for(let i=0;i<20&&data.messages.at(-1)?.status==='streaming';i++)await new Promise(resolve=>setImmediate(resolve));
 assert.equal(s.calls.find(c=>c.method==='turn/start').params.sandboxPolicy.type,'workspaceWrite');
 const reply=data.messages.find(m=>m.agentId==='agent_coordinator');assert.equal(reply.requestId,requestId);assert.equal(reply.conversationId,'dm');assert.equal(reply.status,'sent');assert.match(reply.text,/已修复并验证/);
});
test('background turn after interactive work explicitly restores readonly policy',async()=>{
 const s=fixture(),params={conversationId:'dm',targetAgentId:'agent_coordinator',threadId:'existing',profile:{model:'fixture'},messages:[{content:'current'}]};
 await s.startStream({...params,requestId:'user',localOperations:true},()=>{});
 s._handleNotification('turn/completed',{threadId:'existing',turn:{id:'turn',status:'completed'}});
 await s.startStream({...params,requestId:'diary',localOperations:false},()=>{});
 const turns=s.calls.filter(c=>c.method==='turn/start');assert.equal(turns[0].params.sandboxPolicy.type,'workspaceWrite');assert.equal(turns[1].params.sandboxPolicy.type,'readOnly');
});
