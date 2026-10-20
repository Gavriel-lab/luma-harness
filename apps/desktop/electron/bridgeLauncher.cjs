'use strict';
const path=require('node:path');
const fs=require('node:fs');
const {spawn,execFile}=require('node:child_process');
class BridgeLauncher {
  constructor({broker}) {this.broker=broker;this.children=new Map();}
  async launch(agentId) {
    this.broker.member(agentId);
    if(this.children.has(agentId))return {ok:true};
    const session=this.broker.sessions.get(agentId);
    if(!session)throw new Error('成员尚未登记客户端');
    const entry=fs.existsSync(path.join(__dirname,'..','connectors','bridge-entry.mjs'))?path.join(__dirname,'..','connectors','bridge-entry.mjs'):path.join(process.resourcesPath,'connectors','bridge-entry.mjs');
    if(!fs.existsSync(entry))throw new Error('随包适配器未就绪');
    const child=spawn(process.execPath,[entry,'--manifest',session.manifestPath],{windowsHide:true,stdio:['pipe','ignore','ignore'],env:{...process.env,ELECTRON_RUN_AS_NODE:'1'}});
    child.stdin.on('error',()=>{});
    this.children.set(agentId,child);
    child.once('error',()=>this.children.delete(agentId));
    child.once('close',()=>{this.children.delete(agentId);const s=this.broker.sessions.get(agentId);if(s)s.lastSeen=null;this.broker.notify(this.broker.snapshot());});
    await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});
    return {ok:true};
  }
  async stop(agentId=null) {
    await Promise.all([...this.children.entries()].filter(([key])=>!agentId||key===agentId).map(([,child])=>new Promise(resolve=>{
      if(child.exitCode!==null)return resolve();
      // Give the owned wrapper time to stop its executor, await child close and
      // send the cancellation report while the broker is still listening.
      const timer=setTimeout(()=>{
        if(child.exitCode!==null)return;
        if(process.platform==='win32')execFile('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true},()=>{});
        else child.kill('SIGKILL');
      },12000);
      child.once('close',()=>{clearTimeout(timer);resolve();});
      child.stdin.write('stop\n');
    })));
    if(agentId)this.children.delete(agentId);else this.children.clear();
  }
}
module.exports={BridgeLauncher};
