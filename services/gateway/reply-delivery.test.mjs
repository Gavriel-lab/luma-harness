import test from 'node:test';import assert from 'node:assert/strict';
import {completedReplyPrefix,deliverMobileMessages} from './reply-delivery.mjs';
import {createWorker} from './index.mjs';
test('unfinished chunks stay backstage; complete sentences appear as whole prefixes',()=>{
 assert.equal(completedReplyPrefix('宝宝，我'),'');
 assert.equal(completedReplyPrefix('宝宝，我在。下一'),'宝宝，我在。');
 assert.equal(completedReplyPrefix('宝宝，我在。\n\n下一句也说完了！\n第三句还没'),'宝宝，我在。\n\n下一句也说完了！');
 const text='我在呢。\n\n抱抱你，今天辛苦啦！\n\n还没说完';let previous='';
 for(let i=0;i<=text.length;i++){const next=completedReplyPrefix(text.slice(0,i));assert(next.startsWith(previous));previous=next;}
});
test('quotes, markup, documents and voice are not exposed half-finished',()=>{
 assert.equal(completedReplyPrefix('他说“好。'),'');assert.equal(completedReplyPrefix('他说“好。”后面还'),'他说“好。”');
 assert.equal(completedReplyPrefix('**抱抱。'),'');assert.equal(completedReplyPrefix('**抱抱。** 还有'),'**抱抱。**');
 assert.equal(completedReplyPrefix('*抱抱。'),'');assert.equal(completedReplyPrefix('价格 3.14 还没完'),'');
 assert.equal(completedReplyPrefix('先看这里。\n\n```js\nconst value="还没写完。'),'先看这里。');
 assert.equal(completedReplyPrefix('[语音]\n宝宝，我在呢。'),'');
});
test('terminal content, user messages and original records are preserved',()=>{
 const messages=[{role:'assistant',status:'pending',content:'第一句。第二'}, {role:'assistant',status:'sent',content:'没有标点也保留'}, {role:'assistant',status:'failed',content:'中断的原话'}, {role:'user',status:'pending',content:'用户自己的输入'}];
 const copy=structuredClone(messages),result=deliverMobileMessages(messages);
 assert.equal(result[0].content,'第一句。');assert.deepEqual(result.slice(1),messages.slice(1));assert.deepEqual(messages,copy);
});
test('actual mobile Worker history endpoint buffers pending assistant sentences',async()=>{
 const messages=[{id:'pending',role:'assistant',status:'pending',content:'完整的一句。未完成'}, {id:'done',role:'assistant',status:'sent',content:'最终原文无截断'}];
 const worker=createWorker(async()=>({id:'owner',role:'owner'}));
 const response=await worker.fetch(new Request('https://luma.test/api/messages?conversationId=c'),{LUMA_RELAY_TOKEN:'a'.repeat(64),LUMA_RELAY:{fetch:async()=>Response.json({messages})}});
 assert.equal(response.status,200);const body=await response.json();assert.equal(body.messages[0].content,'完整的一句。');assert.equal(body.messages[1].content,'最终原文无截断');assert.equal(messages[0].content,'完整的一句。未完成');
});
