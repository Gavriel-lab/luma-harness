import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
if(Number(process.versions.node.split('.')[0])<24)throw Error('Install Node.js 24 or newer');
for(const dir of ['apps/desktop','apps/mobile','services/gateway','apps/desktop/connectors/pi']){
 const result=spawnSync(process.platform==='win32'?'npm.cmd':'npm',['ci'],{cwd:path.join(root,dir),stdio:'inherit',shell:process.platform==='win32',env:{...process.env,NODE_USE_ENV_PROXY:process.env.NODE_USE_ENV_PROXY||'1'}});
 if(result.status!==0)process.exit(result.status||1);
}
const runtime=spawnSync(process.execPath,[path.join(root,'apps/desktop/node_modules/electron/install.js')],{cwd:root,stdio:'inherit',env:{...process.env,NODE_USE_ENV_PROXY:process.env.NODE_USE_ENV_PROXY||'1'}});
if(runtime.status!==0)process.exit(runtime.status||1);
if(!fs.existsSync(path.join(root,'luma.config.json')))fs.copyFileSync(path.join(root,'luma.config.example.json'),path.join(root,'luma.config.json'));
console.log('Dependencies ready. Edit luma.config.json or configure members in the desktop settings, then npm run build && npm start.');
