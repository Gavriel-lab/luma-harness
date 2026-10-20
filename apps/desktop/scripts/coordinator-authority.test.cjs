const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {BridgeBroker}=require('../electron/bridgeBroker.cjs');
const {DataStore}=require('../electron/dataStore.cjs');
async function setup(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'luma-coordination-')),work=path.join(dir,'work');fs.mkdirSync(work);
 const data={version:1,agents:[{id:'agent_owner',name:'Synthetic owner',initial:'Z',kind:'human',connected:true,accent:'#fff',statusNote:''},{id:'agent_coordinator',name:'Synthetic coordinator',initial:'G',kind:'ai',connected:true,accent:'#fff',statusNote:'',systemPrompt:'SYNTHETIC coordinator'},{id:'agent_worker',name:'Synthetic worker',initial:'W',kind:'ai',connected:true,accent:'#fff',statusNote:'',systemPrompt:'SYNTHETIC worker'}],conversations:[{id:'conv_living_room',title:'Synthetic',kind:'living-room',agentId:null,createdAt:1}],activeConversationId:'conv_living_room',messages:[{id:'private-canary',conversationId:'conv_living_room',agentId:'agent_owner',text:'Preserve existing original',createdAt:1,status:'sent',demo:false,requestId:null}],tickets:[],preferences:{theme:'day'},memories:[],checkpoints:[]};
 const store=new DataStore(dir);store.beginSession('test');let revision=0;assert.equal((await store.save(JSON.stringify(data),++revision,'test')).applied,true);
 const read=()=>JSON.parse(store.read().raw);
 const mutation=async c=>{const d=read();if(c.operation==='create-ticket')d.tickets.push(c.ticket);else{const ticket=d.tickets.find(t=>t.id===c.ticketId);ticket.tasks.find(t=>t.id===c.taskId).status='todo';ticket.reviewDecisions=[...(ticket.reviewDecisions||[]),{...c.decision,jobId:c.jobId,taskId:c.taskId}];ticket.discussion.text+='\n'+c.decision.reason;}return store.save(JSON.stringify(d),++revision,'test');};
 const broker=new BridgeBroker({dir:path.join(dir,'broker'),getData:read,mutateTickets:mutation});await broker.start();t.after(()=>broker.stop());
 const reg=broker.register({agentId:'agent_worker',executorId:'zcode',workspace:work});
 const workerToken=fs.readFileSync(JSON.parse(fs.readFileSync(reg.manifestPath)).tokenFile,'utf8');
 const coordinatorToken=fs.readFileSync(JSON.parse(fs.readFileSync(broker.issueCoordinator())).tokenFile,'utf8');
 const call=async(route,body,token=coordinatorToken)=>(await fetch(broker.url+'/v1/bridge/'+route,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({schemaVersion:1,explicit:true,...body})})).json();
 const create={requestId:'create-one',ticketId:'ticket_one',title:'Synthetic repair',goal:'Fix only synthetic defect',tasks:[{id:'task_one',title:'Repair and submit',assigneeId:'agent_worker',acceptance:'Produce real evidence'}]};
 return {broker,store,read,call,create,workerToken,work};
}
test('coordinator-only create persists to actual DataStore and cannot replace authority',async t=>{
 const {broker,read,call,create,workerToken}=await setup(t);
 assert.equal((await call('coordinator/create-ticket',create,workerToken)).code,'forbidden');
 assert.equal((await call('coordinator/create-ticket',{...create,explicit:false})).code,'permission_required');
 assert.equal((await call('coordinator/create-ticket',{...create,participantIds:['evil']})).code,'forbidden');
 assert.equal((await call('coordinator/create-ticket',create)).ok,true);
 assert.equal(read().tickets[0].tasks[0].assigneeId,'agent_worker');assert.deepEqual(read().tickets[0].participantIds,['agent_coordinator','agent_worker']);
 assert.equal(read().messages[0].text,'Preserve existing original');assert.equal(read().agents[2].systemPrompt,'SYNTHETIC worker');
 assert.equal((await call('coordinator/create-ticket',create)).duplicate,true);
 assert.equal((await call('coordinator/create-ticket',{...create,goal:'changed'})).code,'forbidden');assert.equal(read().tickets.length,1);
 assert.equal((await call('coordinator/create-ticket',{...create,ticketId:'ticket_two',requestId:'create-two'})).code,'forbidden');
 assert.equal(broker.data.jobs.length,0,'create never executes or marks acceptance');
});
test('review rejection retains report/artifacts/attempt and enables a new distinct job',async t=>{
 const {broker,call,create,workerToken,read,work}=await setup(t);await call('coordinator/create-ticket',create);
 const dispatch=broker.dispatch({ticketId:create.ticketId,taskId:'task_one',requestId:'dispatch-one'});
 const {job}=await call('claim',{requestId:'claim'},workerToken);
 const reject={requestId:'reject-one',jobId:dispatch.jobId,attemptId:job.attemptId,reportId:'report-one',reason:'Synthetic regression reproduced; fix before acceptance'};
 assert.equal((await call('coordinator/reject-review',reject)).code,'permission_required','doing cannot be returned');
 const artifact=path.join(work,'evidence.md');fs.writeFileSync(artifact,'Synthetic proof');
 const report={jobId:job.jobId,attemptId:job.attemptId,requestId:'report',reportId:'report-one',outcome:'submitted',summary:'Synthetic delivery',artifacts:[{path:artifact}],checks:[],unknowns:['real mobile pending'],checkpoint:null};
 assert.equal((await call('report',report,workerToken)).ok,true);
 assert.equal((await call('coordinator/reject-review',{...reject,attemptId:'old'})).code,'stale_attempt');
 assert.equal((await call('coordinator/reject-review',reject)).ok,true);
 const old=broker.data.jobs[0];assert.equal(old.state,'rejected');assert.equal(old.attemptId,job.attemptId);assert.equal(old.report.reportId,'report-one');assert.equal(old.report.artifacts[0].path,artifact);assert.deepEqual(old.report.unknowns,['real mobile pending']);
 assert.equal(read().tickets[0].tasks[0].status,'todo');assert.match(read().tickets[0].discussion.text,/regression reproduced/);
 assert.equal((await call('coordinator/reject-review',reject)).duplicate,true);
 assert.equal((await call('coordinator/reject-review',{...reject,reason:'different'})).code,'forbidden');
 const next=broker.dispatch({ticketId:create.ticketId,taskId:'task_one',requestId:'dispatch-two'});assert.notEqual(next.jobId,old.jobId);assert.equal(old.report.reportId,'report-one');
});
test('missing or failed authoritative writer never reports new tickets or rejects review',async t=>{
 const {broker,call,create,read}=await setup(t);broker.mutateTickets=null;
 assert.equal((await call('coordinator/create-ticket',create)).code,'executor_unavailable');assert.equal(read().tickets.length,0);
 broker.mutateTickets=async()=>({ok:false,applied:false,reason:'Synthetic disk failure'});
 assert.equal((await call('coordinator/create-ticket',create)).code,'executor_unavailable');assert.equal(read().tickets.length,0);assert.equal(broker.pendingTicketMutations.size,0);
});
