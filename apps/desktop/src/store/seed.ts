import {STORAGE_VERSION,DEFAULT_READING_PREFERENCES,type AppData,type Agent,type ChatProfile} from '../types';
// Only protocol roles are preconfigured. Add/remove any number of workers in member settings.
export const AGENTS: Agent[] = [
 {id:'agent_owner',name:'使用者',initial:'U',kind:'human',connected:false,statusNote:'Owner',accent:'#444444'},
 {id:'agent_coordinator',name:'协调者',initial:'C',kind:'ai',connected:false,statusNote:'请配置 CLI 或 API',accent:'#666666',mode:'demo'},
];
export function buildEmpty():AppData {
 const now=Date.now();
 return {version:STORAGE_VERSION,preferences:{theme:'fusion',motion:false,scenic:false,reading:{...DEFAULT_READING_PREFERENCES}},
 agents:AGENTS.map(a=>({...a})),conversations:[{id:'conv_living_room',kind:'living-room',agentId:null,title:'群聊',createdAt:now},
 {id:'conv_dm_coordinator',kind:'direct',agentId:'agent_coordinator',title:'协调者',createdAt:now}],
 messages:[],tickets:[],drafts:{},seeded:true,activeConversationId:'conv_dm_coordinator',activeTicketId:null,
 workbenchOpen:false,chatProfiles:[] as ChatProfile[],memories:[],checkpoints:[]};
}
export function buildSeed():AppData{return buildEmpty();}
