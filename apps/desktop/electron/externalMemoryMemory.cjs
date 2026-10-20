'use strict';
const path=require('node:path');
// Optional host-owned plugin. It is never selected by a browser or model request.
class ExternalMemoryMemory {
 constructor(options){this.options=options;this.state={state:'disabled',engine:'external'};}
 async start(){
  const entry=process.env.LUMA_MEMORY_PLUGIN;
  if(!entry)return;
  if(!path.isAbsolute(entry))throw Error('LUMA_MEMORY_PLUGIN must be an absolute local module path');
  const plugin=require(entry);
  this.plugin=await plugin.createMemoryProvider(this.options);
  if(typeof this.plugin.prepare!=='function')throw Error('Memory plugin must implement prepare');
  await this.plugin.start?.();this.state={state:'ready',engine:'external'};
 }
 async prepare(params){
  const empty={state:'disabled',memoryIds:[],messageIds:[],notes:[],diagnostics:[]};
  if(!this.plugin)return empty;
  try{return {...empty,...await this.plugin.prepare(params),engine:'ExternalMemory'};}
  catch{this.state={state:'degraded',engine:'external'};return empty;}
 }
 async delivered(params,receipt){await this.plugin?.delivered?.(params,receipt);}
 async continuity(params){return await this.plugin?.continuity?.(params)||[];}
 async gardenCatalog(params){if(!this.plugin?.gardenCatalog)throw Error('Optional memory provider not configured');return this.plugin.gardenCatalog(params);}
 async gardenDetail(params){if(!this.plugin?.gardenDetail)throw Error('Optional memory provider not configured');return this.plugin.gardenDetail(params);}
 async gardenRelated(params){if(!this.plugin?.gardenRelated)throw Error('Optional memory provider not configured');return this.plugin.gardenRelated(params);}
 async stop(){await this.plugin?.stop?.();}
}
module.exports={ExternalMemoryMemory};
