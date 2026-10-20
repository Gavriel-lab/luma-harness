'use strict';
// No cloud database is bundled or contacted by the public build.
class CloudSyncSyncService {
 constructor(){this.status={enabled:false,connected:false,pendingCount:0,lastSyncTime:null,error:null};}
 async init(){} getStatus(){return {...this.status};}
 async enqueueReceipt(){} dispose(){}
 async login(){return {ok:false,error:'Install your own synchronization adapter'};}
 async logout(){return {ok:true};}
 async syncNow(){return {ok:false,error:'Optional synchronization not configured'};}
 async resolveMemoryConflict(){return {ok:false,error:'Optional synchronization not configured'};}
}
module.exports={CloudSyncSyncService};
