import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {BrokerClient} from '../reviewer/adapter/broker.mjs';
import {verifyBinding} from '../reviewer/adapter/binding.mjs';
import {assembleFinalInput} from '../reviewer/adapter/packet.mjs';
import {OpenCodeRunner} from './runner.mjs';

// The journal is written BEFORE a model starts and BEFORE reports are sent.
// A crashed attempt requires explicit redispatch, never automatic replay.
export class AttemptJournal {
  constructor(directory) {this.directory=directory;fs.mkdirSync(directory,{recursive:true});}
  file(job) {return path.join(this.directory,createHash('sha256').update(job.jobId+'\0'+job.attemptId).digest('hex')+'.json');}
  read(job) {const file=this.file(job);return fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):null;}
  save(job,value) {const file=this.file(job),tmp=file+'.tmp';fs.writeFileSync(tmp,JSON.stringify(value),{mode:0o600});fs.renameSync(tmp,file);}
}

export async function handleOpenCodeJob({broker,manifest,session,job,runner,journal,signal,heartbeatMs=5000}) {
  const previous=journal.read(job);
  if(previous?.report)return broker.report(previous.report);
  const reportId='opencode_'+job.attemptId;
  const deliver=async(outcome,summary,extra={})=>{
    const report={jobId:job.jobId,attemptId:job.attemptId,reportId,outcome,summary,artifacts:[],checks:[],checkpoint:null,unknowns:[],...extra};
    journal.save(job,{report});
    return broker.report(report);
  };
  if(previous)return deliver('failed','执行器曾中断；请核对已有文件后明确重新派发，未自动重复执行。');
  journal.save(job,{started:true});
  const context=await broker.context({jobId:job.jobId,attemptId:job.attemptId});
  if(!context.ok)return deliver(context.code==='stale_attempt'?'cancelled':'failed','未取得当前授权上下文，未启动 OpenCode。');
  const packet=context.packet;
  const binding=verifyBinding({manifest,session,claim:job,packet});
  if(!binding.ok || !['chat','work'].includes(job.kind) || packet.job.kind!==job.kind || job.agentId!==manifest.agentId || job.executorId!==manifest.executorId || packet.executorId!==manifest.executorId || packet.homeId!==manifest.homeId)return deliver('failed','身份、任务或批准目录核对失败，未启动 OpenCode。');
  if(signal?.aborted)return deliver('cancelled','本轮执行已停止。');
  const {finalInput,receipt}=assembleFinalInput(packet);
  const started=await broker.event({jobId:job.jobId,attemptId:job.attemptId,seq:1,type:'started',summary:'OpenCode 正在处理本轮'+(job.kind==='chat'?'聊天':'工单'),checkpoint:{receipt:{packetId:receipt.packetId,contextVersion:receipt.contextVersion,inputSha:receipt.inputSha}}});
  if(!started.ok)return deliver('cancelled','执行轮次已失效，未启动 OpenCode。');
  if(signal?.aborted)return deliver('cancelled','本轮执行已停止。');
  let cancelled=false,busy=false,monitoring=true,lastHeartbeat=Date.now();
  const cancel=()=>{if(!monitoring)return;cancelled=true;runner.abort();};
  signal?.addEventListener('abort',cancel,{once:true});
  const timer=setInterval(async()=>{
    if(busy)return;busy=true;
    try {
      const r=await broker.heartbeat({jobId:job.jobId,attemptId:job.attemptId});
      if(!monitoring)return;
      if(r.ok){lastHeartbeat=Date.now();if(r.contextVersion!==packet.contextVersion)cancel();}
      else if(['stale_attempt','unauthenticated','forbidden'].includes(r.code)||Date.now()-lastHeartbeat>20000)cancel();
    } finally {busy=false;}
  },heartbeatMs);
  let result;
  try {result=await runner.execute({finalInput,workspace:packet.job.workspace,kind:job.kind,timeoutMs:job.timeoutMs||180000});}
  catch {result={status:'failed',summary:'OpenCode 无法执行；请检查 CLI 安装与本目录执行配置。'};}
  finally {monitoring=false;clearInterval(timer);signal?.removeEventListener('abort',cancel);}
  if(cancelled||signal?.aborted||result.status==='cancelled')return deliver('cancelled','本轮执行已停止。');
  const success=result.status==='completed';
  return deliver(success?'submitted':'failed',result.summary||'OpenCode 未完成本轮执行。',{
    artifacts:success&&job.kind==='work'?result.artifacts||[]:[],
    checkpoint:{jobId:job.jobId,attemptId:job.attemptId,workspace:job.workspace,sessionId:result.sessionId||null,modelUsed:result.modelUsed||null,completed:[],remaining:success?[]:['核对已有产物后重新派发'],nextAction:success?'等待验收':'检查执行阻塞'},
    unknowns:result.unknowns||[]
  });
}

export async function runOpenCodeBridge({manifestPath}) {
  const manifest=JSON.parse(fs.readFileSync(manifestPath,'utf8'));
  if(manifest.schemaVersion!==1||manifest.executorId!=='opencode')throw new Error('无效的 OpenCode 登记');
  const url=new URL(manifest.bridgeUrl);
  if(url.protocol!=='http:'||url.hostname!=='127.0.0.1')throw new Error('只接受本机 Luma broker');
  const token=fs.readFileSync(manifest.tokenFile,'utf8').trim();
  const stateDir=path.join(path.dirname(manifest.tokenFile),'opencode-state');
  const journal=new AttemptJournal(path.join(stateDir,'attempts'));
  const runner=new OpenCodeRunner({stateDir:path.join(stateDir,'packets')});
  const broker=new BrokerClient({bridgeUrl:manifest.bridgeUrl,token});
  const controller=new AbortController();
  const stop=()=>{controller.abort();runner.abort();};
  process.on('SIGINT',stop);process.on('SIGTERM',stop);
  let input='';
  const onInput=data=>{input+=data;const lines=input.split(/\r?\n/);input=lines.pop();if(lines.some(x=>x.trim()==='stop'))stop();};
  process.stdin.on('data',onInput);
  const session=await broker.session();
  if(!session.ok||session.agentId!==manifest.agentId||session.executorId!==manifest.executorId||session.homeId!==manifest.homeId||session.generation!==manifest.generation)stop();
  const pause=()=>new Promise(resolve=>{
    if(controller.signal.aborted)return resolve();
    const end=()=>{clearTimeout(timer);controller.signal.removeEventListener('abort',end);resolve();};
    const timer=setTimeout(end,1500);controller.signal.addEventListener('abort',end,{once:true});
  });
  try {
    while(!controller.signal.aborted) {
      const claim=await broker.claim({capabilities:{executor:'opencode',kinds:['chat','work']}});
      if(!claim.ok){if(['unauthenticated','forbidden'].includes(claim.code))break;await pause();continue;}
      if(!claim.job){await pause();continue;}
      try{await handleOpenCodeJob({broker,manifest,session,job:claim.job,runner,journal,signal:controller.signal});}catch{stop();}
    }
  } finally {
    stop();process.stdin.removeListener('data',onInput);process.stdin.pause();
    process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);
  }
}
