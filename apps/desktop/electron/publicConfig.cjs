'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {DataStore}=require('./dataStore.cjs');
const {BridgeBroker}=require('./bridgeBroker.cjs');
const validId=v=>typeof v==='string'&&/^agent_[A-Za-z0-9_-]{1,100}$/.test(v);
function seed(config={}){
 const now=Date.now();
 const ai={id:'agent_coordinator',name:config.coordinatorName||'协调者',initial:'C',kind:'ai',connected:false,statusNote:'请配置 CLI 或 API',accent:'#666666',mode:'demo'};
 const agents=[{id:'agent_owner',name:config.ownerName||'使用者',initial:'U',kind:'human',connected:false,statusNote:'Owner',accent:'#444444'},ai];
 for(const input of config.members||[]){
  if(!validId(input.id)||input.id==='agent_owner')throw Error('Invalid member ID');
  if(input.kind&&input.kind!=='ai')throw Error('members may only contain AI members');
  const member={...ai,...input,kind:'ai',connected:false};
  const index=agents.findIndex(a=>a.id===member.id);
  if(index>=0){if(member.id!=='agent_coordinator')throw Error('Duplicate member ID');agents[index]=member;}
  else agents.push(member);
 }
 const profiles=(config.profiles||[]).map(p=>({...p,credentialRef:p.credentialRef||''}));
 if(new Set(profiles.map(p=>p.id)).size!==profiles.length)throw Error('Duplicate profile ID');
 for(const a of agents)if(a.profileId&&!profiles.some(p=>p.id===a.profileId))throw Error('Missing profile for '+a.id);
 return {version:1,preferences:{theme:'fusion',motion:false,scenic:false},agents,
 conversations:[{id:'conv_living_room',kind:'living-room',agentId:null,title:'群聊',createdAt:now},...agents.filter(a=>a.kind==='ai').map(a=>({id:'conv_dm_'+a.id.slice(6),kind:'direct',agentId:a.id,title:a.name,createdAt:now}))],
 messages:[],tickets:[],drafts:{},seeded:true,activeConversationId:'conv_dm_coordinator',activeTicketId:null,workbenchOpen:false,chatProfiles:profiles,memories:[],checkpoints:[]};
}
async function initialize({dataDir,config={},workspace}){
 fs.mkdirSync(dataDir,{recursive:true,mode:0o700});
 fs.mkdirSync(workspace,{recursive:true,mode:0o700});
 const store=new DataStore(dataDir,{memoryEngine:'manual'});
 const current=store.read();
 if(!current.ok||!['missing','ok'].includes(current.state))throw Error('Existing data is unreadable; preserve it before proceeding: '+current.reason);
 if(current.state==='missing'){const data=seed(config);for(const p of data.chatProfiles)if(p.providerType==='codex-app-server')p.codexCwd=p.codexCwd||workspace;
  const result=await store.write(JSON.stringify(data),1);if(!result.ok)throw Error('Initial data save failed: '+result.reason);}
 const bridgeDir=path.join(dataDir,'xiaowu-bridge');
 if(!fs.existsSync(path.join(bridgeDir,'bridge.v1.json')))new BridgeBroker({dir:bridgeDir,getData:()=>seed(config)});
 return {dataDir,homeId:JSON.parse(fs.readFileSync(path.join(bridgeDir,'bridge.v1.json'),'utf8')).homeId};
}
module.exports={seed,initialize};
