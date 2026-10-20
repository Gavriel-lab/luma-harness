'use strict';
const path=require('node:path');

// Derive this from the saved question, never from a renderer-supplied permission.
function hasUserOrigin(params,data) {
 if(params?.targetAgentId!=='agent_coordinator'||params.isUserInitiated===false||params.originReport)return false;
 const ids=new Set(params.excludeMessageIds||[]),purged=new Set(data?.purgedMessageIds||[]);
 return (data?.messages||[]).some(m=>ids.has(m.id)&&m.agentId==='agent_owner'&&m.conversationId===params.conversationId&&m.status==='sent'&&!m.demo&&!m.deletedAt&&!purged.has(m.id)&&m.eventKind!=='device-event'&&m.text===params.currentText);
}

function executionPolicy(options,localOperations,cwd) {
 const writable=options.allowLocalOperations===true&&localOperations===true;
 const roots=[...new Set([cwd,...(options.writableRoots||[])].filter(p=>typeof p==='string'&&path.isAbsolute(p)))];
 return writable?{
  thread:{approvalPolicy:'never',sandbox:'workspace-write'},
  turn:{approvalPolicy:'never',sandboxPolicy:{type:'workspaceWrite',writableRoots:roots,networkAccess:true}},
 }:{
  thread:{approvalPolicy:'untrusted',sandbox:'read-only'},
  turn:{approvalPolicy:'untrusted',sandboxPolicy:{type:'readOnly',networkAccess:false}},
 };
}

function approvalResponse(method) {
 if(['item/commandExecution/requestApproval','item/fileChange/requestApproval'].includes(method))return {decision:'decline'};
 if(method==='item/permissions/requestApproval')return {permissions:{},scope:'turn'};
 if(method==='mcpServer/elicitation/request')return {action:'decline',content:null};
 if(['tool/requestUserInput','item/tool/requestUserInput'].includes(method))return {answers:{}};
 return null;
}
module.exports={hasUserOrigin,executionPolicy,approvalResponse};
