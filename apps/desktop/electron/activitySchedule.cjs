'use strict';
// Generic bounded randomized interval; no external scheduler or memory dependency.
function nextWake(config,now=Date.now(),random=Math.random){
 const zone=process.env.LUMA_TIME_ZONE||Intl.DateTimeFormat().resolvedOptions().timeZone;
 const clock=new Intl.DateTimeFormat('en',{timeZone:zone,hour:'numeric',hourCycle:'h23'}).formatToParts(now);
 const hour=Number(clock.find(part=>part.type==='hour').value);
 const hours=config.dayHours||[8,23];
 const start=((Number(hours[0])%24)+24)%24;
 const length=((Number(hours[1])-start+24)%24)||24;
 const daytime=((hour-start+24)%24)<length;
 const interval=(daytime?config.dayMinutes:config.nightMinutes)||[60,60];
 const low=Number(interval[0]),high=Number(interval[1]);
 if(!Number.isFinite(low)||!Number.isFinite(high)||low<1||high<low||high>10080)throw Error('Invalid activity interval');
 const fraction=Math.max(0,Math.min(1,Number(random())||0));
 return now+Math.round((low+(high-low)*fraction)*60000);
}
function due(at,now=Date.now()){return typeof at==='number'&&Number.isFinite(at)&&at<=now;}
module.exports={nextWake,due};
