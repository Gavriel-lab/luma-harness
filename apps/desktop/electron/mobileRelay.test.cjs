'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {MobileRpc,MobileRelay}=require('./mobileRelay.cjs');
function fixture({save=true,route='native',attachmentsStore=null}={}) {
  const data={agents:[{id:'agent_owner',name:'owner',kind:'human'},{id:'a',name:'A',kind:'ai',mode:'real',profileId:'p'},{id:'b',name:'B',kind:'ai',mode:'real',profileId:'p'}],chatProfiles:[{id:'p',providerType:route==='demo'?'demo':'codex-app-server'}],conversations:[{id:'ca',kind:'direct',agentId:'a',title:'A',createdAt:1},{id:'cb',kind:'direct',agentId:'b',title:'B',createdAt:1}],messages:[]};
  let starts=0,emit,lastParams;
  const rpc=new MobileRpc({homeId:'home-test',getData:()=>data,getRegistrations:()=>route==='native'?{a:{chatEnabled:true}}:{},validateChat:()=>({ok:true}),attachmentsStore,mutate:async c=>{
    if(!save||(typeof save==='function'&&!save(c)))return {ok:false,reason:'disk unavailable'};
    if(c.type==='mobile-chat')data.messages.push(...c.messages);
    else {const m=data.messages.find(x=>x.id===c.messageId);if(m&&m.status==='streaming'){m.text=c.status&&typeof c.finalText==='string'?c.finalText:m.text+(c.delta||'');if(c.receipt)m.memoryReceipt=c.receipt;if(c.status){m.status=c.status;m.error=c.error;}}}
    return {ok:true};
  },startChat:async(params,sink)=>{starts++;lastParams=params;emit=(channel,more)=>sink(channel,{...params,...more});return {ok:true};}});
  return {data,rpc,get starts(){return starts;},get lastParams(){return lastParams;},emit:(...args)=>emit(...args)};
}
const post={requestId:'req_test',conversationId:'ca',targetAgentId:'a',text:'hello'};
test('phone deletes only the selected existing bubble, verifies persistence, and rejects save failure',async()=>{
 const f=fixture();f.data.messages.push({id:'split',conversationId:'ca',agentId:'a',text:'前面的话。\n\n💋\n\n后面的话。',createdAt:1,status:'sent',demo:false,requestId:null});
 let saves=0;f.rpc.mutate=async c=>{saves++;const m=f.data.messages.find(m=>m.id===c.messageId);m.hiddenReplyParts=[...new Set([...(m.hiddenReplyParts||[]),c.part])];return {ok:true,applied:true};};
 const body={conversationId:'ca',messageId:'split',mode:'hide',part:'💋'};
 assert.equal((await f.rpc.handle('delete-message',body)).status,200);
 const history=await f.rpc.handle('messages',{conversationId:'ca'});assert.equal(history.body.messages[0].content,'前面的话。\n\n💋\n\n后面的话。');assert.deepEqual(history.body.messages[0].hiddenReplyParts,['💋']);
 assert.equal((await f.rpc.handle('delete-message',{...body,part:'非原文'})).status,409);assert.equal(saves,1);
 assert.equal((await f.rpc.handle('delete-message',{...body,conversationId:'cb'})).status,404);
 f.rpc.mutate=async()=>({ok:false,applied:false,reason:'disk unavailable'});
 assert.equal((await f.rpc.handle('delete-message',{...body,part:'后面的话。'})).status,503);
 assert.deepEqual(f.data.messages[0].hiddenReplyParts,['💋']);
});
test('conversation previews use the same latest visible authoritative history and retain empty-conversation fallback',async()=>{
  const f=fixture();
  f.data.messages.push(...[
    {id:'old',createdAt:2,text:'older'},
    {id:'new-a',createdAt:3,text:'tie earlier'},
    {id:'new-z',createdAt:3,text:'🌷'.repeat(121)},
    {id:'pending',createdAt:4,text:'',status:'streaming'},
    {id:'demo',createdAt:5,text:'fake newest',demo:true},
    {id:'hidden',createdAt:6,text:'hidden newest',hiddenFromWindow:true},
  ].map(m=>({conversationId:'ca',agentId:'a',status:'sent',demo:false,requestId:null,...m})));
  const result=await f.rpc.handle('conversations',{});
  const a=result.body.conversations.find(c=>c.conversationId==='ca');
  const b=result.body.conversations.find(c=>c.conversationId==='cb');
  assert.equal(a.updatedAt,new Date(4).toISOString());assert.equal(a.lastMessage,'🌷'.repeat(120));
  assert.equal(b.updatedAt,new Date(1).toISOString());assert.equal(Object.hasOwn(b,'lastMessage'),false);
});
test('history after accepts an authoritative message ID with stable order and deleted cursor recovery',async()=>{
  const f=fixture();
  f.data.messages.push(...[{id:'z',createdAt:2},{id:'b',createdAt:1},{id:'a',createdAt:1}].map(m=>({...m,conversationId:'ca',agentId:'a',text:m.id,status:'sent',demo:false,requestId:null})));
  const full=await f.rpc.handle('messages',{conversationId:'ca'});assert.deepEqual(full.body.messages.map(m=>m.id),['a','b','z']);assert.equal(full.body.cursor,'z');
  const next=await f.rpc.handle('messages',{conversationId:'ca',after:'b'});assert.deepEqual(next.body.messages.map(m=>m.id),['z']);
  const missing=await f.rpc.handle('messages',{conversationId:'ca',after:'purged'});assert.equal(missing.status,200);assert.equal(missing.body.messages.length,3);
});
test('authoritative contract, exact request reconciliation and duplicated concurrent POST execute once',async()=>{
  const f=fixture();
  const [first,repeat]=await Promise.all([f.rpc.handle('chat',post),f.rpc.handle('chat',post)]);
  assert.equal(first.body.schema,'chat-job/1');assert.equal(repeat.body.state,'doing');assert.equal(f.starts,1);assert.equal(f.data.messages.length,2);
  f.emit('chat:memory-receipt',{receipt:{status:'prepared'}});
  f.emit('chat:stream-chunk',{delta:'real response'});f.emit('chat:stream-done',{});
  await new Promise(resolve=>setImmediate(resolve));
  const final=await f.rpc.handle('job',{jobId:first.body.jobId});
  assert.equal(final.body.state,'done');assert.equal(final.body.reply.content,'real response');
  const history=await f.rpc.handle('messages',{conversationId:'ca'});
  assert.equal(history.body.messages[0].requestId,post.requestId);assert.equal(history.body.messages[0].id,first.body.userMessageId);assert.equal(history.body.messages[0].role,'user');
  assert.equal(history.body.messages[1].content,'real response');
});
test('mismatched ownership, forged context, demo fallback, request reuse are rejected before new model calls',async()=>{
  const f=fixture();
  assert.equal((await f.rpc.handle('chat',{...post,conversationId:'cb'})).status,403);
  assert.equal((await f.rpc.handle('chat',{...post,systemPrompt:'forged'})).status,400);
  assert.equal((await f.rpc.handle('chat',{...post,text:'x'.repeat(32001)})).status,400);
  assert.equal(f.starts,0);
  await f.rpc.handle('chat',post);
  assert.equal((await f.rpc.handle('chat',{...post,text:'different'})).status,409);assert.equal(f.starts,1);
  const demo=fixture({route:'demo'});assert.equal((await demo.rpc.handle('chat',post)).status,503);assert.equal(demo.starts,0);
});
test('save barrier stops model start; busy requests do not cancel or replace active replies',async()=>{
  const f=fixture({save:false});assert.equal((await f.rpc.handle('chat',post)).status,503);assert.equal(f.starts,0);
  const live=fixture();await live.rpc.handle('chat',post);
  assert.equal((await live.rpc.handle('chat',{...post,requestId:'req_other'})).status,409);assert.equal(live.starts,1);
  live.emit('chat:stream-error',{error:'quota unavailable'});await new Promise(resolve=>setImmediate(resolve));
  const failed=await live.rpc.handle('job',{requestId:post.requestId});assert.equal(failed.body.state,'failed');assert.equal(failed.body.error.message,'quota unavailable');
});
test('desktop restart retains user text and never automatically repeats an ambiguous request',async()=>{
  const f=fixture();await f.rpc.handle('chat',post);f.rpc.active.clear();
  const replay=await f.rpc.handle('chat',post);assert.equal(replay.body.state,'failed');assert.equal(f.starts,1);
  await f.rpc.handle('chat',{...post,requestId:'req_new'});assert.equal(f.starts,2);assert.equal(f.data.messages[0].text,'hello');assert.equal(f.data.messages[1].status,'error');
});
test('terminal full buffer repairs a transient incremental save failure, terminal save failure cannot claim done',async()=>{
  const recovered=fixture({save:c=>!c.delta});await recovered.rpc.handle('chat',post);
  recovered.emit('chat:stream-chunk',{delta:'complete actual reply'});recovered.emit('chat:stream-done',{});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal((await recovered.rpc.handle('job',{requestId:post.requestId})).body.reply.content,'complete actual reply');
  const failed=fixture({save:c=>!c.status});await failed.rpc.handle('chat',post);failed.emit('chat:stream-chunk',{delta:'partial'});failed.emit('chat:stream-done',{});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal((await failed.rpc.handle('job',{requestId:post.requestId})).body.state,'failed');
});
test('mobile image attachments are imported into store, bound to user message and passed to native chat runner',async()=>{
  const importedList=[];
  const mockStore={
    importFile:async(file)=>{
      importedList.push(file);
      return {id:'att_test_1',name:file.name,type:'image',size:100,relativePath:'att_test_1.png',createdAt:Date.now()};
    }
  };
  const f=fixture({attachmentsStore:mockStore});
  const attPost={
    ...post,
    requestId:'req_att_1',
    attachments:[{name:'star.png',dataBase64:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='}]
  };
  const res=await f.rpc.handle('chat',attPost);
  assert.equal(res.status,200);
  assert.equal(f.starts,1);
  assert.equal(importedList.length,1);
  assert.equal(importedList[0].name,'star.png');
  assert.equal(f.lastParams.attachments?.length,1);
  assert.equal(f.lastParams.attachments[0].id,'att_test_1');
  assert.equal(f.data.messages[0].attachments?.length,1);
  assert.equal(f.data.messages[0].attachments[0].id,'att_test_1');

  // Test idempotent resend with same attachments succeeds
  const repeat=await f.rpc.handle('chat',attPost);
  assert.equal(repeat.status,200);

  // Test invalid attachments rejected
  assert.equal((await f.rpc.handle('chat',{...post,requestId:'req_bad1',attachments:'not_an_array'})).status,400);
  assert.equal((await f.rpc.handle('chat',{...post,requestId:'req_bad2',attachments:[1,2,3,4,5]})).status,400); // > 4
  assert.equal((await f.rpc.handle('chat',{...post,requestId:'req_bad3',attachments:[{name:123}]})).status,400);

  // Test missing store returns 503
  const noStoreFixture=fixture({attachmentsStore:null});
  const errRes=await noStoreFixture.rpc.handle('chat',attPost);
  assert.equal(errRes.status,503);
});

class StrictWhatwgFakeSocket {
  static latest;
  constructor() {
    StrictWhatwgFakeSocket.latest = this;
    this.handlers = {};
    this.sent = [];
    this.readyState = 1;
    this.closeCode = undefined;
    this.closeReason = undefined;
  }
  addEventListener(name, fn) { this.handlers[name] = fn; }
  send(raw) { this.sent.push(JSON.parse(raw)); }
  close(code = 1000, reason = '') {
    // Strictly validate against WHATWG standard WebSocket close code rule
    if (code !== 1000 && (code < 3000 || code > 4999)) {
      throw new DOMException('invalid code', 'InvalidAccessError');
    }
    this.closeCode = code;
    this.closeReason = reason;
    this.readyState = 3;
    this.handlers.close?.({ code, reason });
  }
}

test('a photo within the gateway 380KB allowance does not disconnect the shared relay or break the next text',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'luma-relay-photo-'));
  let relay;
  try {
    fs.writeFileSync(path.join(dir,'token.txt'),'c'.repeat(64));
    fs.writeFileSync(path.join(dir,'config.json'),JSON.stringify({homeId:'home-test',endpoint:'wss://luma-relay.example-owner.workers.dev/internal/relay',tokenFile:path.join(dir,'token.txt')}));
    const f=fixture({attachmentsStore:{importFile:async file=>({id:'photo',name:file.name,type:'image',relativePath:'photo.jpg'})}});
    relay=new MobileRelay({dir,homeId:'home-test',rpc:f.rpc,WebSocketImpl:StrictWhatwgFakeSocket});relay.start();
    const socket=StrictWhatwgFakeSocket.latest;socket.handlers.open();
    await socket.handlers.message({data:JSON.stringify({type:'ready'})});
    const payload={...post,attachments:[{name:'flower.jpg',dataBase64:'a'.repeat(300000)}]};
    await socket.handlers.message({data:JSON.stringify({type:'request',id:'photo-request',operation:'chat',payload})});
    assert.equal(socket.readyState,1,'valid photo must not close every phone RPC');
    assert.equal(socket.sent.find(s=>s.id==='photo-request')?.status,200);
    assert.equal(f.lastParams.attachments[0].name,'flower.jpg');
    f.emit('chat:stream-done',{});await new Promise(resolve=>setImmediate(resolve));
    await socket.handlers.message({data:JSON.stringify({type:'request',id:'oversize-request',operation:'chat',payload:{...post,attachments:[{name:'too-large.jpg',dataBase64:'a'.repeat(380000)}]}})});
    assert.equal(socket.sent.find(s=>s.id==='oversize-request')?.status,400);
    assert.equal(socket.readyState,1,'reject a large payload without disconnecting other calls');
    await socket.handlers.message({data:JSON.stringify({type:'request',id:'text-request',operation:'chat',payload:{...post,requestId:'next-text'}})});
    assert.equal(socket.sent.find(s=>s.id==='text-request')?.status,200);
    assert.equal(f.starts,2);
  }finally{relay?.stop();fs.rmSync(dir,{recursive:true,force:true});}
});

test('a native startup failure after admission is persisted and visible through job polling',async()=>{
  const f=fixture();f.rpc.startChat=async()=>{throw Error('native client unavailable');};
  const admitted=await f.rpc.handle('chat',post);assert.equal(admitted.status,200);
  await new Promise(resolve=>setImmediate(resolve));
  const status=await f.rpc.handle('job',{requestId:post.requestId});
  assert.equal(status.body.state,'failed');assert.equal(status.body.error.message,'native client unavailable');
  assert.equal(f.data.messages[0].text,post.text);assert.equal(f.rpc.active.size,0);
});

test('durably admitted chat returns while the native CLI is still starting; retry starts it only once',async()=>{
  const f=fixture();let release,starts=0;
  f.rpc.startChat=()=>{starts++;return new Promise(resolve=>{release=resolve;});};
  let timer;
  try {
    const response=await Promise.race([f.rpc.handle('chat',post),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('admission blocked on CLI startup')),100);})]);
    assert.equal(response.status,200);assert.equal(response.body.state,'doing');
    assert.equal(f.data.messages.length,2);assert.equal(starts,1);
    assert.equal((await f.rpc.handle('chat',post)).body.jobId,response.body.jobId);
    assert.equal(starts,1);
  }finally{clearTimeout(timer);release?.({ok:true});}
});

test('outbound relay authenticates first and returns the desktop contract without leaking credentials into payloads',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'luma-relay-test-'));
  const secret='a'.repeat(64);
  try {
    fs.writeFileSync(path.join(dir,'token.txt'),secret);
    fs.writeFileSync(path.join(dir,'config.json'),JSON.stringify({homeId:'home-test',endpoint:'wss://luma-relay.example-owner.workers.dev/internal/relay',tokenFile:path.join(dir,'token.txt')}));
    const f=fixture();const relay=new MobileRelay({dir,homeId:'home-test',rpc:f.rpc,WebSocketImpl:StrictWhatwgFakeSocket});assert.equal(relay.start(),true);
    const socket=StrictWhatwgFakeSocket.latest;socket.handlers.open();assert.equal(socket.sent[0].type,'auth');assert.equal(socket.sent[0].token,secret);
    await socket.handlers.message({data:JSON.stringify({type:'ready'})});
    await socket.handlers.message({data:JSON.stringify({type:'request',id:'request1',operation:'members',payload:{}})});
    assert.equal(socket.sent[1].body.schema,'members/1');assert.equal(JSON.stringify(socket.sent[1]).includes(secret),false);relay.stop();
    fs.writeFileSync(path.join(dir,'config.json'),JSON.stringify({homeId:'other',endpoint:'wss://luma-relay.example-owner.workers.dev/internal/relay',tokenFile:path.join(dir,'token.txt')}));
    const invalid=new MobileRelay({dir,homeId:'home-test',rpc:f.rpc,WebSocketImpl:StrictWhatwgFakeSocket});assert.throws(()=>invalid.config(),/家庭身份/);invalid.stop();
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('relay keeps connection on pong and survives multiple heartbeat intervals without dispatching RPC or crashing',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'luma-relay-heartbeat-'));
  const secret='b'.repeat(64);
  try {
    fs.writeFileSync(path.join(dir,'token.txt'),secret);
    fs.writeFileSync(path.join(dir,'config.json'),JSON.stringify({homeId:'home-test',endpoint:'wss://luma-relay.example-owner.workers.dev/internal/relay',tokenFile:path.join(dir,'token.txt')}));
    let rpcCalls=0;
    const dummyRpc={handle:async()=>{rpcCalls++;return {status:200,body:{}};}};
    let currentStatus='init';
    const relay=new MobileRelay({dir,homeId:'home-test',rpc:dummyRpc,WebSocketImpl:StrictWhatwgFakeSocket,onStatus:(s)=>currentStatus=s});
    relay.start();
    const socket=StrictWhatwgFakeSocket.latest;
    socket.handlers.open();
    assert.equal(socket.sent[0].type,'auth');
    await socket.handlers.message({data:JSON.stringify({type:'ready'})});
    assert.equal(relay.ready,true);
    assert.equal(currentStatus,'ready');

    // Simulate 1st heartbeat interval: server sends pong
    await socket.handlers.message({data:JSON.stringify({type:'pong'})});
    assert.equal(relay.ready,true);
    assert.equal(socket.readyState,1);
    assert.equal(rpcCalls,0);

    // Simulate 2nd heartbeat interval: server sends pong again
    await socket.handlers.message({data:JSON.stringify({type:'pong'})});
    assert.equal(relay.ready,true);
    assert.equal(socket.readyState,1);
    assert.equal(rpcCalls,0);

    // Client also responds to incoming server ping with pong
    await socket.handlers.message({data:JSON.stringify({type:'ping'})});
    assert.equal(socket.sent.some(s=>s.type==='pong'),true);
    assert.equal(relay.ready,true);
    assert.equal(rpcCalls,0);

    relay.stop();
    assert.equal(socket.readyState,3);
    assert.equal(socket.closeCode,1000);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('malformed frames and invalid request codes close with compliant WHATWG codes (4008/4009) without throwing InvalidAccessError',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'luma-relay-malformed-'));
  const secret='c'.repeat(64);
  try {
    fs.writeFileSync(path.join(dir,'token.txt'),secret);
    fs.writeFileSync(path.join(dir,'config.json'),JSON.stringify({homeId:'home-test',endpoint:'wss://luma-relay.example-owner.workers.dev/internal/relay',tokenFile:path.join(dir,'token.txt')}));
    
    // Test 1: frame too large -> 4009
    {
      const relay=new MobileRelay({dir,homeId:'home-test',rpc:{},WebSocketImpl:StrictWhatwgFakeSocket});
      relay.start();
      const socket=StrictWhatwgFakeSocket.latest;
      socket.handlers.open();
      await socket.handlers.message({data:'x'.repeat(384*1024 + 1)});
      assert.equal(socket.closeCode,4009);
      assert.equal(socket.closeReason,'frame_too_large');
      relay.stop();
    }

    // Test 2: bad JSON -> 4008
    {
      const relay=new MobileRelay({dir,homeId:'home-test',rpc:{},WebSocketImpl:StrictWhatwgFakeSocket});
      relay.start();
      const socket=StrictWhatwgFakeSocket.latest;
      socket.handlers.open();
      await socket.handlers.message({data:'{invalid json'});
      assert.equal(socket.closeCode,4008);
      assert.equal(socket.closeReason,'invalid_json');
      relay.stop();
    }

    // Test 3: JSON null -> 4008 without throwing TypeError on frame.type
    {
      const relay=new MobileRelay({dir,homeId:'home-test',rpc:{},WebSocketImpl:StrictWhatwgFakeSocket});
      relay.start();
      const socket=StrictWhatwgFakeSocket.latest;
      socket.handlers.open();
      await socket.handlers.message({data:'null'});
      assert.equal(socket.closeCode,4008);
      assert.equal(socket.closeReason,'invalid_frame_object');
      relay.stop();
    }

    // Test 4: unauthenticated request before ready -> 4008
    {
      const relay=new MobileRelay({dir,homeId:'home-test',rpc:{},WebSocketImpl:StrictWhatwgFakeSocket});
      relay.start();
      const socket=StrictWhatwgFakeSocket.latest;
      socket.handlers.open();
      await socket.handlers.message({data:JSON.stringify({type:'request',id:'req1',operation:'members'})});
      assert.equal(socket.closeCode,4008);
      assert.equal(socket.closeReason,'unauthorized_frame');
      relay.stop();
    }

    // Test 5: invalid request id or missing id after ready -> 4008
    {
      const relay=new MobileRelay({dir,homeId:'home-test',rpc:{},WebSocketImpl:StrictWhatwgFakeSocket});
      relay.start();
      const socket=StrictWhatwgFakeSocket.latest;
      socket.handlers.open();
      await socket.handlers.message({data:JSON.stringify({type:'ready'})});
      await socket.handlers.message({data:JSON.stringify({type:'request',id:'',operation:'members'})});
      assert.equal(socket.closeCode,4008);
      assert.equal(socket.closeReason,'invalid_request');
      relay.stop();
    }
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('workbench-snapshot formats tickets and work jobs correctly, sanitizes paths and leaks no secret fields', async () => {
  const f = fixture();
  // 1. When no tickets exist, returns tickets: []
  f.data.tickets = [];
  const emptyRes = await f.rpc.handle('workbench-snapshot', {});
  assert.equal(emptyRes.status, 200);
  assert.equal(emptyRes.body.schema, 'workbench-snapshot/1');
  assert.equal(typeof emptyRes.body.generatedAt, 'number');
  assert.deepEqual(emptyRes.body.tickets, []);

  // 2. Reject payload with parameters (read-only GET without arguments)
  const invalidRes = await f.rpc.handle('workbench-snapshot', { extra: 'arg' });
  assert.equal(invalidRes.status, 400);

  // 3. With real ticket, tasks, and mock bridge broker jobs
  const mockBroker = {
    data: {
      jobs: [
        {
          jobId: 'job_chat_1',
          kind: 'chat',
          ticketId: 'ticket_1',
          taskId: 'task_1',
          state: 'doing',
          events: [{ type: 'progress', summary: 'chat event' }]
        },
        {
          jobId: 'job_work_1',
          kind: 'work',
          ticketId: 'ticket_1',
          taskId: 'task_1',
          agentId: 'a',
          workspace: process.cwd(),
          scope: 'scope_secret',
          manifestPath: process.cwd(),
          token: 'token_secret_123',
          requestId: 'req_internal_456',
          attemptId: 'attempt_789',
          payloadHash: 'hash_abc',
          coordinatorCreation: { secret: true },
          state: 'doing',
          createdAt: 1760680000000,
          events: [
            { seq: 1, type: 'started', summary: '在 D:\\workspace\\superpowers\\file.txt 开始工作', createdAt: 1760680001000 },
            { seq: 2, type: 'blocked', summary: '卡住了，需要权限', createdAt: 1760680002000 }
          ],
          report: {
            reportId: 'rep_1',
            summary: '在 C:/Users/example-user/AppData/Local/temp/output.log 完成交付报告',
            artifacts: [{ path: process.cwd() }],
            checks: []
          },
          reviewDecision: null
        }
      ]
    }
  };

  f.rpc.bridgeBroker = mockBroker;
  f.data.tickets = [
    {
      id: 'ticket_1',
      title: '工单：桌面排查 D:\\workspace\\log.txt',
      goal: '目标：修复 C:/Users/example-user/file.txt 路径',
      updatedAt: 1760680000000,
      participantIds: ['a', 'b'],
      discussion: { text: '讨论在 D:\\workspace\\notes.md 展开', updatedAt: 1760680000000 },
      artifacts: { text: '成果保存在 C:\\out\\result.md', updatedAt: 1760680000000 },
      tasks: [
        {
          id: 'task_1',
          title: '排查 D:\\path\\code.ts',
          status: 'doing',
          assigneeId: 'a',
          acceptance: '标准在 C:\\rules.txt'
        }
      ]
    }
  ];

  const beforeDataStr = JSON.stringify(f.data);
  const beforeBrokerStr = JSON.stringify(mockBroker.data);

  const res = await f.rpc.handle('workbench-snapshot', {});
  assert.equal(res.status, 200);
  assert.equal(res.body.schema, 'workbench-snapshot/1');
  assert.equal(res.body.tickets.length, 1);

  const t = res.body.tickets[0];
  assert.equal(t.id, 'ticket_1');
  assert.equal(t.title, '工单：桌面排查 （本机路径）');
  assert.equal(t.goal, '目标：修复 （本机路径） 路径');
  assert.equal(t.discussion, '讨论在 （本机路径） 展开');
  assert.equal(t.artifacts, '成果保存在 （本机路径）');
  assert.deepEqual(t.participantIds, ['a', 'b']);
  assert.equal(t.tasks.length, 1);

  const task = t.tasks[0];
  assert.equal(task.id, 'task_1');
  assert.equal(task.title, '排查 （本机路径）');
  assert.equal(task.status, 'doing');
  assert.equal(task.assigneeId, 'a');
  assert.equal(task.acceptance, '标准在 （本机路径）');
  assert.equal(task.jobState, 'doing');

  // progress checks
  assert.equal(task.progress.length, 2);
  assert.equal(task.progress[0].kind, 'progress');
  assert.equal(task.progress[0].text, '在 （本机路径） 开始工作');
  assert.equal(task.progress[0].agentId, 'a');
  assert.equal(task.progress[1].kind, 'blocked');
  assert.equal(task.progress[1].text, '卡住了，需要权限');

  // report check
  assert.ok(task.report);
  assert.equal(task.report.text, '在 （本机路径） 完成交付报告');

  // review check (null when no review)
  assert.equal(task.review, null);

  // Check secret fields: ensure none of them appear in JSON string
  const jsonStr = JSON.stringify(res.body);
  const forbidden = [
    process.cwd(), process.cwd(), 'token_secret_123',
    'req_internal_456', 'attempt_789', 'hash_abc', 'coordinatorCreation',
    'scope_secret', 'job_chat_1', 'chat event'
  ];
  for (const word of forbidden) {
    assert.ok(!jsonStr.includes(word), `Secret field or chat job leaked: ${word}`);
  }

  // 手机只能读：这个操作不改任何数据
  assert.equal(JSON.stringify(f.data), beforeDataStr);
  assert.equal(JSON.stringify(mockBroker.data), beforeBrokerStr);
});


test('书房：手机端能读到桌面写的书（studyService 必须传进 MobileRpc）',async()=>{
  const {StudyService}=require('./studyService.cjs');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'luma-study-rpc-'));
  const studyService=new StudyService({userDataDir:dir});
  const book=studyService.createBook({title:'桌面开的书',motif:'测试',firstSectionText:'桌面写的第一段',authorName:'使用者'});
  const rpc=new MobileRpc({homeId:'h',getData:()=>({agents:[{id:'agent_owner'}]}),getRegistrations:()=>({}),studyService});
  const list=await rpc.handle('study-books',{});
  assert.equal(list.status,200);
  assert.equal(list.body.books.length,1);
  assert.equal(list.body.books[0].title,'桌面开的书');
  const full=await rpc.handle('study-book',{bookId:book.id});
  assert.equal(full.status,200);
  assert.equal(full.body.book.sections[0].text,'桌面写的第一段');
  fs.rmSync(dir,{recursive:true,force:true});
});
