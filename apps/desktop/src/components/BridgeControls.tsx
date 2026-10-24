import { useEffect, useState } from 'react';
import type { Store } from '../ui/useAppStore';
export interface BridgeSnapshot {
  registrations: Array<{ agentId:string; executorId:string; workspace:string; manifestPath:string|null; connected:boolean; chatEnabled:boolean }>;
  jobs: Array<{jobId:string;ticketId:string;taskId:string;agentId:string;kind:string;state:string;workspace:string;report?:{reportId:string;summary:string;artifacts:Array<{path:string}>;unknowns:string[]}|null;events:Array<{type:string;summary:string}>}>;
  feed: Array<{id:string;type:string;ticketId:string;taskId:string;agentId:string;createdAt:number}>;
}
const LABELS:Record<string,string>={queued:'已派发，等待领取',doing:'正在执行',offline:'断联，待恢复',blocked:'遇到阻塞',question:'等待答复',permission_required:'等待权限',cancelling:'正在取消',cancelled:'已取消',failed:'执行失败',review:'待验收',returning:'正在保存返修意见',rejected:'已审查退回',done:'已验收'};
export function BridgeControls({store,onSnapshot}:{store:Store;onSnapshot?:(s:BridgeSnapshot)=>void}) {
  const bridge=window.xiaowuDesktop?.bridge;
  const [snapshot,setSnapshot]=useState<BridgeSnapshot|null>(null);
  const [agentId,setAgentId]=useState('');
  const [executorId,setExecutorId]=useState('antigravity-adapter');
  const [note,setNote]=useState('');
  const [busy,setBusy]=useState(false);
  const ticket=store.data.tickets.find(t=>t.id===store.data.activeTicketId);
  useEffect(()=>{
    if(!bridge || !store.ready)return;
    let active=true;
    const receive=(s:BridgeSnapshot)=>{if(active){setSnapshot(s);onSnapshot?.(s);store.dispatch({type:'projectBridge',snapshot:s});}};
    void bridge.snapshot().then(receive).catch(()=>setNote('调度端未就绪'));
    const unbind=bridge.onChanged(receive);
    const timer=window.setInterval(()=>void bridge.snapshot().then(receive).catch(()=>{}),3000);
    return()=>{active=false;unbind();window.clearInterval(timer);};
  },[bridge,store.ready,store.dispatch,onSnapshot]);
  if(!bridge)return null;
  const run=async(action:()=>Promise<{ok:boolean;reason?:string;manifestPath?:string}>)=>{
    if(busy)return;setBusy(true);
    try{if(!await store.flushSave?.()){setNote('先保存当前工单，保存失败时不会派发');return;}
      const result=await action();setNote(result.ok?(result.manifestPath?`登记完成：${result.manifestPath}`:'已完成'):result.reason||'操作失败');
      const s=await bridge.snapshot();setSnapshot(s);onSnapshot?.(s);store.dispatch({type:'projectBridge',snapshot:s});
    }catch(e){setNote(e instanceof Error?e.message:'操作失败');}finally{setBusy(false);}
  };
  return <section className="field bridge-controls" aria-label="客户端工作接线">
    <span className="field__label">客户端接线</span>
    <small>用于维护客户端连接与工作目录。日常分工和内部审核由协调者在后台处理，无需在这里逐项操作。</small>
    <div className="chips">
      <select className="input" aria-label="登记成员" value={agentId} onChange={e=>setAgentId(e.target.value)}>
        <option value="">选择现有成员</option>{store.data.agents.filter(a=>a.kind==='ai'&&!a.removed).map(a=><option key={a.id} value={a.id}>{a.name}</option>)}
      </select>
      <select className="input" aria-label="客户端类型" value={executorId} onChange={e=>setExecutorId(e.target.value)}>
        <option value="antigravity-adapter">反重力</option><option value="zcode">Zcode</option><option value="opencode">OpenCode · 执行助手</option><option value="kiro">Kiro · 聊天</option><option value="pi">Pi SDK · 受控工作</option>
      </select>
      <button className="btn" disabled={busy||!agentId} onClick={()=>void run(()=>bridge.register({agentId,executorId}))}>选择工作目录并登记</button>
    </div>
    {snapshot?.registrations.map(reg=><div key={reg.agentId} className="bridge-registration">
      <span>{store.data.agents.find(a=>a.id===reg.agentId)?.name} · {reg.connected?'已连接':'等待连接'}</span>
      <small>{reg.workspace}</small>
      <button className="btn" disabled={busy} onClick={()=>void run(()=>bridge.launch(reg.agentId))}>连接客户端</button>
      <label><input type="checkbox" disabled={busy} checked={reg.chatEnabled} onChange={e=>{const enabled=e.target.checked;void run(()=>bridge.chatRoute(reg.agentId,enabled));}}/>聊天也走此客户端</label>
    </div>)}
    {ticket?.tasks.map(task=>{
      const job=snapshot?.jobs.filter(j=>j.ticketId===ticket.id&&j.taskId===task.id).at(-1);
      return <div key={task.id} className="bridge-job">
        <strong>{task.title}</strong><span role="status">{job?LABELS[job.state]||job.state:'尚未派发'}</span>
        {!job?<button className="btn" disabled={busy||!task.assigneeId} onClick={()=>void run(()=>bridge.dispatch({ticketId:ticket.id,taskId:task.id,requestId:crypto.randomUUID()}))}>明确派发</button>:null}
        {job&&['failed','cancelled'].includes(job.state)?<button className="btn" disabled={busy} onClick={()=>void run(()=>bridge.resume(job.jobId))}>按检查点重试</button>:null}
        {job&&['queued','doing','offline','blocked','question','permission_required'].includes(job.state)?<button className="btn" disabled={busy} onClick={()=>void run(()=>bridge.cancel(job.jobId))}>取消执行</button>:null}
        {job?.state==='review'?<button className="btn" disabled={busy} onClick={()=>void run(()=>bridge.accept(job.jobId))}>验收通过</button>:null}
        {job?.state==='offline'?<button className="btn" disabled={busy} onClick={()=>void run(()=>bridge.resume(job.jobId))}>确认旧客户端已停，按检查点续接</button>:null}
        {job?.events.at(-1)&&<small>{job.events.at(-1)?.summary}</small>}
        {job?.report&&<details><summary>本任务交付</summary><p style={{whiteSpace:'pre-wrap'}}>{job.report.summary}</p>{job.report.artifacts.map(a=><p key={a.path}>{a.path}</p>)}{job.report.unknowns.length>0&&<p>未验证：{job.report.unknowns.join('；')}</p>}</details>}
      </div>;
    })}
    {note&&<p role="status" style={{overflowWrap:'anywhere'}}>{note}</p>}
  </section>;
}
