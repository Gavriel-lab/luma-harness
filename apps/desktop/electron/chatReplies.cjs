'use strict';

// One presentation rule shared by desktop, phone and the authoritative prompt.
// Splits are views of one original message: never write new rows or trim its text.
const replyInstructions = `【聊天表达】按使用者本轮的真实意图决定详略，不要求她切换模式。
日常闲聊像熟人随口接话：每位成员本轮全部回复正文合计不超过50字，含标点和表情，换行与[语音]标签不计；这是整轮总数，不是每段50字。通常一两句就够，按完整意思用空行分成1到3段，对应最多3个气泡；能一段说完就一段，不凑满三段，不把表情单独凑成一泡。
生成前先挑最想接住的一点，想好能在50字内说完再开口；发送前检查总字数，超长就自己改短。不要复述全场、逐条回应、接龙补充、重复解释或写总结；不堆动作和修饰，不为了显得热闹加反问。保持每个人自己的性格和自然口气，不把长文换行后当短回复。
询问工作、项目、技术、方案、办事步骤等，或明确要求详细解释、长文、创作时，正常完整回答，保留必要的段落、清单、代码和细节，不受日常短句限制。
不要仅因提到“工作”就写报告：例如下班累了、分享心情仍是日常闲聊。延续工作问题的简短追问仍正常回答。保持自己的性格和语气，不输出模式标签或气泡编号。
【消息形式】你可以自然选择文字或语音，按内容、语气和使用者的意愿决定，不必每次发语音，也不因她发语音就必须语音回答。想亲口说的一段话可以用语音；适合阅读的清单、代码、工作细节可以用文字。这是建议，不是固定分类。
选择语音时，只在整条回复最开头独立写一行 [语音]，下一行开始是要说的完整话。选择文字时直接回复。不要解释这次选择，不输出其他形式标签；尊重使用者本轮明确要求。`;

function replyMedium(text) { return /^\s*\[语音\](?:\s|$)/u.test(String(text || '')) ? 'voice' : 'text'; }
function replyText(text) { return replyMedium(text) === 'voice' ? String(text).replace(/^\s*\[语音\]\s*/u, '') : text; }

function isWorkTopic(text, previous = false) {
  const s = String(text || '').trim();
  if (/```|~~~/.test(s)) return true;
  if (/(详细(?:说|讲|解释|介绍|分析|写)|展开(?:讲|说|解释)|完整(?:版|内容|回复|原文)|逐步|长文|写.{0,10}(故事|小说|文章|文案|邮件|报告|诗|信)|不要.{0,4}(拆|分|短句))/.test(s)) return true;
  const subject = /(项目|需求|工单|交付|验收|方案|报告|会议|客户|合同|报价|预算|发票|薪资|面试|简历|工作|业务|产品|设计|界面|页面|气泡|壁纸|记忆库|同步|数据库|代码|编程|程序|接口|API|模型|浏览器|部署|上线|报错|故障|bug|服务器|客户端|配置|安装|架构|缓存|权限|登录|上传|文件|教程|排期|算法|脚本|测试)/i;
  const ask = /(怎么|如何|为什么|为啥|咋|哪|什么|多少|是否|能不能|可不可以|能否|可以.{0,12}吗|帮我|请|检查|看看|分析|解决|修复|修改|优化|实现|接入|接上|改成|加.{0,8}(选项|功能|按钮)|做.{0,12}(方案|功能|系统)|建议|有什么|问题|不见|失败|不行|打不开|没.{0,5}(生效|作用))/;
  if (subject.test(s) && ask.test(s)) return true;
  // Short follow-ups inherit only the preceding turn, never a sticky work mode.
  return previous && /^(?:那|嗯|好|好的|行|助手|宝宝|所以|可是|但是|然后|现在|接下来|再|请|你|我们|这|它|要|该|到底|到底要|还能|能不能|为什么|为啥|怎么办|继续|下一步|具体|讲|说|解释|补充|展开|还有|对|是的|不对|这样|呢|啊|呀|哦|吧|了|做|呢|[\s，,。.!！?？~～]){1,30}$/.test(s);
}

function replyModes(rows) {
  const modes = new Map(), byRequest = new Map(), previous = new Map();
  const textOf = m => m.text ?? m.content ?? '';
  const user = m => m.isUser === true || m.role === 'user' || m.agentId === 'agent_owner' || m.senderId === 'user';
  const lane = m => `${m.conversationId || ''}:${m.sourceChannel || (/^(?:req_)?xiaodu_/.test(m.requestId || '') ? 'xiaodu' : 'luma')}`;
  for (const m of rows) {
    if (!user(m)) continue;
    const key = lane(m), work = isWorkTopic(textOf(m), previous.get(key) || false);
    modes.set(m.id, work); previous.set(key, work);
    if (m.requestId) byRequest.set(`${key}:${m.requestId}`, work);
  }
  previous.clear();
  for (const m of rows) {
    const key = lane(m);
    if (user(m)) previous.set(key, modes.get(m.id));
    else modes.set(m.id, byRequest.get(`${key}:${m.requestId}`) ?? previous.get(key) ?? false);
  }
  return modes;
}

function splitReply(text, { work = false, preserve = false, legacy = false } = {}) {
  text = replyText(text);
  if (!text || work || preserve) return [text];
  if (Array.isArray(legacy)) {
    const current = splitReply(text);
    return legacy.every(hidden => current.some(part => part.trim() === hidden))
      ? current : splitReply(text, {legacy: true});
  }
  // Documents and Markdown blocks must stay intact, even when the question is vague.
  if (/(^|\n)\s*(?:`{3}|~{3}|#{1,6}\s|[-*+]\s|\d+[.)、]\s*|>|\|)|\$\$|\[[^\]]*\]\(/m.test(text)) return [text];
  const parts = [];
  let start = 0;
  // Include spaces, closing punctuation and Markdown closers in the original slice.
  const boundary = /\n[\t \r]*\n+|[。！？!?；;]+[”’」』）)\]*_]*[\t \r\n]*|\.(?=\s|$)[”’」』）)\]*_]*[\t \r\n]*/g;
  for (const match of text.matchAll(boundary)) {
    const end = match.index + match[0].length;
    const part = text.slice(start, end);
    // Avoid breaking inline emphasis/code or a parenthesized/quoted sentence.
    const singleEmphasis = part.replace(/\*\*|__/g, '');
    const balanced = ['**', '__', '~~', '`', '"'].every(c => part.split(c).length % 2 === 1)
      && ['*', '_'].every(c => singleEmphasis.split(c).length % 2 === 1)
      && [['（','）'],['(',')'],['“','”'],['「','」'],['『','』']].every(([a,b]) => part.split(a).length === part.split(b).length);
    if (!part.trim() || !balanced || (!match[0].includes('\n') && part.trim().length < 42)) continue;
    if (!text.slice(end).trim()) break;
    parts.push(part); start = end;
    // Previously deleted parts are keyed by the old slices; keep their layout.
    if (parts.length === (legacy ? 4 : 2)) break;
  }
  parts.push(text.slice(start));
  return parts;
}

module.exports = { replyInstructions, isWorkTopic, replyModes, splitReply, replyMedium, replyText };
