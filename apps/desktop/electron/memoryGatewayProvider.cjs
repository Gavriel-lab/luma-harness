'use strict';
// Legacy IPC seam intentionally returns unavailable; configure LUMA_MEMORY_PLUGIN instead.
class MemoryGatewayMemoryProvider {
 async checkHealth(){return {ok:false,error:'Optional memory provider not configured'};}
 async recall(){return {success:false,memories:[],error:'Optional memory provider not configured'};}
 async ingestMessages(){return {success:false,ingested:0,error:'Optional memory provider not configured'};}
 async search(){return {success:false,results:[],error:'Optional memory provider not configured'};}
}
module.exports={MemoryGatewayMemoryProvider};
