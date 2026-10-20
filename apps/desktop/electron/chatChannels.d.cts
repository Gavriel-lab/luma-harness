import type { Message } from '../src/types';
type Channel = 'luma' | 'xiaodu';
type TimelineRow = {kind:'message';message:Message} | {kind:'device-events';messages:Message[];count:number};
declare const rules: {
  classify(messages:Message[]):Map<string,{channel:Channel;deviceEvent:boolean}>;
  deviceEventIds(messages:Message[]):Set<string>;
  timeline(messages:Message[]):TimelineRow[];
  isXiaoduRequest(id:string|null|undefined):boolean;
};
export default rules;
