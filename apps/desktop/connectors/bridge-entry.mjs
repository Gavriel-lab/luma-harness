// Managed worker bootstrap. Manifest is public; session token never appears in argv/logs.
import fs from 'node:fs';
import path from 'node:path';
const index=process.argv.indexOf('--manifest');
if(index<0)throw new Error('Explicit manifest required');
const manifest=JSON.parse(fs.readFileSync(process.argv[index+1],'utf8'));
if(manifest.executorId==='opencode') {
  const { runOpenCodeBridge } = await import('./opencode/worker.mjs');
  await runOpenCodeBridge({manifestPath:process.argv[index+1]});
  process.exit(0);
}
if(manifest.executorId==='pi') {
  const { runPiBridge } = await import('./pi/worker.mjs');
  await runPiBridge({manifestPath:process.argv[index+1]});
  process.exit(0);
}
const token=fs.readFileSync(manifest.tokenFile,'utf8').trim();
const controller=new AbortController();
let stopWork=()=>{};
let activeChatPacket=null;
const stop=()=>{controller.abort();stopWork();if(activeChatPacket)chatCancel?.(activeChatPacket);};
process.on('SIGINT',stop);
process.on('SIGTERM',stop);
process.stdin.on('data',data=>{if(String(data).trim()==='stop')stop();});
const call=async(route,body)=>{
  const response=await fetch(manifest.bridgeUrl+'/v1/bridge/'+route,{method:body?'POST':'GET',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:body?JSON.stringify({schemaVersion:1,requestId:crypto.randomUUID(),...body}):undefined,signal:AbortSignal.timeout(15000)});
  return response.json();
};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let chatExecute,chatCancel;
let work;
if(manifest.executorId==='kiro'){
  const {KiroChatExecutor}=await import('./kiro/chat.mjs');
  const executor=new KiroChatExecutor({workspace:manifest.workspace,model:manifest.model||process.env.LUMA_KIRO_MODEL||''});
  const {KiroWorkRunner,runKiroWorkLoop}=await import('./kiro/work.mjs');
  const workRunner=new KiroWorkRunner({model:manifest.model||process.env.LUMA_KIRO_MODEL||''});
  work=runKiroWorkLoop({manifest,token,signal:controller.signal,runner:workRunner,stateDir:path.join(path.dirname(manifest.tokenFile),'kiro-state'),onStop:stop});
  stopWork=()=>{executor.cancel();workRunner.abort();};
  chatExecute=packet=>executor.execute(packet);
  chatCancel=()=>executor.cancel();
}else if(manifest.executorId==='zcode'){
  const {StateStore}=await import('./reviewer/adapter/state.mjs');
  const {runAdapter}=await import('./reviewer/adapter/run-loop.mjs');
  const {createZcodeExecutor}=await import('./reviewer/adapter/executor/zcode-app-server.mjs');
  const {assembleFinalInput}=await import('./reviewer/adapter/packet.mjs');
  const executor=createZcodeExecutor({mode:'build',modelChain:manifest.modelChain||[]});
  stopWork=()=>executor.abort();
  work=runAdapter({manifest,token,state:new StateStore(path.join(path.dirname(manifest.tokenFile),'work-state')),executor,signal:controller.signal,log:()=>{}});
  const chatExecutor=createZcodeExecutor({mode:'plan',modelChain:manifest.modelChain||[]});
  chatExecute=async(packet)=>{const r=await chatExecutor.execute({finalInput:assembleFinalInput(packet).finalInput,workspace:manifest.workspace,timeoutMs:120000});return {ok:r.status==='completed',response:r.finalText||r.summary,error:r.summary};};
  chatCancel=()=>chatExecutor.abort();
}else{
  const {BrokerClient,AntigravityRunner,CheckpointStore,DesktopAgentAdapter,ChatHandler}=await import('./desktop-agent/src/index.js');
  const brokerClient=new BrokerClient({manifestPath:process.argv[index+1],agentId:manifest.agentId,executorId:manifest.executorId});
  brokerClient.setInjectedCredential(token);
  const runner=new AntigravityRunner();
  const adapter=new DesktopAgentAdapter({brokerClient,runner,checkpointStore:new CheckpointStore(path.join(path.dirname(manifest.tokenFile),'work-state')),agentId:manifest.agentId,executorId:manifest.executorId});
  stopWork=()=>adapter.cancelCurrentJob();
  work=(async()=>{while(!controller.signal.aborted){try{await adapter.runOnce();}catch{}await sleep(1500);}})();
  const chatHandler=new ChatHandler({runner:new AntigravityRunner(),agentId:manifest.agentId,executorId:manifest.executorId});
  chatExecute=packet=>chatHandler.executeChatTurn({requestId:packet.job.taskId,conversationId:packet.job.ticketId,homeId:manifest.homeId,agentId:manifest.agentId,executorId:manifest.executorId,contextVersion:packet.contextVersion,authorizedContext:packet,input:packet.job.goal,attachments:packet.job.attachments,workspaceDir:manifest.workspace,mode:'chat'});
  chatCancel=packet=>chatHandler.cancelTurn(packet.job.taskId);
}
const chats=(async()=>{
  while(!controller.signal.aborted){
    let packet,job;
    try{
      const claim=await call('claim',{capabilities:{kinds:['chat']}});
      if(!claim.ok||!claim.job){await sleep(1500);continue;}
      job=claim.job;const context=await call('context',{jobId:job.jobId,attemptId:job.attemptId});
      if(!context.ok){await call('report',{jobId:job.jobId,attemptId:job.attemptId,reportId:'rep_'+job.attemptId,outcome:context.code==='stale_attempt'?'cancelled':'failed',summary:'未取得当前授权上下文，未启动聊天模型',artifacts:[],checks:[],checkpoint:null,unknowns:[]});await sleep(1500);continue;}packet=context.packet;activeChatPacket=packet;
      let cancelled=false;const heartbeat=setInterval(async()=>{try{const r=await call('heartbeat',{jobId:job.jobId,attemptId:job.attemptId});if(!r.ok){cancelled=true;chatCancel(packet);}}catch{}},5000);
      let result;
      try{
        const started=await call('events',{jobId:job.jobId,attemptId:job.attemptId,seq:1,type:'started',summary:'客户端正在回复本轮消息'});
        if(!started.ok)cancelled=true;
        else result=await chatExecute(packet);
      }catch(e){result={ok:false,error:e.message||'客户端回复异常'};}finally{clearInterval(heartbeat);activeChatPacket=null;}
      cancelled ||= controller.signal.aborted;
      await call('report',{jobId:job.jobId,attemptId:job.attemptId,reportId:'rep_'+job.attemptId,outcome:cancelled?'cancelled':result.ok?'submitted':'failed',summary:cancelled?'本轮回复已停止':result.ok?result.response:result.error||'客户端回复失败',artifacts:[],checks:[],checkpoint:null,unknowns:[]});
    }catch{if(packet)chatCancel(packet);activeChatPacket=null;await sleep(1500);}
  }
})();
await Promise.all([work,chats]);
process.stdin.destroy();
