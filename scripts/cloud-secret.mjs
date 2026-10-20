import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const dataDir=path.resolve(process.env.LUMA_DATA_DIR||path.join(root,'.local/userData'));
const token=fs.readFileSync(path.join(dataDir,'luma-relay/relay.token'),'utf8').trim();
if(!/^[a-f0-9]{64}$/.test(token))throw Error('Run configure:cloud first');
for(const cwd of ['services/relay','services/gateway']){
 const bin=path.join(root,'services/gateway/node_modules/wrangler/bin/wrangler.js');
 const child=spawn(process.execPath,[bin,'secret','put','RELAY_TOKEN'],{cwd:path.join(root,cwd),stdio:['pipe','inherit','inherit'],windowsHide:true});
 child.stdin.end(token+'\n');
 const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});
 if(code!==0)process.exit(code||1);
}
