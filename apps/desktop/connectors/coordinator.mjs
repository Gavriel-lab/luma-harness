// Public coordinator capability. No private chats, generic filesystem access,
// arbitrary URLs or shell execution. Credentials stay in the protected file.
import fs from 'node:fs';
import crypto from 'node:crypto';
import readline from 'node:readline';
const args=process.argv.slice(2),option=name=>args[args.indexOf(name)+1];
if(!args.includes('--manifest'))throw new Error('Explicit --manifest required');
const manifest=JSON.parse(fs.readFileSync(option('--manifest'),'utf8'));
const url=new URL(manifest.brokerUrl);
if(url.hostname!=='127.0.0.1'||url.protocol!=='http:'||manifest.executorId!=='xiaowu-coordinator')throw new Error('Invalid coordinator binding');
const token=fs.readFileSync(manifest.tokenFile,'utf8').trim();
async function execute(input){
  const operations=['snapshot','dispatch','cancel','accept','artifact','connect','create-ticket','reject-review'];
  if(!operations.includes(input.operation))throw new Error('Unknown operation');
  if(['dispatch','cancel','accept','connect','create-ticket','reject-review'].includes(input.operation)&&input.explicit!==true)throw new Error('Mutation requires an explicit decision and exact target; ordinary chat is not dispatch');
  const {operation,...body}=input;
  const response=await fetch(manifest.brokerUrl.replace(/\/$/,'')+'/v1/bridge/coordinator/'+operation,{method:operation==='snapshot'?'GET':'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:operation==='snapshot'?undefined:JSON.stringify({schemaVersion:1,requestId:input.requestId||crypto.randomUUID(),...body}),signal:AbortSignal.timeout(25000)});
  return response.json();
}
if(args.includes('--mcp')){
  const tool={name:'xiaowu_workbench',description:'Read authoritative work tickets, progress and submitted artifacts. Create bounded new work tickets (never replace existing tickets); return exact reviewed attempt/report with concrete findings, preserving evidence. Connect registered workers and dispatch authorized tasks. Ordinary @ and private memories never authorize work. Submitted means review; examine real artifacts and checks before accepting.',inputSchema:{type:'object',properties:{operation:{type:'string',enum:['snapshot','dispatch','cancel','accept','artifact','connect','create-ticket','reject-review']},agentId:{type:'string'},ticketId:{type:'string'},taskId:{type:'string'},jobId:{type:'string'},path:{type:'string'},requestId:{type:'string'},explicit:{type:'boolean'},title:{type:'string'},goal:{type:'string'},tasks:{type:'array',items:{type:'object',properties:{id:{type:'string'},title:{type:'string'},assigneeId:{type:'string'},acceptance:{type:'string'},execution:{type:'object'}},required:['id','title','assigneeId','acceptance'],additionalProperties:false}},attemptId:{type:'string'},reportId:{type:'string'},reason:{type:'string'},origin:{type:'object',properties:{requestId:{type:'string'},conversationId:{type:'string'},agentId:{type:'string'}},additionalProperties:false}},required:['operation'],additionalProperties:false}};
  const lines=readline.createInterface({input:process.stdin});
  const reply=(id,result)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\n');
  for await(const line of lines){
    let req;
    try{
      req=JSON.parse(line);if(req.id===undefined)continue;
      if(req.method==='initialize')reply(req.id,{protocolVersion:req.params?.protocolVersion||'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'xiaowu-workbench',version:'1.0.0'}});
      else if(req.method==='ping')reply(req.id,{});
      else if(req.method==='tools/list')reply(req.id,{tools:[tool]});
      else if(req.method==='tools/call'&&req.params?.name===tool.name){const result=await execute(req.params.arguments||{});reply(req.id,{content:[{type:'text',text:JSON.stringify(result)}],isError:!result.ok});}
      else process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:req.id,error:{code:-32601,message:'Unsupported method'}})+'\n');
    }catch(error){if(req?.id!==undefined)reply(req.id,{content:[{type:'text',text:error.message}],isError:true});}
  }
}else{
  if(!args.includes('--input'))throw new Error('Provide --input JSON, or use --mcp');
  const result=await execute(JSON.parse(option('--input')));console.log(JSON.stringify(result,null,2));if(!result.ok)process.exitCode=1;
}
