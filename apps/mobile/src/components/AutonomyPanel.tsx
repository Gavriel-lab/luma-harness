import React, { useEffect, useRef, useState } from 'react';
import { Compass, ChevronDown, RefreshCw } from 'lucide-react';

type Walk = { id:string; agentId:string; name:string; status:string; note:string; text?:string; startedAt:number; sources:{url:string;title:string}[] };
type House = {
  settings:{enabled:boolean;rhythm:string}; running:string|null;
  members:{agentId:string;name:string;enabled:boolean;nextWake?:number;lastNote?:string}[];
  history:Walk[];
};
const labels:Record<string,string>={exploring:'正在想做点什么',shared:'分享了一条动态',interacted:'和家人互动了',written:'写下了一篇日记',resting:'安静待了一会儿',failed:'这次没完成',interrupted:'先回来陪你', 'pending-delivery':'见闻等着送达',cancelled:'已结束',withdrawn:'分享已删除'};
const time=(value:number)=>new Date(value).toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'});
async function api(path='',body?:object,signal?:AbortSignal):Promise<any> {
  const response=await fetch('/api/autonomy'+path,{method:body?'POST':'GET',headers:{'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal});
  const data=await response.json();if(!response.ok)throw Error(data.error?.message||'自由时间暂时没连上，等桌面小屋回来再看看');return data;
}
export function AutonomyPanel() {
  const [open,setOpen]=useState(false),[house,setHouse]=useState<House|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const alive=useRef(true);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  useEffect(()=>{
    if(!open)return;
    const controller=new AbortController();
    const update=()=>api('',undefined,controller.signal).then(value=>{if(alive.current&&!controller.signal.aborted){setHouse(value);setError('');}}).catch(e=>{if(alive.current&&!controller.signal.aborted)setError(e.message);});
    void update();const timer=setInterval(update,12000);return()=>{controller.abort();clearInterval(timer);};
  },[open]);
  async function change(path:string,body:object) {
    setBusy(true);setError('');try {await api(path,body);const current=await api();if(alive.current)setHouse(current);}catch(e){if(alive.current)setError(e instanceof Error?e.message:'暂时没能保存');}finally{if(alive.current)setBusy(false);}
  }
  return <section className="space-y-1.5" aria-label="家人的自由时间">
    <button type="button" onClick={()=>setOpen(!open)} className="w-full flex items-center justify-between px-1 py-2 text-xs text-stone-600" aria-expanded={open}>
      <span className="flex items-center gap-2"><Compass size={16}/>家人的自由时间</span><ChevronDown size={16} className={open?'rotate-180':''}/>
    </button>
    {open&&<div className="bg-white/40 rounded-3xl p-4 border border-white/60 shadow-xs space-y-4 text-xs text-stone-700">
      <p className="leading-relaxed text-stone-500">出去看看世界，也把惦记你的瞬间带回来。桌面小屋开着时，大家会按自己的节奏醒来。</p>
      {error&&<p role="status" className="text-amber-800 leading-relaxed">{error}</p>}
      {!house&&!error&&<p role="status">在看看大家的近况……</p>}
      {house&&<>
        <label className="flex justify-between items-center gap-3"><span>让家人拥有自由时间</span><input aria-label="让家人拥有自由时间" type="checkbox" checked={house.settings.enabled} disabled={busy} onChange={e=>void change('/settings',{enabled:e.target.checked})} className="accent-stone-600 w-4 h-4"/></label>
        <label className="flex justify-between items-center gap-3"><span>出门节奏</span><select aria-label="出门节奏" value={house.settings.rhythm} disabled={busy} onChange={e=>void change('/settings',{rhythm:e.target.value})} className="rounded-xl bg-white/70 p-2 border border-stone-200 text-xs"><option value="relaxed">悠闲 · 白天约 6～10 小时</option><option value="lively">活跃 · 白天约 2～4 小时</option></select></label>
        <p className="text-[10px] leading-relaxed text-stone-500">夜间会更疏一些；家人也能自己决定下次何时醒来。出门时聊天里会显示不在家，你可以留言，等他们回来再聊。</p>
        <div className="space-y-3">{house.members.map(member=><div key={member.agentId} className="rounded-2xl bg-white/50 p-3 space-y-2">
          <div className="flex justify-between items-center gap-3"><label className="flex gap-2 items-center font-semibold"><input type="checkbox" aria-label={member.name+'的自由时间'} checked={member.enabled} disabled={busy} onChange={e=>void change('/settings',{agentId:member.agentId,memberEnabled:e.target.checked})} className="accent-stone-600"/>{member.name}</label><button type="button" disabled={busy||!!house.running||!house.settings.enabled||!member.enabled} onClick={()=>void change('/wake',{agentId:member.agentId,requestId:'walk_'+crypto.randomUUID()})} className="px-3 py-1.5 rounded-xl border border-stone-300/50 bg-white/60 disabled:opacity-40">出去逛逛</button></div>
          <p className="text-[10px] text-stone-500">{house.running===member.agentId?'正在外面逛……':!house.settings.enabled||!member.enabled?'自由时间已暂停':member.nextWake?'下次醒来 · '+time(member.nextWake):'在安排下一次出门'}</p>
          {member.lastNote&&<p className="leading-relaxed break-words">{member.lastNote}</p>}
        </div>)}</div>
        <details className="space-y-3"><summary className="cursor-pointer py-1">最近的出门手记 · {house.history.length}</summary>
          {!house.history.length&&<p className="pt-2 text-stone-500">还没有出门手记，第一次回来就会留在这里。</p>}
          {house.history.map(walk=><article key={walk.id} className="pt-3 border-t border-stone-200/60 space-y-2">
            <div className="flex justify-between gap-2"><strong>{walk.name} · {labels[walk.status]||walk.status}</strong><time className="text-[10px] text-stone-500 shrink-0">{time(walk.startedAt)}</time></div>
            <p className="leading-relaxed whitespace-pre-wrap break-words">{walk.text||walk.note}</p>
            {walk.sources.map(source=><a key={source.url} href={source.url} target="_blank" rel="noreferrer" className="block text-stone-500 underline underline-offset-2 break-words">{source.title}</a>)}
          </article>)}
        </details>
      </>}
    </div>}
  </section>;
}
