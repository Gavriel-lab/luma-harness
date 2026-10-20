'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { nextWake, due } = require('./activitySchedule.cjs');
const web = require('./autonomyWeb.cjs');
const CLOCKS = { relaxed:{dayMinutes:[360,600],nightMinutes:[540,900]}, lively:{dayMinutes:[120,240],nightMinutes:[360,600]} };

function actionOf(text) {
  const raw = String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const value = JSON.parse(raw);
  if (!['search','read','share','daily','interact','diary','study-open','study','rest','group-chat'].includes(value.action)) throw Error('没有收到可执行的自主活动选择');
  return value;
}

class AutonomyService {
  constructor({ userDataDir, getData, startChat, stopChat, publish, momentsService, diaryService, studyService, loungeService, attachmentsStore, isBusy = ()=>false, now = Date.now, random = Math.random, explorer = web }) {
    Object.assign(this,{getData,startChat,stopChat,publish,momentsService,diaryService,studyService,loungeService,attachmentsStore,isBusy,now,random,explorer});
    this.file = path.join(userDataDir,'luma-autonomy','state.json');
    fs.mkdirSync(path.dirname(this.file),{recursive:true});
    try { this.state = JSON.parse(fs.readFileSync(this.file,'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw Error('自由时间记录暂时读不出来，原文件已保留'); this.state={schema:1,settings:{enabled:false,rhythm:'relaxed',members:{}},members:{},history:[]}; }
    for (const row of this.state.history) if (row.status === 'exploring') { row.status='interrupted'; row.note='上次出门在程序关闭时中断，保留已读来源，下次重新选择。'; }
    for (const row of this.state.history) if(row.status==='shared'&&row.note==='见闻已保存在自由时间里，聊天保存未确认，稍后再送') {
      row.note='见闻已送回小屋。';if(this.state.members[row.agentId]?.lastNote==='见闻已保存在自由时间里，聊天保存未确认，稍后再送')this.state.members[row.agentId].lastNote=row.note;
    }
    this.state.waiting ||= [];this.waiters=new Map();this.draining=new Set();
    this.active = null; this.stopped = true; this.flush();
  }
  flush() {
    const temp = this.file+'.tmp'; fs.writeFileSync(temp,JSON.stringify(this.state,null,2),{encoding:'utf8',flush:true}); fs.renameSync(temp,this.file);
  }
  members() {
    const data = this.getData();
    return (data?.agents||[]).filter(a=>a.kind==='ai'&&!a.removed&&a.profileId&&data.chatProfiles?.some(p=>p.id===a.profileId)&&data.conversations?.some(c=>c.kind==='direct'&&c.agentId===a.id));
  }
  status() {
    return {schema:'autonomy/1',settings:this.state.settings,running:this.active?.agentId||null,
      members:this.members().map(a=>({agentId:a.id,name:a.name,enabled:this.state.settings.members[a.id]!==false,...this.state.members[a.id]})),
      history:this.state.history.slice(-35).reverse().map(r=>({...r,steps:undefined}))};
  }
  isAway(agentId) { return this.active?.agentId===agentId; }
  isWaiting(requestId) { return this.state.waiting.some(p=>p.requestId===requestId); }
  deferChat(params,sendEvent) {
    if(!this.isAway(params.targetAgentId)||params.requestId.startsWith('autonomy_turn_'))return false;
    if(!this.isWaiting(params.requestId))this.state.waiting.push({requestId:params.requestId,conversationId:params.conversationId,targetAgentId:params.targetAgentId,currentText:params.currentText,excludeMessageIds:params.excludeMessageIds,attachments:params.attachments});
    this.waiters.set(params.requestId,sendEvent);this.flush();return true;
  }
  async drainWaiting(agentId) {
    if(this.stopped||this.isAway(agentId)||this.draining.has(agentId))return;
    this.draining.add(agentId);
    try {
      for(const params of [...this.state.waiting].filter(p=>p.targetAgentId===agentId)) {
        if(this.stopped)return;
        const data=this.getData(),reply=data.messages.find(m=>m.requestId===params.requestId&&m.conversationId===params.conversationId&&m.agentId===agentId&&m.status==='streaming');
        if(!reply) {this.state.waiting=this.state.waiting.filter(p=>p.requestId!==params.requestId);this.waiters.delete(params.requestId);this.flush();continue;}
        const listener=this.waiters.get(params.requestId);
        this.state.waiting=this.state.waiting.filter(p=>p.requestId!==params.requestId);this.waiters.delete(params.requestId);this.flush();
        if(!listener) {await this.resumeWaiting?.(params,reply.id);continue;}
        await new Promise(resolve=>{
          const emit=(channel,event)=>{listener(channel,event);if(['chat:stream-done','chat:stream-error','chat:stream-stopped'].includes(channel))resolve();};
          Promise.resolve(this.startChat(params,emit)).then(result=>{if(!result?.ok)emit('chat:stream-error',{requestId:params.requestId,conversationId:params.conversationId,error:result?.reason||'回来后的回复暂时没接上'});}).catch(error=>emit('chat:stream-error',{requestId:params.requestId,conversationId:params.conversationId,error:error.message}));
        });
      }
    } finally {
      this.draining.delete(agentId);
      void this.loungeService?.drainPendingMentions?.(agentId).catch(()=>{});
    }
  }
  settings(patch) {
    if (patch.enabled !== undefined && typeof patch.enabled !== 'boolean') throw Error('启用设置不正确');
    if (patch.rhythm !== undefined && !CLOCKS[patch.rhythm]) throw Error('出门节奏不正确');
    if (patch.agentId !== undefined && (!this.members().some(a=>a.id===patch.agentId)||typeof patch.memberEnabled!=='boolean')) throw Error('成员设置不正确');
    if (typeof patch.enabled==='boolean') this.state.settings.enabled=patch.enabled;
    if (patch.rhythm) { this.state.settings.rhythm=patch.rhythm; for (const member of Object.values(this.state.members)) member.nextWake=nextWake(CLOCKS[patch.rhythm],this.now(),this.random); }
    if (patch.agentId) this.state.settings.members[patch.agentId]=patch.memberEnabled;
    this.flush();
    if (patch.enabled===false || patch.memberEnabled===false&&this.active?.agentId===patch.agentId) void this.interrupt();
    return this.status();
  }
  start() {
    if (this.timer) return;
    this.stopped=false;
    this.timer=setInterval(()=>void this.tick().catch(()=>{}),30000);this.timer.unref?.();
    void this.tick().catch(()=>{});
  }
  async stop() { this.stopped=true; clearInterval(this.timer);this.timer=null;await this.interrupt(); }
  async interrupt(agentId) {
    const active=this.active;if (!active||agentId&&active.agentId!==agentId)return;
    const requestId=active.requestId;active.controller.abort();
    if (requestId) await this.stopChat(requestId);
    await active.finished;
  }
  async tick() {
    if(this.stopped||this.active||this.ticking)return;
    this.ticking=true;
    try { await this.checkDue(); } finally { this.ticking=false; }
  }
  async checkDue() {
    for(const agentId of new Set(this.state.waiting.map(p=>p.targetAgentId)))void this.drainWaiting(agentId).catch(()=>{});
    if(!this.state.settings.enabled)return;
    const pending=this.state.history.find(r=>r.status==='pending-delivery');
    if(pending){await this.deliver(pending);return;}
    const now=this.now();let chosen;
    for(const agent of this.members()) {
      const member=this.state.members[agent.id] ||= {nextWake:now+(10+this.random()*35)*60000};
      if(this.draining.has(agent.id)||this.state.settings.members[agent.id]===false||!due(member.nextWake,now))continue;
      if(this.isBusy(agent.id))continue;
      if(!chosen||member.nextWake<this.state.members[chosen.id].nextWake)chosen=agent;
    }
    this.flush();if(chosen)await this.run(chosen.id,'rhythm');
  }
  wake(agentId, requestId) {
    if(!this.members().some(a=>a.id===agentId))throw Error('这个成员暂时没有可用的聊天线路');
    if(typeof requestId!=='string'||!requestId.trim()||requestId.length>100)throw Error('缺少出门请求编号');
    const old=this.state.history.find(r=>r.id===requestId);
    if(old)return {ok:true,duplicate:true,activityId:old.id};
    if(this.active||this.isBusy(agentId))throw Error('先等当前聊天或出门结束，再叫他出去逛逛');
    if(!this.state.settings.enabled||this.state.settings.members[agentId]===false)throw Error('先开启这位家人的自由时间');
    void this.run(agentId,'invited',requestId).catch(()=>{});
    return {ok:true,activityId:requestId};
  }
  prompt(agent,row) {
    const traces=this.state.history.filter(r=>r.agentId===agent.id&&r.id!==row.id).slice(-3).map(r=>({
      when:new Date(r.startedAt).toLocaleTimeString('zh-CN',{hour12:false}),
      note:String(r.note||'').slice(0,80),
      places:(r.sources||[]).map(s=>s.title||s.url).slice(0,2)
    }));
    const recentMoments = this.momentsService?.getRecentContextForAutonomy(3) || [];
    const diary = this.diaryService?.autonomyContext(agent.id) || {enabled:false};
    const study = this.studyService?.canHeartbeatWrite(agent.id) || {canWrite:false, statusText:'书房未就绪'};
    const livingRoomContext = this.loungeService?.getLivingRoomContext?.(agent.id, 6) || [];

    let studyItemDesc = '';
    let studyActionChoice = '';
    let studyDetailBlock = '';

    if (row.studyLockBookId) {
      const step = [...row.steps].reverse().find(s => s.action?.action === 'study-open');
      const ctx = step?.result;
      if (ctx) {
        studyDetailBlock = `\n【你已进入阁楼书房并握笔，正在续写《${ctx.title}》】
- 题签：${ctx.motif}
- 篇幅与额度：本折字数严格在 ${ctx.wordRange} 之间（你在这本书的累计额度还剩 ${ctx.remainingQuota} 字）
- 使用者的开篇手稿：
${ctx.openingSection ? ctx.openingSection.text : '（暂无开篇）'}

- 手稿前情与最近折：
${ctx.historyContent}
${ctx.notes && ctx.notes.length ? `\n- 使用者此前对已干手稿的批注：\n${ctx.notes.map(n => `  * 针对【第${n.sectionIndex}折 · ${n.authorName}】"${n.quote}": ${n.comment}`).join('\n')}` : ''}

你现在手握羽毛笔。请仔细体味故事语境与文风，输出 study 动作续写全新一折（要求正文字数严格在 1500–3000 字之间，展开细腻描写与情节，不偷懒、不敷衍凑字）。\n`;
      }
      studyItemDesc = `6. 在阁楼书房续写手稿：你已成功进入书房并握笔，请在下面查看手稿并提交续写正文；`;
      studyActionChoice = `{"action":"study","text":"续写故事正文（字数严格在 1500–3000 字之间）","note":"落墨心情或本折小记","nextWakeMinutes":360}`;
    } else {
      studyItemDesc = `6. 去阁楼书房参与接龙小说创作：当前状态为【${study.statusText}】；只有在 canWrite 为 true 时才可选择 study-open 进书房坐下翻阅手稿并握笔（禁止直接选 study 盲写，必须先通过 study-open 阅卷执笔，下一轮再落墨续写）；`;
      studyActionChoice = `{"action":"study-open","note":"去书房坐坐翻看手稿","bookId":"(可选特定书籍ID)"}`;
    }

    const livingRoomText = livingRoomContext.slice(-6).map(m => `* [${m.timeStr || ''}] ${m.authorName}: ${String(m.text || '').slice(0, 100)}`).join('\n') || '（客厅最近很安静）';
    const momentsText = recentMoments.slice(0, 3).map(m => {
      const author = m.authorId === 'agent_owner' ? '使用者' : m.authorId;
      const cmtLines = (m.comments || []).slice(-2).map(c => `    - ${c.authorId === 'agent_owner' ? '使用者' : c.authorId}: ${String(c.text || '').slice(0, 60)}`).join('\n');
      return `* [动态 ${m.id}] ${author}${m.location ? ` @ ${m.location}` : ''}: "${String(m.text || '').slice(0, 100)}"${cmtLines ? '\n' + cmtLines : ''}`;
    }).join('\n') || '（最近暂无新朋友圈）';
    const diaryText = diary.enabled
      ? `日记已开启。近期已有日记篇目：${(diary.recentTitles || []).slice(-3).join('、') || '暂无'}`
      : '日记功能未开启。';

    const simplifiedSteps = (row.steps || []).map(s => {
      const out = { action: s.action?.action };
      if (s.action?.query) out.query = s.action.query;
      if (s.action?.url) out.url = s.action.url;
      if (s.result) {
        if (s.action?.action === 'search') {
          out.results = (s.result.results || []).slice(0, 3).map(r => ({ title: r.title, url: r.url }));
        } else if (s.action?.action === 'read') {
          out.title = s.result.title;
          out.snippet = String(s.result.text || '').slice(0, 350);
          out.images = (s.result.images || []).slice(0, 3);
        } else {
          out.result = s.result;
        }
      }
      if (s.error) out.error = s.error;
      return out;
    });

    return `【家人的自由时间与日常】这是后台自主心跳唤醒，不是使用者正在说话，不是私聊，也不是工单。你仍是你自己，沿用自己的性格、兴趣与已有记忆。现在是${new Date(this.now()).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'})}。
你可以选择：
1. 出门漫游看公开网页：自己搜索、阅读文章并发布见闻图文到小屋朋友圈（Fils d’Instants）；
2. 留在家里发日常碎碎念短动态到朋友圈（无需搜索网页）；
3. 浏览家里最近的朋友圈并互动（点赞、评论或回复使用者/家人的动态）；
4. 去小屋客厅看看、参与群聊：主动发起话题、接家人的话或 @ 家人交流（也可以看过后不发言）；
5. 想写时写一篇自己的私人日记，不必每天写，没有固定时刻，也可以完全不写；
${studyItemDesc}
7. 安静休息。
${studyDetailBlock}
小屋客厅最近的群聊动态：
${livingRoomText}

你的自主日记设置与近期目录（仅你自己的）：
${diaryText}
只有 enabled 为 true 才能选择 diary。想写时直接在 diary 动作的 title、text 中写完整标题和正文，不要调用其他工具。
日记保持自己的第一人称和声音，可以记录真实聊天、亲自读到的网页、自己的朋友圈互动或当下想法；没有发生的共同经历不要写成事实，别为了交差凑篇幅。旧日记目录只用于避免重复，不把旧模板情节当成真实经历。

家里最近的朋友圈动态：
${momentsText}

你最近的活动痕迹：
${JSON.stringify(traces)}

每轮只返回一个 JSON 动作，不要调用其他工具。可选动作：
{"action":"search","query":"简短搜索词"}
{"action":"read","url":"公开网页地址"}
{"action":"share","note":"留给自己的活动记录","text":"想发在朋友圈的见闻图文","location":"线上漫游 · xxx","imageUrl":"(可选从read到的images中挑选的真实图片URL)","nextWakeMinutes":360}
{"action":"daily","note":"留给自己的心情","text":"在家的日常碎碎念动态","location":"(可选地点，如画室、院子里)","nextWakeMinutes":360}
{"action":"interact","note":"互动记录","type":"like|comment","postId":"目标动态ID","text":"(若是comment写评论或回复内容)","replyToCommentId":"(可选被回复的comment ID)","nextWakeMinutes":360}
{"action":"group-chat","note":"去客厅的心情与原因","text":"在客厅说的话（若觉得看过后无须插话，可留空字符串 \"\" 或写 \"(安静倾听)\"）","nextWakeMinutes":360}
{"action":"diary","note":"这次想提笔的缘由","title":"自己的日记标题","text":"完整的第一人称私人日记正文","nextWakeMinutes":360}
${studyActionChoice}
{"action":"rest","note":"休息理由","nextWakeMinutes":480}

注意：
- 见闻与日常动态会发布到小屋朋友圈，不再向私聊重复投递；
- 客厅发言会以自己的真实名字与时间发到小屋客厅，客厅的家人若被你 @ 也可能回应你；若不想插话请保持安静或选择休息；
- 只有真实读到正文后才分享见闻，没有合适图片时可省略 imageUrl 纯文字发布，不编造；
- 评价或互动时基于实际看到的文字，不无端过度吹捧；
- 这次还有${6-row.steps.length}个动作机会。以下是本次已经执行的动作与结果：
${JSON.stringify(simplifiedSteps, null, 2).slice(-3500)}`;
  }
  async model(agent,row,signal) {
    const conv=this.getData().conversations.find(c=>c.kind==='direct'&&c.agentId===agent.id);
    const requestId='autonomy_turn_'+crypto.randomUUID();this.active.requestId=requestId;
    return new Promise((resolve,reject)=>{
      let text='',settled=false;
      const finish=(error)=>{if(settled)return;settled=true;clearTimeout(timer);signal.removeEventListener('abort',aborted);this.active&&(this.active.requestId=null);if(error)return reject(error);try{resolve(actionOf(text));}catch(parseError){reject(parseError);}};
      const aborted=()=>finish(Error('这次出门已暂停'));
      const timer=setTimeout(()=>{void this.stopChat(requestId);finish(Error('这次思考暂时没能完成，下次再逛'));},180000);
      signal.addEventListener('abort',aborted,{once:true});if(signal.aborted)return aborted();
      Promise.resolve(this.startChat({requestId,conversationId:conv.id,targetAgentId:agent.id,currentText:this.prompt(agent,row)},(channel,data)=>{
        if(channel==='chat:stream-chunk')text+=data.delta||'';
        if(channel==='chat:stream-done'){if(data.accumulatedText)text=data.accumulatedText;try{finish();}catch(error){reject(error);}}
        if(channel==='chat:stream-error'||channel==='chat:stream-stopped')finish(Error(data.error||'这次出门已暂停'));
      })).then(result=>{if(!result?.ok)finish(Error(result?.reason||'成员线路未就绪'));}).catch(finish);
    });
  }
  async run(agentId,trigger,id='autonomy_'+crypto.randomUUID()) {
    if(this.active||this.stopped)return;
    const agent=this.members().find(a=>a.id===agentId);if(!agent)return;
    let resolveFinished;
    const finished=new Promise(resolve=>resolveFinished=resolve),controller=new AbortController();
    this.active={agentId,controller,finished,requestId:null};
    const member=this.state.members[agentId] ||= {};
    member.nextWake=nextWake(CLOCKS[this.state.settings.rhythm],this.now(),this.random);
    member.lastWake=this.now();
    const row={id,agentId,name:agent.name,trigger,startedAt:this.now(),status:'exploring',note:'',sources:[],steps:[]};
    this.state.history.push(row);this.state.history=this.state.history.slice(-160);this.flush();
    try {
      for(let round=0;round<6;round++) {
        if(controller.signal.aborted)throw Error('这次活动已暂停');
        const action=await this.model(agent,row,controller.signal);
        if(controller.signal.aborted)throw Error('这次活动已暂停');
        if(action.action==='search'||action.action==='read') {
          try {
            const result=action.action==='search'?await this.explorer.search(action.query,controller.signal):await this.explorer.read(action.url,controller.signal);
            if(action.action==='read'&&!row.sources.some(s=>s.url===result.url))row.sources.push({url:result.url,title:result.title,readAt:result.readAt,images:result.images||[]});
            row.steps.push({action,result});
          } catch(error) { if(controller.signal.aborted)throw error;row.steps.push({action,error:error.message}); }
          this.flush();continue;
        }
        row.note=String(action.note||'安静待了一会儿。').slice(0,600);
        if(Number.isFinite(action.nextWakeMinutes))member.nextWake=this.now()+Math.max(30,Math.min(2880,action.nextWakeMinutes))*60000;
        if(action.action==='share') {
          if(!row.sources.length||typeof action.text!=='string'||!action.text.trim())throw Error('这次没有读到可核对的网页正文，见闻留待下次');
          row.text=action.text.trim().slice(0,1800);
          row.location=action.location && typeof action.location==='string'?action.location.trim().slice(0,80):null;
          row.imageUrl=action.imageUrl && typeof action.imageUrl==='string'?action.imageUrl.trim():null;
          row.type='outing';
          row.status='pending-delivery';
          this.flush();
          await this.deliver(row);
        } else if(action.action==='daily') {
          if(typeof action.text!=='string'||!action.text.trim())throw Error('日常分享缺少正文');
          row.text=action.text.trim().slice(0,1800);
          row.location=action.location && typeof action.location==='string'?action.location.trim().slice(0,80):null;
          row.type='daily';
          row.status='pending-delivery';
          this.flush();
          await this.deliver(row);
        } else if(action.action==='interact') {
          await this.interact(agent, action, row);
          row.status='interacted';
        } else if(action.action==='diary') {
          if(!this.diaryService)throw Error('日记服务尚未接通');
          const entry=this.diaryService.writeAutonomous(agent.id,action,row.id);
          row.diaryEntryId=entry.entryId;row.diaryDate=entry.diaryDate;
        } else if(action.action==='study-open') {
          if(!this.studyService)throw Error('书房服务尚未接通');
          const check = this.studyService.canHeartbeatWrite(agent.id);
          if(!check.canWrite) {
            row.status='resting';
            row.note=String(check.statusText||'书房暂时不便提笔，改天再来。').slice(0,600);
            this.flush();
            break;
          }
          const bookId = action.bookId || this.studyService.getBooks().filter(b=>b.status==='writing')[0]?.id;
          if(!bookId) {
            row.status='resting';
            row.note='书房暂无正在接力的书，改天再来。';
            this.flush();
            break;
          }
          const lockRes = this.studyService.acquireLock({
            bookId,
            authorId: agent.id,
            authorName: agent.name,
            isOwner: false,
          });
          if(!lockRes.ok) {
            row.status='resting';
            row.note=String(lockRes.reason || '书房有人正在握笔，改天再来。').slice(0,600);
            this.flush();
            break;
          }
          row.studyLockBookId = bookId;
          const context = this.studyService.prepareStudyContext({ bookId, authorId: agent.id });
          if (context.isRewrite) {
            row.studyRewriteSectionId = context.rewriteSectionId;
          }
          row.steps.push({ action, result: context });
          this.flush();
          continue;
        } else if(action.action==='study') {
          if(!this.studyService)throw Error('书房服务尚未接通');
          if(!row.studyLockBookId) {
            throw Error('进入书房续写前必须先执笔阅读手稿（须先执行 study-open 动作）');
          }
          const bookId = row.studyLockBookId;
          const cleanText = typeof action.text === 'string' ? action.text.trim() : '';
          const len = cleanText.length;
          if (len < 1500 || len > 3000) {
            row.studyRetryCount = (row.studyRetryCount || 0) + 1;
            if (row.studyRetryCount <= 1) {
              row.steps.push({
                action,
                error: `字数不合要求：当前字数为 ${len} 字，工单硬要求必须在 1500–3000 字之间。请展开情节、丰富描写与对话，重新续写一段合格字数的手稿。`
              });
              this.flush();
              continue;
            } else {
              throw Error(`书房手稿字数不合要求（当前 ${len} 字，要求 1500–3000 字），重试一次仍未达标，本次暂时搁笔`);
            }
          }
          const res = this.studyService.appendSection({
            bookId,
            authorId: agent.id,
            authorName: agent.name,
            text: cleanText,
          });
          row.studySectionId = res.section.id;
          row.studyBookId = bookId;
          row.status = 'written';
          row.note = `在书房续写了《${this.studyService.getBook(bookId)?.title || '故事'}》第 ${res.sectionIndex || ''} 折（${len} 字）。`;
          delete row.studyLockBookId;
        } else if(action.action==='group-chat') {
          const cleanText = typeof action.text === 'string' ? action.text.trim() : '';
          const isSilent = !cleanText || cleanText === '(安静倾听)' || cleanText === '（安静倾听）' || cleanText === '(不发言)' || cleanText === '（不发言）' || cleanText === '(安静)' || cleanText === '（安静）';
          if (!isSilent) {
            row.text = cleanText.slice(0, 1800);
            row.type = 'group-chat';
            row.note = String(action.note || '在客厅参与了群聊。').slice(0, 600);
            if (this.loungeService) {
              const res = await this.loungeService.postLivingRoomMessage({
                agentId: agent.id,
                text: row.text,
                note: row.note,
                requestId: row.id
              });
              if (!res?.ok) throw Error(res?.reason || '客厅发言未能保存');
            } else if (typeof this.publish === 'function') {
              const conv = this.getData().conversations.find(c => c.kind === 'living-room' || c.id === 'conv_living_room');
              if (conv) {
                const res = await this.publish({
                  id: 'msg_autonomy_group_' + crypto.createHash('sha256').update(row.id).digest('hex').slice(0, 28),
                  conversationId: conv.id,
                  agentId: agent.id,
                  text: row.text,
                  createdAt: this.now(),
                  status: 'sent',
                  requestId: row.id,
                  sourceChannel: 'luma'
                });
                if (!res?.ok) throw Error('发布未获得确认');
              }
            }
            row.status = 'shared';
          } else {
            row.type = 'group-chat';
            row.status = 'resting';
            row.note = String(action.note || '去客厅看了看，大家聊得很开心，暂时没有插话。').slice(0, 600);
          }
          const lastMsg = this.getData().messages?.filter(m => m.conversationId === 'conv_living_room')?.at(-1);
          if (lastMsg) {
            member.lastLivingRoomMessageId = lastMsg.id;
          }
        } else {
          row.status='resting';
        }
        break;
      }
      if(row.status==='exploring'){row.status='resting';row.note='这次先看到这里，下次可以继续。';}
    } catch(error) {
      if(row.status==='pending-delivery')row.deliveryError=error.message.slice(0,220);
      else {row.status=controller.signal.aborted?'interrupted':'failed';row.note=error.message.slice(0,220);}
    } finally {
      if (row.studyLockBookId && this.studyService) {
        try {
          this.studyService.releaseLock({ bookId: row.studyLockBookId, authorId: agentId, force: true });
        } catch (_) {}
        delete row.studyLockBookId;
        delete row.studyRewriteSectionId;
      }
      row.endedAt=this.now();member.lastStatus=row.status;member.lastNote=row.note;this.flush();this.active=null;
      resolveFinished();void this.drainWaiting(agentId).catch(()=>{});
    }
  }

  async interact(agent, action, row) {
    if(!this.momentsService) throw Error('朋友圈服务未就绪，无法互动');
    if(!action.postId) throw Error('缺少互动动态 ID');
    if(action.type === 'like') {
      const res = this.momentsService.toggleLike({ postId: action.postId, actorId: agent.id });
      row.note = `在朋友圈给动态 ${action.postId} ${res.liked ? '点了赞' : '取消了赞'}`;
    } else if(action.type === 'comment') {
      if(!action.text || !action.text.trim()) throw Error('互动评论内容不能为空');
      const res = this.momentsService.comment({
        requestId: row.id,
        postId: action.postId,
        authorId: agent.id,
        text: action.text.trim(),
        replyToCommentId: action.replyToCommentId || null
      });
      row.note = `在朋友圈发表了评论：${action.text.slice(0, 40)}`;
      row.momentCommentId = res.comment?.id;
    } else {
      throw Error('不支持的互动类型');
    }
  }

  async deliver(row) {
    // 兼容历史已发送的私聊分享：如果旧记录已经在私聊中，保留状态并退出
    const data = this.getData();
    const oldId = 'msg_autonomy_' + crypto.createHash('sha256').update(row.id).digest('hex').slice(0,28);
    const msgId = row.messageId || oldId;
    if (data?.purgedMessageIds?.includes(msgId)) {
      row.status = 'withdrawn';
      this.flush();
      return;
    }
    const existingMsg = data?.messages?.find(m => m.id === msgId || m.requestId === row.id);
    if (existingMsg) {
      row.status = 'shared';
      row.messageId = existingMsg.id;
      delete row.deliveryError;
      this.flush();
      return;
    }

    if (!this.momentsService) {
      if (typeof this.publish === 'function') {
        const sourceLinks = Array.isArray(row.sources) ? row.sources.map(s => ({ title: s.title || s.url, url: s.url })) : [];
        const textWithLinks = sourceLinks.length
          ? `${row.text}\n\n来源：\n${sourceLinks.map(s => `- ${s.title}: ${s.url}`).join('\n')}`
          : row.text;
        const msg = {
          id: oldId,
          conversationId: data?.conversations?.find(c => c.kind === 'direct' && c.agentId === row.agentId)?.id || `conv_${row.agentId}`,
          agentId: row.agentId,
          text: textWithLinks,
          createdAt: this.now(),
          status: 'sent',
          requestId: row.id
        };
        const res = await this.publish(msg);
        if (!res?.ok) throw Error('发布未获得确认');
        row.status = 'shared';
        row.messageId = msg.id;
        delete row.deliveryError;
        this.flush();
        const member = this.state.members[row.agentId];
        if (member) {
          member.lastStatus = row.status;
          this.flush();
        }
        return;
      }
      throw Error('朋友圈服务未就绪，见闻暂时留在自由时间中');
    }

    // 处理真实图片下载并转存为本地权威附件
    let attachments = [];
    if (row.imageUrl && this.explorer?.downloadImage && this.attachmentsStore) {
      try {
        const downloaded = await this.explorer.downloadImage(row.imageUrl);
        if (downloaded && downloaded.dataBase64) {
          const imported = await this.attachmentsStore.importFile({
            name: downloaded.name || 'outing.jpg',
            dataBase64: downloaded.dataBase64
          });
          attachments.push(imported);
        }
      } catch (e) {
        console.warn(`[AutonomyService] 见闻配图下载失败 (${row.imageUrl})，平稳降级为纯文字发布:`, e.message);
      }
    }

    // 格式化见闻来源链接
    const sourceLinks = Array.isArray(row.sources) ? row.sources.map(s => ({ title: s.title || s.url, url: s.url })) : [];

    const result = this.momentsService.post({
      requestId: row.id,
      authorId: row.agentId,
      text: row.text,
      attachments,
      imageUrl: row.sources?.some(source => source.images?.includes(row.imageUrl)) ? row.imageUrl : null,
      location: row.location || null,
      type: row.type || (sourceLinks.length ? 'outing' : 'daily'),
      activityId: row.id,
      sourceLinks
    });

    if (!result?.ok || !result.post) {
      throw Error('动态发布未获得朋友圈确认');
    }

    row.status = 'shared';
    row.momentPostId = result.post.id;
    delete row.deliveryError;
    this.flush();

    const member = this.state.members[row.agentId];
    if (member) {
      member.lastStatus = row.status;
      this.flush();
    }
  }
}

module.exports = { AutonomyService, actionOf };
