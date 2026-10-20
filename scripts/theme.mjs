import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const action=process.argv[2],pack=path.resolve(process.argv[3]||path.join(root,'themes/oil-painting'));
const backup=path.join(root,'.local/base-theme');
function files(dir,rel=''){return fs.readdirSync(path.join(dir,rel),{withFileTypes:true}).flatMap(e=>e.isDirectory()?files(dir,path.join(rel,e.name)):[path.join(rel,e.name)]);}
if(action==='apply'){
 if(!fs.existsSync(path.join(pack,'theme.json')))throw Error('Download and extract luma-oil-painting.zip into themes/oil-painting first');
 if(fs.existsSync(path.join(backup,'manifest.json')))throw Error('A theme is already applied. Run npm run theme:reset first');
 const manifest=[];
 for(const app of ['desktop','mobile'])for(const rel of files(path.join(pack,app))){
  if((rel!=='index.html'&&!/^(src|public)[\\/]/.test(rel))||/\.(?:cjs|mjs|json|env)$/i.test(rel))throw Error('Theme contains a non-visual runtime file');
  const src=path.join(pack,app,rel),dest=path.join(root,'apps',app,rel),saved=path.join(backup,app,rel);
  const exists=fs.existsSync(dest);
  if(exists){fs.mkdirSync(path.dirname(saved),{recursive:true});fs.copyFileSync(dest,saved);}
  manifest.push({app,rel,existed:exists});fs.mkdirSync(path.dirname(dest),{recursive:true});fs.copyFileSync(src,dest);
 }
 fs.writeFileSync(path.join(backup,'manifest.json'),JSON.stringify(manifest));
 console.log('Oil painting appearance applied. Rebuild both clients. Members, credentials and data were not changed.');
}else if(action==='reset'){
 const manifest=JSON.parse(fs.readFileSync(path.join(backup,'manifest.json'),'utf8'));
 // Restore source files. Added artwork can remain unreferenced; never delete consumer data.
 for(const {app,rel,existed}of manifest)if(existed)fs.copyFileSync(path.join(backup,app,rel),path.join(root,'apps',app,rel));
 fs.renameSync(path.join(backup,'manifest.json'),path.join(backup,`manifest-restored-${Date.now()}.json`));
 console.log('Base appearance restored. Rebuild both clients.');
}else throw Error('Usage: node scripts/theme.mjs apply [extracted-pack-path] | reset');
