'use strict';
// One channel classifier for rendering, transport and memory. Channel affects
// presentation; canonical conversation/member ownership is unchanged.
const requestKey=m=>m.requestId?`${m.conversationId||''}\0${m.requestId}`:null;
const isXiaoduRequest=id=>typeof id==='string'&&/^(?:req_)?xiaodu_/.test(id);
const textOf=m=>m.text??m.content??'';
const isDeviceEvent=m=>m.eventKind==='device-event'||/^(?:req_)?xiaodu_event_/.test(m.requestId||'')||/^\[来自小度\s*[·・]\s*(?:视觉靠近唤醒|视觉唤醒|设备状态|系统唤醒)\]/.test(textOf(m));
function classify(messages) {
  const xiaodu=new Set(),events=new Set();
  for(const m of messages) {
    const key=requestKey(m);
    if(key&&(m.sourceChannel==='xiaodu'||isXiaoduRequest(m.requestId)||/^\[来自小度(?:\s*[·・]|\])/.test(textOf(m))))xiaodu.add(key);
    if(key&&isDeviceEvent(m))events.add(key);
  }
  return new Map(messages.map(m=>[m.id,{
    channel:m.sourceChannel==='xiaodu'||isXiaoduRequest(m.requestId)||xiaodu.has(requestKey(m))||/^\[来自小度(?:\s*[·・]|\])/.test(textOf(m))?'xiaodu':'luma',
    deviceEvent:isDeviceEvent(m)||events.has(requestKey(m)),
  }]));
}
function deviceEventIds(messages){return new Set([...classify(messages)].filter(([,v])=>v.deviceEvent).map(([id])=>id));}
function timeline(messages) {
  const channels=classify(messages),rows=[];
  for(const message of messages) {
    if(!channels.get(message.id)?.deviceEvent){rows.push({kind:'message',message});continue;}
    let row=rows[rows.length-1];
    if(row?.kind!=='device-events'){row={kind:'device-events',messages:[],count:0};rows.push(row);}
    row.messages.push(message);
    row.count=new Set(row.messages.map(m=>requestKey(m)||m.id)).size;
  }
  return rows;
}
module.exports={classify,deviceEventIds,timeline,isXiaoduRequest,isDeviceEvent};
