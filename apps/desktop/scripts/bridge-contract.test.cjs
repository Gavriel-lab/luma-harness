const test=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs');const path=require('node:path');const os=require('node:os');const {pathToFileURL}=require('node:url');
const {BridgeBroker}=require('../electron/bridgeBroker.cjs');
function fixture(){return {agents:[{id:'synth-s',name:'Synthetic S',kind:'ai',systemPrompt:'SYNTHETIC-PERSONA only. Relationship: synthetic teammate.',profileId:'p'}, {id:'synth-l',name:'Synthetic L',kind:'ai',systemPrompt:'SYNTHETIC-L-PERSONA. Relationship: synthetic teammate.',profileId:'p'}, {id:'agent_owner',name:'Synthetic human',kind:'human'}],chatProfiles:[{id:'p',providerType:'openai-compatible',model:'synthetic',baseUrl:'http://127.0.0.1'}],conversations:[{id:'lr',kind:'living-room'},{id:'ds',kind:'direct',agentId:'synth-s'},{id:'dl',kind:'direct',agentId:'synth-l'}],messages:[{id:'own',agentId:'agent_owner',conversationId:'ds',text:'OWN-CANARY 文件任务',createdAt:10,status:'sent',demo:false},{id:'other',agentId:'agent_owner',conversationId:'dl',text:'OTHER-PRIVATE-CANARY 文件任务',createdAt:10,status:'sent',demo:false},{id:'public',agentId:'agent_owner',conversationId:'lr',text:'PUBLIC-CANARY 文件任务',createdAt:11,status:'sent',demo:false}],memories:[],checkpoints:[],tickets:[{id:'ticket',title:'synthetic',goal:'文件任务 OWN-CANARY PUBLIC-CANARY',participantIds:['synth-s'],tasks:[{id:'task',title:'write synthetic.txt',assigneeId:'synth-s',status:'todo'}],discussion:{text:'synthetic approved decision'},artifacts:{text:''}}]};}
async function setup(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'luma-real-broker-'));const work=path.join(dir,'approved');fs.mkdirSync(work);let data=fixture();const broker=new BridgeBroker({dir:path.join(dir,'broker'),getData:()=>data});await broker.start();t.after(()=>broker.stop());const reg=broker.register({agentId:'synth-s',executorId:'zcode',workspace:work});const manifest=JSON.parse(fs.readFileSync(reg.manifestPath,'utf8'));const token=fs.readFileSync(manifest.tokenFile,'utf8');const call=async(route,body,options={})=>{const response=await fetch(broker.url+'/v1/bridge/'+route,{method:body?'POST':'GET',headers:{authorization:'Bearer '+(options.token||token),'content-type':'application/json',...options.headers},body:body?JSON.stringify({schemaVersion:1,requestId:crypto.randomUUID(),...body}):undefined});return response.json();};return{dir,work,broker,data,manifest,token,call};}
function report(job,outcome='submitted'){return{jobId:job.jobId,attemptId:job.attemptId,reportId:'rep_'+job.attemptId,outcome,summary:'synthetic result',artifacts:[],checks:[],checkpoint:null,unknowns:[]};}
test('real loopback broker: registration, ownership, duplicate dispatch/claim/report, review and restart',async t=>{
  const {broker,data,call,dir,work}=await setup(t);
  assert.equal((await call('session',null,{token:'WRONG'})).code,'unauthenticated');
  assert.equal((await call('session',null,{headers:{'X-Agent-Id':'synth-l'}})).code,'forbidden');
  assert.equal((await call('session',null,{headers:{Origin:'https://evil.invalid'}})).code,'forbidden');
  assert.equal((await call('claim',{schemaVersion:2})).code,'unsupported_schema');
  assert.equal((await call('claim',{})).job,null);
  const dispatched=broker.dispatch({ticketId:'ticket',taskId:'task',requestId:'dispatch-one'});
  assert.equal(broker.dispatch({ticketId:'ticket',taskId:'task',requestId:'dispatch-one'}).jobId,dispatched.jobId);
  assert.throws(()=>broker.dispatch({ticketId:'ticket',taskId:'task',requestId:'dispatch-two'}),/重复执行/);
  const {job}=await call('claim',{});assert.ok(job.attemptId);
  assert.equal((await call('claim',{})).job,null,'live lease cannot start a second run');
  const {packet}=await call('context',{jobId:job.jobId,attemptId:job.attemptId});
  const input=JSON.stringify(packet);assert.match(input,/SYNTHETIC-PERSONA/);assert.match(input,/OWN-CANARY/);assert.match(input,/PUBLIC-CANARY/);assert.doesNotMatch(input,/OTHER-PRIVATE-CANARY/);
  assert.equal((await call('context',{jobId:job.jobId,attemptId:'OLD'})).code,'stale_attempt');
  const event={jobId:job.jobId,attemptId:job.attemptId,seq:1,type:'started',summary:'synthetic start'};
  assert.ok((await call('events',event)).ok);assert.ok((await call('events',event)).duplicate);
  assert.equal((await call('events',{...event,summary:'changed'})).code,'forbidden');
  const outside=path.join(dir,'outside.txt');fs.writeFileSync(outside,'outside');
  assert.equal((await call('report',{...report(job),artifacts:[{path:outside}]})).code,'forbidden');
  const artifact=path.join(work,'synthetic.txt');fs.writeFileSync(artifact,'REAL-BROKER-ARTIFACT');
  const delivered={...report(job),artifacts:[{path:artifact}]};assert.ok((await call('report',delivered)).ok);assert.ok((await call('report',delivered)).duplicate);
  assert.equal(broker.snapshot().jobs[0].state,'review');broker.accept(job.jobId);assert.equal(broker.snapshot().jobs[0].state,'done');
  await broker.stop();const restored=new BridgeBroker({dir:path.join(dir,'broker'),getData:()=>data});await restored.start();t.after(()=>restored.stop());assert.equal(restored.snapshot().jobs[0].state,'done');assert.equal(restored.snapshot().jobs[0].report.artifacts[0].path,artifact);
});
test('memory correction revokes old attempt, stops late success; next dispatch gets latest authority',async t=>{
  const {broker,data,call}=await setup(t);broker.dispatch({ticketId:'ticket',taskId:'task',requestId:'before-forget'});const {job}=await call('claim',{});
  data.messages=data.messages.filter(m=>m.id!=='own');data.purgedMessageIds=['own'];
  assert.equal((await call('heartbeat',{jobId:job.jobId,attemptId:job.attemptId})).code,'stale_attempt');
  assert.equal((await call('report',report(job))).code,'stale_attempt');
  assert.ok((await call('report',report(job,'cancelled'))).ok);
  broker.dispatch({ticketId:'ticket',taskId:'task',requestId:'after-forget'});const next=(await call('claim',{})).job;
  assert.notEqual(next.jobId,job.jobId);assert.equal((await call('context',{jobId:next.jobId,attemptId:next.attemptId})).packet.memory.authorizedRelevantItems.some(i=>i.summary.includes('OWN-CANARY')),false);
});
test('broker restart preserves work and does not relaunch an expired run without explicit stop confirmation',async t=>{
  const {broker,data,call,dir}=await setup(t);broker.dispatch({ticketId:'ticket',taskId:'task',requestId:'interrupt'});const {job}=await call('claim',{});
  await broker.stop();const restored=new BridgeBroker({dir:path.join(dir,'broker'),getData:()=>data,now:()=>Date.now()+60000});await restored.start();t.after(()=>restored.stop());
  const reg=restored.sessions.get('synth-s');const token=fs.readFileSync(JSON.parse(fs.readFileSync(reg.manifestPath)).tokenFile,'utf8');
  const recovered=await(await fetch(restored.url+'/v1/bridge/claim',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({schemaVersion:1,requestId:'recover'})})).json();
  assert.equal(recovered.job,null);
  assert.equal(restored.snapshot().jobs[0].attemptId,job.attemptId);
  assert.throws(()=>restored.resume(job.jobId,false),/先确认/);
  restored.data.jobs[0].checkpoint={continuity:{completed:['synthetic first step complete'],remaining:['synthetic next step']}};
  restored.resume(job.jobId,true);
  const next=await(await fetch(restored.url+'/v1/bridge/claim',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({schemaVersion:1,requestId:'explicit-resume'})})).json();
  assert.equal(next.job.jobId,job.jobId);assert.notEqual(next.job.attemptId,job.attemptId);
  assert.deepEqual(restored.contextPacket(restored.data.jobs[0]).continuity.completed,['synthetic first step complete']);
});
test('ordinary chat stays separate from work; response and stop return to same request',async t=>{
  const {broker,call}=await setup(t);broker.enableChat('synth-s',true);
  const turn=broker.chat({targetAgentId:'synth-s',conversationId:'ds',requestId:'chat-one',currentText:'synthetic hello'});
  assert.equal((await call('claim',{})).job,null,'work-only consumer cannot execute chat');
  const {job}=await call('claim',{capabilities:{kinds:['chat']}});assert.equal(job.kind,'chat');
  assert.ok((await call('report',{...report(job),summary:'SYNTHETIC-CHAT-REPLY'})).ok);assert.equal(await turn.promise,'SYNTHETIC-CHAT-REPLY');assert.equal(broker.snapshot().feed.length,0);
  const cancelled=broker.chat({targetAgentId:'synth-s',conversationId:'ds',requestId:'chat-two',currentText:'synthetic stop'});const expected=assert.rejects(cancelled.promise,/已取消/);broker.cancel(cancelled.jobId);await expected;
});
test('Native client adapter runs against real public broker with controlled executor and real file',async t=>{
  const {broker,manifest,token,dir,work}=await setup(t);
  const root=path.join(__dirname,'..','connectors','reviewer','adapter');
  const {StateStore}=await import(pathToFileURL(path.join(root,'state.mjs')));
  const {runAdapter}=await import(pathToFileURL(path.join(root,'run-loop.mjs')));
  const dispatch=broker.dispatch({ticketId:'ticket',taskId:'task',requestId:'adapter-e2e'});const controller=new AbortController();
  const execute=async({finalInput,workspace})=>{assert.match(finalInput,/SYNTHETIC-PERSONA/);assert.doesNotMatch(finalInput,/OTHER-PRIVATE-CANARY/);const file=path.join(workspace,'s-real-broker.txt');fs.writeFileSync(file,'S-REAL-BROKER-OK');return{status:'completed',sessionId:'synthetic-session',summary:'synthetic adapter delivery',artifacts:[{path:file}]};};
  broker.notify=s=>{if(s.jobs.find(j=>j.jobId===dispatch.jobId)?.state==='review')controller.abort();};
  await runAdapter({manifest,token,state:new StateStore(path.join(dir,'adapter-state')),executor:{execute},log:()=>{},signal:controller.signal});
  assert.equal(fs.readFileSync(path.join(work,'s-real-broker.txt'),'utf8'),'S-REAL-BROKER-OK');assert.equal(broker.snapshot().jobs[0].state,'review');
});

test('authority changes are checked at report without waiting for heartbeat; reassigned attempt can acknowledge stop',async t=>{
  const {broker,data,call}=await setup(t);broker.dispatch({ticketId:'ticket',taskId:'task',requestId:'direct-change'});const {job}=await call('claim',{});
  data.messages.find(m=>m.id==='own').text='CORRECTED-CANARY';
  assert.equal((await call('report',report(job))).code,'stale_attempt');
  data.tickets[0].tasks[0].assigneeId='synth-l';
  assert.ok((await call('report',report(job,'cancelled'))).ok);
  assert.equal(broker.snapshot().jobs[0].state,'cancelled');
});
test('queued reassignment cannot leak a task to its previous owner',async t=>{
  const {broker,data,call}=await setup(t);broker.dispatch({ticketId:'ticket',taskId:'task',requestId:'queued-change'});
  data.tickets[0].tasks[0].assigneeId='synth-l';
  assert.equal((await call('claim',{})).code,'stale_attempt');
  assert.equal(broker.snapshot().jobs[0].state,'cancelled');
});
test('per-source receipts describe only selected text and fit the actual packet budget',async t=>{
  const {broker,data,call}=await setup(t);
  for(let i=0;i<90;i++)data.messages.push({id:'many-'+i,agentId:'agent_owner',conversationId:'ds',text:'OWN-CANARY 文件任务 '+String(i)+' '+'.'.repeat(280),createdAt:20+i,status:'sent',demo:false});
  broker.dispatch({ticketId:'ticket',taskId:'task',requestId:'budget'});const {job}=await call('claim',{});const {packet}=await call('context',{jobId:job.jobId,attemptId:job.attemptId});
  assert.ok(JSON.stringify(packet).length<13000);assert.ok(packet.memory.authorizedRelevantItems.length>0);
  for(let i=0;i<packet.memory.authorizedRelevantItems.length;i++){
    const item=packet.memory.authorizedRelevantItems[i],receipt=packet.memory.sourceReceipts[i];
    assert.equal(item.id,receipt.id);assert.equal(item.summary.length,receipt.injectedChars);
    assert.equal(receipt.payloadHash,require('node:crypto').createHash('sha256').update(item.summary).digest('hex'));
  }
  const {assembleFinalInput}=await import(pathToFileURL(path.join(__dirname,'..','connectors','reviewer','adapter','packet.mjs')));
  const {ContextValidator}=await import(pathToFileURL(path.join(__dirname,'..','connectors','antigravity','src','contextValidator.js')));
  assert.ok(assembleFinalInput(packet).finalInput.length<16000);
  assert.ok(ContextValidator.buildPrompt(packet).length<16000);
});
test('Worker adapter executes against real public broker with controlled runner and real artifact',async t=>{
  const {broker,data,dir,work}=await setup(t);
  data.tickets[0].tasks[0].assigneeId='synth-l';data.tickets[0].tasks[0].title='create a new l-real.txt';
  data.tickets[0].goal='create a new l-real.txt must contain L-REAL-BROKER-OK';
  const registration=broker.register({agentId:'synth-l',executorId:'antigravity-adapter',workspace:work});
  const manifest=JSON.parse(fs.readFileSync(registration.manifestPath,'utf8'));
  const {BrokerClient,CheckpointStore,DesktopAgentAdapter}=await import(pathToFileURL(path.join(__dirname,'..','connectors','antigravity','src','index.js')));
  const client=new BrokerClient({manifestPath:registration.manifestPath,agentId:'synth-l',executorId:manifest.executorId});client.setInjectedCredential(fs.readFileSync(manifest.tokenFile,'utf8'));
  const runner={defaultModel:'controlled',runTurn:async({prompt,workspaceDir,skipPermissions})=>{assert.match(prompt,/SYNTHETIC-L-PERSONA/);assert.equal(skipPermissions,false);fs.writeFileSync(path.join(workspaceDir,'l-real.txt'),'L-REAL-BROKER-OK');return{ok:true,response:'controlled success',conversationId:'controlled-l-session'};}};
  broker.dispatch({ticketId:'ticket',taskId:'task',requestId:'antigravity-real-public'});
  const adapter=new DesktopAgentAdapter({brokerClient:client,runner,checkpointStore:new CheckpointStore(path.join(dir,'l-state')),agentId:'synth-l',executorId:manifest.executorId});
  await adapter.runOnce();assert.equal(broker.snapshot().jobs[0].state,'review');assert.equal(broker.snapshot().jobs[0].report.artifacts[0].path,path.join(work,'l-real.txt'));
});

test('role-scoped coordinator MCP exposes actual work actions and delivered artifacts only',async t=>{
  const {broker,data,call,work}=await setup(t);data.agents.push({id:'agent_coordinator',name:'Synthetic coordinator',kind:'ai',systemPrompt:'Synthetic coordinator only'});
  const manifestPath=broker.issueCoordinator();assert.equal(broker.issueCoordinator(),manifestPath);
  assert.equal((await call('coordinator/snapshot',null)).code,'forbidden');
  const manifest=JSON.parse(fs.readFileSync(manifestPath,'utf8')),token=fs.readFileSync(manifest.tokenFile,'utf8');
  assert.equal((await call('session',null,{token})).code,'forbidden');
  const {spawn}=require('node:child_process'),rl=require('node:readline');
  const child=spawn(process.execPath,[path.join(__dirname,'..','connectors','coordinator.mjs'),'--manifest',manifestPath,'--mcp'],{windowsHide:true,stdio:['pipe','pipe','ignore']});
  t.after(()=>child.kill());let next=1;const pending=new Map();
  rl.createInterface({input:child.stdout}).on('line',line=>{const r=JSON.parse(line);pending.get(r.id)?.(r.result);pending.delete(r.id);});
  const rpc=(method,params)=>new Promise((resolve,reject)=>{const id=next++;const timer=setTimeout(()=>reject(new Error('MCP reply timeout')),5000);pending.set(id,r=>{clearTimeout(timer);resolve(r);});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});
  const invoke=async args=>{const r=await rpc('tools/call',{name:'xiaowu_workbench',arguments:args});return{...r,value:JSON.parse(r.content[0].text)};};
  assert.equal((await rpc('initialize',{protocolVersion:'2024-11-05'})).serverInfo.name,'xiaowu-workbench');assert.equal((await rpc('tools/list',{})).tools[0].name,'xiaowu_workbench');
  const snapshot=(await invoke({operation:'snapshot'})).value;assert.equal(snapshot.tickets[0].id,'ticket');assert.doesNotMatch(JSON.stringify(snapshot),/OTHER-PRIVATE-CANARY/);
  const denied=await rpc('tools/call',{name:'xiaowu_workbench',arguments:{operation:'dispatch',ticketId:'ticket',taskId:'task'}});assert.ok(denied.isError);assert.equal(broker.snapshot().jobs.length,0);
  assert.ok((await invoke({operation:'dispatch',explicit:true,ticketId:'ticket',taskId:'task',requestId:'coordinator-dispatch'})).value.ok);
  const {job}=await call('claim',{});const artifact=path.join(work,'audit.txt');fs.writeFileSync(artifact,'REAL-COORDINATOR-AUDIT');
  await call('report',{...report(job),artifacts:[{path:artifact}]});
  assert.equal((await invoke({operation:'artifact',jobId:job.jobId,path:artifact})).value.text,'REAL-COORDINATOR-AUDIT');
  assert.equal((await invoke({operation:'artifact',jobId:job.jobId,path:path.join(work,'not-delivered.txt')})).value.code,'forbidden');
  assert.ok((await invoke({operation:'accept',jobId:job.jobId,explicit:true})).value.ok);assert.equal(broker.snapshot().jobs[0].state,'done');
  child.stdin.end();
});
