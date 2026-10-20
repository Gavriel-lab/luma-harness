'use strict';
const http=require('node:http');
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {pathToFileURL}=require('node:url');
const types={'.html':'text/html;charset=utf-8','.js':'text/javascript;charset=utf-8','.css':'text/css;charset=utf-8','.json':'application/json','.webmanifest':'application/manifest+json','.svg':'image/svg+xml','.png':'image/png','.webp':'image/webp','.jpg':'image/jpeg','.ttf':'font/ttf'};
async function startLocalMobile({rpc,dataDir,port,assetsDir,routeModule,announce=true}){
 const {routeOperation}=await import(pathToFileURL(routeModule).href);
 const authDir=path.join(dataDir,'local-mobile');fs.mkdirSync(authDir,{recursive:true,mode:0o700});
 const token=crypto.randomBytes(32).toString('hex');
 const tokenFile=path.join(authDir,'session.token');fs.writeFileSync(tokenFile,token,{mode:0o600});
 const equal=value=>typeof value==='string'&&value.length===token.length&&crypto.timingSafeEqual(Buffer.from(value),Buffer.from(token));
 const server=http.createServer(async(req,res)=>{
  const origin=`http://127.0.0.1:${server.address().port}`;
  const send=(status,body,headers={})=>{res.writeHead(status,{'content-type':'application/json;charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer',...headers});res.end(typeof body==='string'?body:JSON.stringify(body));};
  try{
   if(req.headers.host!==`127.0.0.1:${server.address().port}`)return send(403,{error:'invalid_host'});
   if(req.headers.origin&&req.headers.origin!==origin)return send(403,{error:'cross_origin'});
   if(req.headers['sec-fetch-site']==='cross-site')return send(403,{error:'cross_site'});
   const url=new URL(req.url,origin);
   if(url.pathname==='/pair'&&req.method==='GET'){
    if(!equal(url.searchParams.get('token')))return send(403,{error:'forbidden'});
    return send(303,'',{location:'/', 'set-cookie':`luma_local=${token}; HttpOnly; SameSite=Strict; Path=/`});
   }
   const bearer=req.headers.authorization?.replace(/^Bearer /,'');
   const cookie=req.headers.cookie?.split(';').map(v=>v.trim()).find(v=>v.startsWith('luma_local='))?.slice(11);
   if(!equal(bearer)&&!equal(cookie))return send(401,{error:{code:'login_required',message:'Open the local pairing link printed by npm start',retryable:false}});
   if(url.pathname==='/api/bootstrap')return send(200,{name:'Luma',schema:'luma.bootstrap/1',capabilities:{chat:{ready:true}}});
   const operation=routeOperation(url.pathname,req.method,url);
   if(operation){
    let payload=operation.payload;
    if(payload===null){let raw='';for await(const c of req){raw+=c;if(Buffer.byteLength(raw)>380000)return send(413,{error:'payload_too_large'});}payload=JSON.parse(raw||'{}');}
    const result=await rpc.handle(operation.operation,payload);return send(result.status,result.body);
   }
   if(url.pathname.startsWith('/api/'))return send(404,{error:'not_found'});
   if(!['GET','HEAD'].includes(req.method))return send(405,{error:'method_not_allowed'});
   let file=path.resolve(assetsDir,'.'+decodeURIComponent(url.pathname));
   const relative=path.relative(assetsDir,file);
   if(relative.startsWith('..')||path.isAbsolute(relative))return send(403,{error:'forbidden'});
   if(!fs.existsSync(file)||!fs.statSync(file).isFile())file=path.join(assetsDir,'index.html');
   res.writeHead(200,{'content-type':types[path.extname(file)]||'application/octet-stream','cache-control':'no-store','referrer-policy':'no-referrer','x-content-type-options':'nosniff'});
   res.end(req.method==='HEAD'?undefined:fs.readFileSync(file));
  }catch{send(500,{error:{code:'local_request_failed',message:'Local request failed',retryable:false}});}
 });
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
 const url=`http://127.0.0.1:${server.address().port}/pair?token=${token}`;
 fs.writeFileSync(path.join(authDir,'connection.json'),JSON.stringify({url,port:server.address().port}),{mode:0o600});
 if(announce)console.log('[Luma local mobile] '+url);
 return {server,url,close:()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections?.();})};
}
module.exports={startLocalMobile};
