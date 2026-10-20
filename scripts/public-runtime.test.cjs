const test=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs');const path=require('node:path');const os=require('node:os');
const {seed,initialize}=require('../apps/desktop/electron/publicConfig.cjs');
const {DataStore}=require('../apps/desktop/electron/dataStore.cjs');
const {ExternalMemoryMemory}=require('../apps/desktop/electron/externalMemoryMemory.cjs');
const {startLocalMobile}=require('../apps/desktop/electron/localMobile.cjs');
const {nextWake,due}=require('../apps/desktop/electron/activitySchedule.cjs');
test('activity intervals respect day/night, overnight hours, invalid ranges and due time',()=>{
 const old=process.env.LUMA_TIME_ZONE;process.env.LUMA_TIME_ZONE='UTC';
 try{const config={dayHours:[20,6],dayMinutes:[10,20],nightMinutes:[60,80]};
  const evening=Date.UTC(2026,0,1,22),noon=Date.UTC(2026,0,1,12);
  assert.equal(nextWake(config,evening,()=>0),evening+10*60000);
  assert.equal(nextWake(config,noon,()=>1),noon+80*60000);
  assert.equal(due(evening,evening-1),false);assert.equal(due(evening,evening),true);
  assert.throws(()=>nextWake({...config,dayMinutes:[20,10]},evening),/Invalid/);
 }finally{if(old===undefined)delete process.env.LUMA_TIME_ZONE;else process.env.LUMA_TIME_ZONE=old;}
});
test('configurable workers have no roster limit and duplicate IDs fail',()=>{
 const data=seed({members:Array.from({length:17},(_,i)=>({id:'agent_custom_'+i,name:'Worker '+i}))});
 assert.equal(data.agents.filter(a=>a.kind==='ai').length,18);
 assert.equal(data.messages.length,0);assert.equal(data.memories.length,0);
 assert.throws(()=>seed({members:[{id:'agent_custom',name:'One'},{id:'agent_custom',name:'Two'}]}),/Duplicate/);
});
test('first start saves blank configuration and later starts preserve data',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'luma-public-config-')),dataDir=path.join(dir,'data');
 const workspace=path.join(dir,'work');
 await initialize({dataDir,config:{ownerName:'Example Owner'},workspace});
 const store=new DataStore(dataDir),before=store.read();assert.equal(before.state,'ok');
 await store.modify(data=>{data.messages.push({id:'saved',conversationId:'conv_dm_coordinator',agentId:'agent_owner',text:'preserved',createdAt:Date.now(),status:'sent',demo:false,requestId:null});});
 await initialize({dataDir,config:{ownerName:'Changed'},workspace});
 const after=JSON.parse(store.read().raw);assert.equal(after.agents[0].name,'Example Owner');assert.equal(after.messages[0].text,'preserved');
 fs.writeFileSync(store.file,'BROKEN');
 await assert.rejects(initialize({dataDir,config:{},workspace}),/unreadable/);
 assert.equal(fs.readFileSync(store.file,'utf8'),'BROKEN');
});
test('no memory provider performs no external calls or imaginary retrieval',async()=>{
 const old=process.env.LUMA_MEMORY_PLUGIN;delete process.env.LUMA_MEMORY_PLUGIN;
 try{const memory=new ExternalMemoryMemory({});await memory.start();const result=await memory.prepare({});assert.deepEqual(result.memoryIds,[]);assert.equal(memory.state.state,'disabled');assert.deepEqual(await memory.continuity({}),[]);}finally{if(old!==undefined)process.env.LUMA_MEMORY_PLUGIN=old;}
});
test('local mobile adapter authenticates and rejects remote origin and path traversal',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'luma-public-local-')),assets=path.join(dir,'assets');fs.mkdirSync(assets);fs.writeFileSync(path.join(assets,'index.html'),'LOCAL_MOBILE_INDEX');
 const calls=[];const server=await startLocalMobile({rpc:{async handle(operation,payload){calls.push({operation,payload});return {status:200,body:{members:[]}};}},dataDir:dir,port:0,assetsDir:assets,routeModule:path.resolve(__dirname,'../services/gateway/mobile-api.mjs'),announce:false});
 t.after(()=>server.close());
 const {url,port}=JSON.parse(fs.readFileSync(path.join(dir,'local-mobile/connection.json'))),base='http://127.0.0.1:'+port;
 assert.equal((await fetch(base+'/api/members')).status,401);
 const pair=await fetch(url,{redirect:'manual'});assert.equal(pair.status,303);const cookie=pair.headers.get('set-cookie').split(';')[0];
 assert.equal(await(await fetch(base,{headers:{cookie}})).text(),'LOCAL_MOBILE_INDEX');
 assert.equal((await fetch(base+'/api/members',{headers:{cookie}})).status,200);assert.equal(calls[0].operation,'members');
 assert.equal((await fetch(base+'/api/chat',{method:'POST',headers:{cookie,origin:'https://untrusted.invalid'},body:'{}'})).status,403);
 const status=await new Promise((resolve,reject)=>{require('node:http').get(base+'/api/members',{headers:{cookie,host:'untrusted.invalid'}},r=>{r.resume();resolve(r.statusCode);}).on('error',reject);});
 assert.equal(status,403);
 assert.equal((await fetch(base+'/%2e%2e%2fsecret',{headers:{cookie}})).status,403);
});
