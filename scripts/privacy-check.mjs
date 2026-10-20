import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const skip=new Set(['.git','node_modules','.local','.wrangler','artifacts']);
const exactPrivateFiles=new Set(['luma.config.json','wrangler.json']);
const credentialNames=/^(?:\.env(?:\..*)?|\.dev\.vars(?:\..*)?|auth\.json|credentials.*\.(?:json|bin|dat|enc)|.*\.(?:pem|p12|pfx|key|token|sqlite|db|jsonl))$/i;
const textFile=/\.(?:[cm]?[jt]sx?|json|md|txt|css|html|svg|ya?ml|webmanifest)$/i;
const patterns=[['private-key',/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],['provider-key',/\b(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{24,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/],['personal-email',/[A-Za-z0-9._%+-]+@(?:gmail|outlook|qq|163)\.com\b/i],['home-identity',/home_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/i]];
let count=0;const findings=[];
function walk(dir,rel=''){
 for(const e of fs.readdirSync(dir,{withFileTypes:true})){
  if(skip.has(e.name)||exactPrivateFiles.has(e.name)||e.name.endsWith('.tsbuildinfo'))continue;
  const file=path.join(dir,e.name),name=rel?rel+'/'+e.name:e.name;
  if(e.isSymbolicLink()){findings.push([name,'unexpected-symlink']);continue;}
  if(e.isDirectory()){walk(file,name);continue;}
  if(credentialNames.test(e.name)&&!e.name.endsWith('.example'))findings.push([name,'private-file']);
  if(!textFile.test(e.name))continue;
  count++;const text=fs.readFileSync(file,'utf8');
  for(const [label,pattern]of patterns){
   // Chromium's official license inventory contains upstream authors' copyright emails.
   if(label==='personal-email'&&e.name==='LICENSES.chromium.html')continue;
   if(pattern.test(text))findings.push([name,label]);
  }
 }
}
walk(root);
for(const [file,label]of findings)console.error(`${label}: ${file}`);
console.log(JSON.stringify({marker:findings.length?'LUMA_PRIVACY_FAILED':'LUMA_PRIVACY_OK',textFiles:count,findings:findings.length}));
if(findings.length)process.exitCode=1;
