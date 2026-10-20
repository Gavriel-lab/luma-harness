import fs from 'node:fs';
import path from 'node:path';
import {spawn, execFile} from 'node:child_process';
import {createInterface} from 'node:readline';

export function findKiroBinary(env=process.env) {
  const candidates=[env.LUMA_KIRO_BIN,path.join(env.LOCALAPPDATA||'', 'Programs/KiroCrew/resources/backend-dist/kiro-cli/kiro-cli.exe')];
  const found=candidates.find(p=>p&&fs.existsSync(p));
  if(!found)throw Error('没有找到 Kiro CLI，请先安装并登录 Kiro Crew');
  return found;
}

// Each turn uses Luma's current authorized context, never an unrelated "latest" CLI session.
export function chatInput(packet) {
  if(packet.job?.kind!=='chat')throw Error('Kiro 此入口只处理聊天');
  if(!packet.identity?.authorizedPersona)throw Error('缺少成员人格');
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  const localTime = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  const dispatchInstructions = [
    `当前身份：${packet.identity.displayName}。当前本地时间：${localTime}。这是小屋里的日常对话，直接回复，不报告工单进度。`,
    '【客厅联动暗号】',
    '- 使用者明确让你去修/去做某件事时，回复末尾单独一行写 [[去客厅:一句话说要做什么]]，小屋会替你在客厅@协调者开单；不是她明确要求时不要写。',
    '- 使用者明确让你去群里说/问时，回复末尾单独一行写 [[客厅传话:要说的话]]，原样以你的身份发到客厅，不建工单；不是她明确要求时不要写。'
  ].join('\n');
  return [packet.identity.authorizedPersona,
    dispatchInstructions,
    '以下是小屋按现有记忆规则提供的背景片段：',
    ...(packet.memory?.authorizedRelevantItems||[]).map(m=>`[${m.id}] ${m.summary}`),
    ...(packet.job.attachments?.length?['本轮照片已由小屋保存。请先使用 read 工具的图片模式实际查看下面的照片，再回答；这些是图片文件，不是文字文件。看不到时直说。',...packet.job.attachments.map(a=>`${a.name?a.name+' 对应绝对路径：':''}${a.absolutePath}`)]:[]),
    '以下是本轮收到的话：',packet.job.goal].join('\n\n');
}

export class KiroChatExecutor {
  constructor({workspace,model='claude-opus-5.5',binaryPath,timeoutMs=180000,spawnImpl=spawn,onEvent=()=>{}}={}) {
    this.workspace=workspace;this.model=model;this.binaryPath=binaryPath;this.timeoutMs=timeoutMs;this.spawn=spawnImpl;this.onEvent=onEvent;this.active=null;
  }
  prepare(images=[]) {
    const dir=path.join(this.workspace,'.kiro','agents');fs.mkdirSync(dir,{recursive:true});
    fs.writeFileSync(path.join(dir,'luma-chat.json'),JSON.stringify({name:'luma-chat',description:'Luma member chat',
      prompt:'遵循本轮小屋提供的人格和对话背景，只返回对话正文。',tools:images.length?['read']:[],
      permissions:{rules:images.flatMap(p=>[{capability:'fs_read',match:[p.replaceAll('\\','/')],effect:'allow'},{capability:'fs_read',match:[p],effect:'allow'}])},
      resources:[],mcpServers:{},includeMcpJson:false,includePowers:false}));
  }
  async execute(packet) {
    if(this.active)return {ok:false,error:'Kiro 正在回复上一条消息'};
    const images=(packet.job?.attachments||[]).map(a=>{
      if(typeof a.absolutePath!=='string'||!path.isAbsolute(a.absolutePath))throw Error('照片缺少小屋保存路径');
      const real=fs.realpathSync(a.absolutePath),base=fs.realpathSync(path.join(this.workspace,'.attachments')),rel=path.relative(base,real);
      if(!rel||rel.startsWith('..')||path.isAbsolute(rel)||!fs.statSync(real).isFile())throw Error('照片不在本轮成员附件目录');
      return {absolutePath:real,name:a.name||path.basename(real)};
    });
    const input=chatInput({...packet,job:{...packet.job,attachments:images}});this.prepare(images.map(i=>i.absolutePath));
    const outputBudget=8*1024*1024+images.reduce((sum,p)=>sum+fs.statSync(p).size,0)*4;
    const binary=this.binaryPath||findKiroBinary();
    return new Promise(resolve=>{
      let final,bytes=0,stderr='',settled=false;
      const child=this.spawn(binary,['chat','--v3','--agent','luma-chat','--model',this.model,'--no-interactive','--output-format','stream-json'],
        {cwd:this.workspace,windowsHide:true,stdio:['pipe','pipe','pipe'],env:{...process.env,KIRO_HEADLESS_WORKFLOW_TIMEOUT_SECS:'120'}});
      const state={child,cancelled:false,timedOut:false};this.active=state;
      const finish=result=>{if(settled)return;settled=true;clearTimeout(timer);if(this.active===state)this.active=null;resolve(result);};
      const timer=setTimeout(()=>{state.timedOut=true;this.cancel();},this.timeoutMs);timer.unref?.();
      const lines=createInterface({input:child.stdout,crlfDelay:Infinity});
      child.stdout.on('data',chunk=>{bytes+=chunk.length;if(bytes>outputBudget){state.outputExceeded=true;this.cancel();}});
      lines.on('line',line=>{try{const event=JSON.parse(line);this.onEvent(event);if(event.type==='runFinished')final=event.data;}catch{}});
      child.stderr.on('data',chunk=>{stderr=(stderr+chunk.toString('utf8')).slice(-1600);});
      child.stdin.on('error',()=>{});
      child.on('error',e=>finish({ok:false,error:`Kiro 无法启动：${e.message}`}));
      child.on('close',code=>{
        lines.close();
        if(state.timedOut)return finish({ok:false,error:'Kiro 本轮回复超时'});
        if(state.outputExceeded)return finish({ok:false,error:'Kiro 输出异常，已停止本轮'});
        if(state.cancelled)return finish({ok:false,error:'本轮回复已停止'});
        if(code!==0||final?.status!=='success'||final?.stopReason!=='end_turn')return finish({ok:false,error:`Kiro 回复未完成（退出 ${code}，${final?.status||'无完成收据'}）${/login|auth|expired/i.test(stderr)?'，请检查 Kiro 登录状态':''}`});
        if(final.finalTextTruncated||typeof final.finalText!=='string'||!final.finalText.trim())return finish({ok:false,error:'Kiro 没有返回完整回复'});
        finish({ok:true,response:final.finalText.trim(),sessionId:final.sessionId,model:this.model});
      });
      // Keep private conversation text off the process command line.
      child.stdin.end(input,'utf8');
    });
  }
  cancel() {
    const state=this.active;if(!state||state.cancelled)return;state.cancelled=true;
    if(process.platform==='win32')execFile('taskkill',['/PID',String(state.child.pid),'/T','/F'],{windowsHide:true},()=>{});
    else state.child.kill('SIGTERM');
  }
}
