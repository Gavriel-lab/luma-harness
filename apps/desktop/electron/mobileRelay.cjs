'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const channelRules=require('./chatChannels.cjs');
// The gateway admits 380,000 bytes. Leave room for the request frame envelope.
const MAX_PAYLOAD = 380000;
const MAX_FRAME = 384 * 1024;
const object = v => !!v && typeof v === 'object' && !Array.isArray(v);
const fail = (status, code, message, retryable=false) => ({status, body:{error:{code,message,retryable}}});
const iso = n => new Date(n).toISOString();
const key = requestId => crypto.createHash('sha256').update(requestId).digest('hex');
const messageIds = requestId => ({user:`mobile_user_${key(requestId)}`,reply:`mobile_reply_${key(requestId)}`});

const PROGRESS_KINDS = new Set([
  'queued', 'claimed', 'progress', 'blocked', 'question', 'permission',
  'reported', 'accepted', 'rejected', 'cancelled', 'offline', 'note'
]);
const KIND_MAP = {
  queued: 'queued', dispatch: 'queued', claimed: 'claimed', claim: 'claimed',
  started: 'progress', progress: 'progress', blocked: 'blocked', failed: 'blocked',
  question: 'question', permission: 'permission', permission_required: 'permission',
  reported: 'reported', report: 'reported', submitted: 'reported',
  accepted: 'accepted', accept: 'accepted', rejected: 'rejected', reject: 'rejected',
  cancelled: 'cancelled', cancel: 'cancelled', offline: 'offline', note: 'note'
};
function sanitizePaths(text) {
  if (typeof text !== 'string') return '';
  return text
    .replace(/[A-Za-z]:[\\/][^\s"'`<>|\r\n\t，。！？；：、（）《》【】]+/g, '（本机路径）')
    .replace(/\\\\(?:[^\s"'`<>|\r\n\t，。！？；：、（）《》【】]+)/g, '（本机路径）')
    .replace(/\/(?:Users|home|root|var|etc|opt|tmp|usr|private)[\\/][^\s"'`<>|\r\n\t，。！？；：、（）《》【】]+/g, '（本机路径）');
}

/** An owner-authenticated transport into the existing authoritative desktop chat.
 * It never accepts context, model settings, credentials or client-created replies. */
class MobileRpc {
  constructor({homeId,getData,getRegistrations,startChat,mutate,notify,validateChat,attachmentsStore,store,getSyncService,getMemoryEngine,diaryService,studyService,autonomyService,momentsService,bridgeBroker}) {
    Object.assign(this,{homeId,getData,getRegistrations,startChat,mutate,notify,validateChat,attachmentsStore,store,getSyncService,getMemoryEngine,diaryService,studyService,autonomyService,momentsService,bridgeBroker});
    this.active = new Map();
    this.queue = Promise.resolve();
  }
  route(agent,data) {
    const native = this.getRegistrations()?.[agent.id];
    if(native?.chatEnabled)return {available:true,status:'native',reason:undefined};
    const profile=data.chatProfiles?.find(p=>p.id===agent.profileId);
    const available=agent.mode==='real' && profile && profile.providerType!=='demo';
    return {available:!!available,status:available?'configured':'unavailable',reason:available?undefined:'成员的真实聊天线路尚未启用'};
  }
  async handle(operation,payload={}) {
    if(!object(payload) || Buffer.byteLength(JSON.stringify(payload))>MAX_PAYLOAD)return fail(400,'invalid_payload','请求格式或大小不合法');
    const allowed={
      members:[],
      conversations:[],
      messages:['conversationId','after'],
      'delete-message':['conversationId','messageId','mode','part'],
      chat:['requestId','conversationId','targetAgentId','text','attachments','sourceChannel','eventKind'],
      job:['requestId','jobId'],
      memories:['scopeType','scopeId'],
      'save-memory':['requestId','memoryId','scopeType','scopeId','authorMemberId','title','content','memoryType','tags','triggers','reviewAt','pinned'],
      'sync-status':[],
      'memory-garden':['cursor','limit'],
      'memory-garden-detail':['key'],
      'memory-garden-related':['key'],
      'diary-books':[],
      'owner-journal-read':['date'],
      'owner-journal-save':['date','title','body','baseVersion'],
      'diary-catalog':['agentId','limit','cursor'],
      'diary-entry':['agentId','date','version'],
      'diary-generate':['agentId','date','forceNewVersion'],
      'diary-job':['jobId'],
      'diary-settings-get':[],
      'diary-settings-set':['enabled','scheduleTime','targetAgentIds','autoGenerate'],
      'study-books':[],
      'study-book':['bookId'],
      'study-section':['bookId','sectionId'],
      'study-create':['title','motif','firstSectionText'],
      'study-append':['bookId','text','requestId'],
      'study-annotate':['bookId','sectionId','quote','comment'],
      'study-mark-dry':['bookId','sectionId'],
      'study-prompt-next':['bookId'],
      'study-set-status':['bookId','status'],
      'study-revision':['bookId','sectionId','revisedText'],
      'study-section-hidden':['bookId','sectionId'],
      'study-section-rewrite':['bookId','sectionId'],
      'study-cancel-rewrite':['bookId','sectionId'],
      'autonomy-status':[],
      'autonomy-presence':[],
      'autonomy-settings':['enabled','rhythm','agentId','memberEnabled'],
      'autonomy-wake':['agentId','requestId'],
      'moments-list':['cursor','limit'],
      'moments-post':['requestId','text','attachments','location'],
      'moments-like':['postId'],
      'moments-comment':['requestId','postId','text','replyToCommentId','replyToAuthorId'],
      'moments-delete':['targetType','targetId'],
      'moments-image':['attachmentId'],
      'workbench-snapshot':[]
    }[operation];
    if(!allowed || Object.keys(payload).some(k=>!allowed.includes(k)))return fail(400,'invalid_operation','不支持的操作或字段');
    const data=this.getData();
    if(!data || !data.agents?.some(a=>a.id==='agent_owner'))return fail(503,'authority_unavailable','桌面权威存储尚未就绪',true);
    if(operation.startsWith('moments-')) {
      if(!this.momentsService)return fail(503,'moments_unavailable','朋友圈后台服务尚未就绪',true);
      try {
        if(operation==='moments-list') {
          const body=this.momentsService.list({cursor:payload.cursor,limit:payload.limit,viewerId:'agent_owner'});
          return {status:200,body};
        }
        if(operation==='moments-post') {
          let importedAttachments=[];
          if(Array.isArray(payload.attachments)&&payload.attachments.length>0) {
            if(!this.attachmentsStore)return fail(503,'attachments_unavailable','附件存储服务未就绪',true);
            for(const item of payload.attachments.slice(0,9)) {
              if(!item||typeof item.dataBase64!=='string'||!item.dataBase64)continue;
              const imported=await this.attachmentsStore.importFile({name:item.name||'image.jpg',dataBase64:item.dataBase64});
              importedAttachments.push(imported);
            }
          }
          const result=this.momentsService.post({
            requestId:payload.requestId,
            authorId:'agent_owner',
            text:payload.text||'',
            attachments:importedAttachments,
            location:payload.location||null,
            type:'post'
          });
          return {status:200,body:result};
        }
        if(operation==='moments-like') {
          const result=this.momentsService.toggleLike({postId:payload.postId,actorId:'agent_owner'});
          return {status:200,body:result};
        }
        if(operation==='moments-comment') {
          const result=this.momentsService.comment({
            requestId:payload.requestId,
            postId:payload.postId,
            authorId:'agent_owner',
            text:payload.text,
            replyToCommentId:payload.replyToCommentId||null,
            replyToAuthorId:payload.replyToAuthorId||null
          });
          return {status:200,body:result};
        }
        if(operation==='moments-delete') {
          const result=payload.targetType==='comment'
            ? this.momentsService.deleteComment({commentId:payload.targetId,actorId:'agent_owner'})
            : this.momentsService.deletePost({postId:payload.targetId,actorId:'agent_owner'});
          return {status:200,body:result};
        }
        if(operation==='moments-image') {
          const preview=this.momentsService.getAttachmentPreview(payload.attachmentId,true);
          return {status:200,body:{ok:true,dataUrl:preview?.dataUrl||null}};
        }
      } catch(err) {
        return fail(400,'moments_error',err.message,false);
      }
    }
    if(operation.startsWith('autonomy-')) {
      if(!this.autonomyService)return fail(503,'autonomy_unavailable','自由时间后台还没接通',true);
      try {
        const body=operation==='autonomy-presence'?{running:this.autonomyService.active?.agentId||null}:operation==='autonomy-status'?this.autonomyService.status():operation==='autonomy-settings'?this.autonomyService.settings(payload):this.autonomyService.wake(payload.agentId,payload.requestId);
        return {status:200,body};
      } catch(error){return fail(409,'autonomy_not_ready',error.message,true);}
    }
    if(operation==='delete-message') {
      const run=async()=>{
        const current=this.getData(), target=current.messages.find(m=>m.id===payload.messageId&&m.conversationId===payload.conversationId);
        if(!['hide','purge'].includes(payload.mode)||typeof payload.messageId!=='string'||typeof payload.conversationId!=='string')return fail(400,'invalid_delete','删除参数不正确');
        if(!target)return current.purgedMessageIds?.includes(payload.messageId)?{status:200,body:{ok:true,saved:true}}:fail(404,'message_not_found','原消息不存在');
        if(target.status==='streaming'||(payload.mode==='purge'&&[...this.active.values()].some(r=>r.conversationId===target.conversationId)))return fail(409,'reply_active','先等当前回复结束再删除');
        if(payload.part!==undefined) {
          const rules=require('./chatReplies.cjs');
          const parts=rules.splitReply(target.text,{work:rules.replyModes(current.messages).get(target.id),preserve:target.agentId==='agent_owner'||!!target.attachments?.length});
          if(payload.mode!=='hide'||typeof payload.part!=='string'||!payload.part.trim()||!parts.some(p=>p.trim()===payload.part))return fail(409,'message_changed','气泡内容已变化，请刷新后重新选择');
        }
        const result=await this.mutate({type:'mobile-message-delete',...payload});
        if(!result?.ok||result.applied!==true)return fail(503,'delete_not_saved',result?.reason||'删除尚未保存，请重试',true);
        const after=this.getData(), remaining=after.messages.find(m=>m.id===target.id);
        const applied=payload.mode==='purge'?!remaining&&after.purgedMessageIds?.includes(target.id):payload.part?remaining?.hiddenReplyParts?.includes(payload.part):remaining?.hiddenFromWindow;
        if(!applied)return fail(503,'delete_not_saved','删除未得到权威记录确认，请重试',true);
        return {status:200,body:{ok:true,saved:true}};
      };
      const result=this.queue.then(run,run);this.queue=result.catch(()=>{});return result;
    }
    if(operation==='members')return {status:200,body:{schema:'members/1',homeId:this.homeId,members:data.agents.filter(a=>!a.removed).map(a=>({agentId:a.id,displayName:a.name,kind:a.kind,accent:a.accent,avatarDataUrl:a.avatarDataUrl,...(a.kind==='human'?{available:false,status:'owner'}:this.route(a,data))}))}};
    if(operation==='conversations') {
      const latest=new Map(),preview=new Map();
      for(const message of data.messages) {
        if(message.hiddenFromWindow||message.demo)continue;
        const previous=latest.get(message.conversationId);
        if(!previous||message.createdAt>previous.createdAt||(message.createdAt===previous.createdAt&&message.id>previous.id))latest.set(message.conversationId,message);
        const previousText=preview.get(message.conversationId);
        if(message.text.trim()&&(!previousText||message.createdAt>previousText.createdAt||(message.createdAt===previousText.createdAt&&message.id>previousText.id)))preview.set(message.conversationId,message);
      }
      return {status:200,body:{schema:'conversations/1',homeId:this.homeId,capabilities:{groupChat:true,mentionAll:true},conversations:data.conversations.filter(c=>c.kind==='living-room'||data.agents.some(a=>a.id===c.agentId&&!a.removed)).map(c=>{
        const message=latest.get(c.id),textMessage=preview.get(c.id);
        // Empty streaming placeholders must not hide the user's latest real text.
        return {conversationId:c.id,kind:c.kind==='direct'?'direct':'group',...(c.agentId?{agentId:c.agentId}:{}),title:c.title,updatedAt:iso(message?.createdAt??c.createdAt),...(textMessage?{lastMessage:Array.from(textMessage.text).slice(0,120).join('')}:{})};
      })}};
    }
    if(operation==='messages') {
      const conv=data.conversations.find(c=>c.id===payload.conversationId);
      if(!conv || (conv.agentId&&!data.agents.some(a=>a.id===conv.agentId&&!a.removed)))return fail(404,'conversation_not_found','会话不存在');
      if(payload.after!==undefined&&(typeof payload.after!=='string'||payload.after.length>128))return fail(400,'invalid_cursor','游标格式不合法');
      // Cursor is an authoritative message ID. Sort oldest first with ID as a
      // deterministic tie-break. Missing/deleted cursors recover a full snapshot.
      const ordered=data.messages.filter(m=>m.conversationId===conv.id&&!m.hiddenFromWindow&&!m.demo).sort((a,b)=>a.createdAt-b.createdAt||(a.id<b.id?-1:a.id>b.id?1:0));
      const anchor=payload.after?ordered.findIndex(m=>m.id===payload.after):-1;
      const channels=channelRules.classify(data.messages.filter(m=>m.conversationId===conv.id));
      const messages=(anchor>=0?ordered.slice(anchor+1):ordered).map(m=>({id:m.id,agentId:m.agentId,role:m.agentId==='agent_owner'?'user':'assistant',content:m.text,createdAt:iso(m.createdAt),status:m.status==='sent'?'sent':m.status==='streaming'?'pending':'failed',sourceChannel:channels.get(m.id)?.channel||'luma',...(channels.get(m.id)?.deviceEvent?{eventKind:'device-event'}:{}),...(m.requestId?{requestId:m.requestId}:{}),...(m.error?{error:m.error}:{}),...(Array.isArray(m.attachments)&&m.attachments.length?{attachments:m.attachments}:{})}));
      for(const dto of messages){const source=ordered.find(m=>m.id===dto.id);if(source.hiddenReplyParts?.length)dto.hiddenReplyParts=source.hiddenReplyParts;}
      return {status:200,body:{schema:'messages/1',homeId:this.homeId,conversationId:conv.id,messages,...(ordered.length?{cursor:ordered[ordered.length-1].id}:{})}};
    }
    if(operation==='memories') {
      const scopeType = payload.scopeType;
      const scopeId = payload.scopeId;
      const memories = (data.memories || []).filter(m => {
        if (m.tombstoned || m.deletedAt || m.status === 'deleted' || m.status === 'invalidated') return false;
        if (scopeType && m.scope?.type !== scopeType) return false;
        if (scopeId && m.scope?.id !== scopeId && m.authorAgentId !== scopeId) return false;
        return true;
      }).map(m => ({
        id: m.id,
        scopeType: m.scope?.type || 'direct',
        scopeId: m.scope?.id || null,
        authorAgentId: m.authorAgentId,
        title: m.title || '',
        content: m.content || '',
        memoryType: m.memoryType || 'experience',
        status: m.status || 'active',
        tags: m.tags || [],
        triggers: m.triggers || [],
        pinned: !!m.pinned,
        createdAt: iso(m.createdAt || Date.now()),
        updatedAt: iso(m.updatedAt || m.createdAt || Date.now()),
        version: m.version || 1
      }));
      return { status: 200, body: { schema: 'memories/1', homeId: this.homeId, memories } };
    }
    if(operation==='sync-status') {
      const syncService = this.getSyncService?.();
      const status = syncService ? syncService.getStatus() : { enabled: false, status: 'unavailable' };
      const outbox = Array.isArray(data.cloudSyncOutbox) ? data.cloudSyncOutbox : [];
      const pendingCount = outbox.filter(o => o.status === 'pending').length;
      return {
        status: 200,
        body: {
          schema: 'sync-status/1',
          homeId: this.homeId,
          enabled: status.enabled ?? false,
          status: status.status || 'idle',
          lastSyncTime: status.lastSyncTime || null,
          outboxPending: pendingCount,
          error: status.error || null,
          conflictCount: status.conflictCount || 0,
          memoryEngine: (this.getMemoryEngine?.()?.state) || this.getMemoryEngine?.() || {state:'unavailable'},
          lastCommitSeq: data.cloudSyncConfig?.lastCommitSeq || 0
        }
      };
    }
    if(operation==='memory-garden') {
      const engine = typeof this.getMemoryEngine === 'function' ? this.getMemoryEngine() : null;
      if (!engine || !engine.gardenCatalog) return fail(503, 'memory_engine_unavailable', '记忆引擎尚未就绪', true);
      try {
        const catalog = await engine.gardenCatalog(payload);
        return { status: 200, body: catalog };
      } catch (err) {
        return fail(500, 'garden_read_failed', '记忆目录读取失败：' + (err.message || String(err)));
      }
    }
    if(operation==='memory-garden-detail') {
      const engine = typeof this.getMemoryEngine === 'function' ? this.getMemoryEngine() : null;
      if (!engine || !engine.gardenDetail) return fail(503, 'memory_engine_unavailable', '记忆引擎尚未就绪', true);
      if (!payload.key || typeof payload.key !== 'string') return fail(400, 'invalid_key', '缺少有效的记忆标识');
      try {
        const detail = await engine.gardenDetail(payload);
        return { status: 200, body: detail };
      } catch (err) {
        return fail(500, 'garden_read_failed', '记忆详情读取失败：' + (err.message || String(err)));
      }
    }
    if(operation==='memory-garden-related') {
      const engine = typeof this.getMemoryEngine === 'function' ? this.getMemoryEngine() : null;
      if (!engine || !engine.gardenRelated) return fail(503, 'memory_engine_unavailable', '记忆引擎尚未就绪', true);
      if (!payload.key || typeof payload.key !== 'string') return fail(400, 'invalid_key', '缺少有效的记忆标识');
      try {
        const related = await engine.gardenRelated(payload);
        return { status: 200, body: related };
      } catch (err) {
        return fail(500, 'garden_read_failed', '记忆关联读取失败：' + (err.message || String(err)));
      }
    }
    if(operation==='owner-journal-read'||operation==='owner-journal-save') {
      if(!this.diaryService) return fail(503, 'diary_unavailable', '日记服务尚未就绪', true);
      try {
        const state = operation==='owner-journal-read' ? this.diaryService.getOwnerJournal(payload.date) : this.diaryService.saveOwnerJournal(payload);
        return { status: 200, body: { ok: true, ...state } };
      } catch(error) {
        return fail(error.code==='journal_conflict'?409:400, error.code==='journal_conflict'?'journal_conflict':'journal_failed', error.message || '手记尚未保存');
      }
    }
    if(operation==='diary-books') {
      if(!this.diaryService) return fail(503, 'diary_unavailable', '日记服务尚未就绪', true);
      const res = this.diaryService.getBooks();
      return { status: 200, body: res };
    }
    if(operation==='diary-catalog') {
      if(!this.diaryService) return fail(503, 'diary_unavailable', '日记服务尚未就绪', true);
      if(!payload.agentId) return fail(400, 'missing_agent_id', '缺少成员标识');
      const res = this.diaryService.getCatalog(payload.agentId, { limit: payload.limit, cursor: payload.cursor });
      return { status: 200, body: res };
    }
    if(operation==='diary-entry') {
      if(!this.diaryService) return fail(503, 'diary_unavailable', '日记服务尚未就绪', true);
      if(!payload.agentId || !payload.date) return fail(400, 'missing_params', '缺少成员标识或日期');
      const res = this.diaryService.getEntry(payload.agentId, payload.date, payload.version);
      if(!res) return fail(404, 'entry_not_found', '未找到该日记');
      return { status: 200, body: res };
    }
    if(operation==='diary-generate') {
      if(!this.diaryService) return fail(503, 'diary_unavailable', '日记服务尚未就绪', true);
      if(!payload.agentId) return fail(400, 'missing_agent_id', '缺少成员标识');
      try {
        const res = await this.diaryService.requestGeneration({
          agentId: payload.agentId,
          date: payload.date,
          forceNewVersion: payload.forceNewVersion
        });
        return { status: 200, body: res };
      } catch (err) {
        return fail(400, 'generation_failed', err.message || '生成请求失败');
      }
    }
    if(operation==='diary-job') {
      if(!this.diaryService) return fail(503, 'diary_unavailable', '日记服务尚未就绪', true);
      if(!payload.jobId) return fail(400, 'missing_job_id', '缺少任务标识');
      const res = this.diaryService.getJob(payload.jobId);
      if(!res) return fail(404, 'job_not_found', '任务不存在或已过期');
      return { status: 200, body: res };
    }
    if(operation==='diary-settings-get') {
      if(!this.diaryService) return fail(503, 'diary_unavailable', '日记服务尚未就绪', true);
      const res = this.diaryService.getSettings();
      return { status: 200, body: { schema: 'diary-settings/1', ...res } };
    }
    if(operation==='diary-settings-set') {
      if(!this.diaryService) return fail(503, 'diary_unavailable', '日记服务尚未就绪', true);
      const res = this.diaryService.updateSettings(payload);
      return { status: 200, body: { schema: 'diary-settings/1', ...res } };
    }
    if(operation==='study-books') {
      if(!this.studyService) return fail(503, 'study_unavailable', '书房服务尚未就绪', true);
      const books = this.studyService.getBooks();
      return { status: 200, body: { schema: 'study-books/1', books } };
    }
    if(operation==='study-book') {
      if(!this.studyService) return fail(503, 'study_unavailable', '书房服务尚未就绪', true);
      if(!payload.bookId) return fail(400, 'missing_book_id', '缺少书籍标识');
      const book = this.studyService.getBook(payload.bookId);
      if(!book) return fail(404, 'book_not_found', '未找到这本书');
      return { status: 200, body: { schema: 'study-book/1', book } };
    }
    if(operation==='study-create') {
      if(!this.studyService) return fail(503, 'study_unavailable', '书房服务尚未就绪', true);
      try {
        const book = this.studyService.createBook({
          title: payload.title,
          motif: payload.motif,
          firstSectionText: payload.firstSectionText,
          authorName: '使用者',
        });
        return { status: 200, body: { ok: true, book } };
      } catch(e) {
        return fail(400, 'create_book_failed', e.message);
      }
    }
    if(operation==='study-append') {
      if(!this.studyService) return fail(503, 'study_unavailable', '书房服务尚未就绪', true);
      try {
        const res = this.studyService.appendSection({
          bookId: payload.bookId,
          authorId: 'agent_owner',
          authorName: '使用者',
          text: payload.text,
          isOwner: true,
        });
        return { status: 200, body: res };
      } catch(e) {
        return fail(400, 'append_failed', e.message);
      }
    }
    if(operation==='study-annotate') {
      if(!this.studyService) return fail(503, 'study_unavailable', '书房服务尚未就绪', true);
      try {
        const res = this.studyService.addAnnotation({
          bookId: payload.bookId,
          sectionId: payload.sectionId,
          quote: payload.quote,
          comment: payload.comment,
        });
        return { status: 200, body: res };
      } catch(e) {
        return fail(400, 'annotate_failed', e.message);
      }
    }
    if(operation==='study-mark-dry') {
      if(!this.studyService) return fail(503, 'study_unavailable', '书房服务尚未就绪', true);
      try {
        const res = this.studyService.markInkDry({
          bookId: payload.bookId,
          sectionId: payload.sectionId,
        });
        return { status: 200, body: res };
      } catch(e) {
        return fail(400, 'mark_dry_failed', e.message);
      }
    }
    if(operation==='study-set-status') {
      if(!this.studyService) return fail(503, 'study_unavailable', '书房服务尚未就绪', true);
      try {
        const book = this.studyService.setBookStatus({
          bookId: payload.bookId,
          status: payload.status,
        });
        return { status: 200, body: { ok: true, book } };
      } catch(e) {
        return fail(400, 'set_status_failed', e.message);
      }
    }
    if(operation==='study-revision') {
      if(!this.studyService) return fail(503, 'study_unavailable', '书房服务尚未就绪', true);
      try {
        const res = this.studyService.submitRevision({
          bookId: payload.bookId,
          sectionId: payload.sectionId,
          revisedText: payload.revisedText,
          authorId: 'agent_owner',
          isOwner: true,
        });
        return { status: 200, body: { ok: true, section: res.section } };
      } catch(e) {
        return fail(400, 'study_revision_failed', e.message);
      }
    }
    if(operation==='save-memory') {
      const { requestId, memoryId, scopeType, scopeId, authorMemberId, title, content, memoryType, tags, triggers, reviewAt, pinned } = payload;
      if (typeof requestId !== 'string' || !requestId || requestId.length > 128) return fail(400, 'invalid_request_id', '缺少合法的请求标识');
      if (typeof content !== 'string' || !content.trim() || content.length > 32000) return fail(400, 'invalid_content', '记忆正文不能为空或超出上限');
      
      const finalMemId = memoryId || `mem_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
      const now = Date.now();
      let updatedMem = null;
      
      if (!this.store) return fail(503, 'store_unavailable', '权威存储未就绪', true);
      
      await this.store.modify((d) => {
        if (!Array.isArray(d.memories)) d.memories = [];
        const existingIdx = d.memories.findIndex(m => m.id === finalMemId);
        if (existingIdx >= 0) {
          const old = d.memories[existingIdx];
          updatedMem = {
            ...old,
            title: typeof title === 'string' ? title : old.title,
            content: content.trim(),
            memoryType: memoryType || old.memoryType || 'experience',
            tags: Array.isArray(tags) ? tags : old.tags,
            triggers: Array.isArray(triggers) ? triggers : old.triggers,
            reviewAt: typeof reviewAt === 'number' ? reviewAt : old.reviewAt,
            pinned: typeof pinned === 'boolean' ? pinned : old.pinned,
            updatedAt: now,
            version: (old.version || 1) + 1
          };
          d.memories[existingIdx] = updatedMem;
        } else {
          updatedMem = {
            id: finalMemId,
            scope: {
              type: scopeType === 'living-room' ? 'living-room' : 'direct',
              id: scopeId || (scopeType === 'living-room' ? 'conv_living_room' : 'conv_direct')
            },
            authorAgentId: authorMemberId || 'agent_owner',
            title: typeof title === 'string' ? title : '',
            content: content.trim(),
            memoryType: memoryType || 'experience',
            status: 'active',
            tags: Array.isArray(tags) ? tags : [],
            triggers: Array.isArray(triggers) ? triggers : [],
            reviewAt: typeof reviewAt === 'number' ? reviewAt : undefined,
            pinned: !!pinned,
            createdAt: now,
            updatedAt: now,
            version: 1
          };
          d.memories.push(updatedMem);
        }
      });
      
      const syncService = this.getSyncService?.();
      if (syncService) {
        void syncService.syncNow().catch(() => {});
      }
      
      this.notify?.('authority:memory-changed', updatedMem);
      
      return {
        status: 200,
        body: {
          schema: 'save-memory/1',
          requestId,
          memory: {
            id: updatedMem.id,
            title: updatedMem.title,
            content: updatedMem.content,
            scopeType: updatedMem.scope.type,
            scopeId: updatedMem.scope.id,
            authorAgentId: updatedMem.authorAgentId,
            memoryType: updatedMem.memoryType,
            status: updatedMem.status,
            tags: updatedMem.tags,
            pinned: updatedMem.pinned,
            createdAt: iso(updatedMem.createdAt),
            version: updatedMem.version
          }
        }
      };
    }
    if(operation==='workbench-snapshot') {
      const broker = typeof this.bridgeBroker === 'function' ? this.bridgeBroker() : this.bridgeBroker;
      const snapshot = this._formatWorkbenchSnapshot(data.tickets, broker);
      return { status: 200, body: snapshot };
    }
    if(operation==='job')return this.lookup(payload,data);
    // Serialize request admission, not model execution, so duplicate posts cannot start twice.
    const result=this.queue.then(()=>this.submit(payload));
    this.queue=result.catch(()=>{});
    return result;
  }
  _formatWorkbenchSnapshot(tickets, broker) {
    let workJobs = [];
    if (broker) {
      if (typeof broker.coordinationSnapshot === 'function') {
        const cs = broker.coordinationSnapshot();
        workJobs = Array.isArray(cs?.jobs) ? cs.jobs : [];
      } else if (Array.isArray(broker.data?.jobs)) {
        workJobs = broker.data.jobs.filter(j => j && j.kind === 'work');
      } else if (typeof broker.snapshot === 'function') {
        workJobs = (broker.snapshot()?.jobs || []).filter(j => j && j.kind === 'work');
      }
    }

    const formattedTickets = (Array.isArray(tickets) ? tickets : []).map(ticket => {
      let discussionText = '';
      if (typeof ticket.discussion === 'string') {
        discussionText = ticket.discussion;
      } else if (ticket.discussion && typeof ticket.discussion.text === 'string') {
        discussionText = ticket.discussion.text;
      }

      let artifactsText = '';
      if (typeof ticket.artifacts === 'string') {
        artifactsText = ticket.artifacts;
      } else if (ticket.artifacts && typeof ticket.artifacts.text === 'string') {
        artifactsText = ticket.artifacts.text;
      }

      const tasks = (Array.isArray(ticket.tasks) ? ticket.tasks : []).map(task => {
        const matchingJobs = workJobs.filter(j => j && j.ticketId === ticket.id && j.taskId === task.id);
        const latestJob = matchingJobs.length > 0 ? matchingJobs[matchingJobs.length - 1] : null;

        const rawEvents = Array.isArray(latestJob?.events) ? latestJob.events : [];
        const progress = rawEvents.slice(-30).map(e => {
          const rawKind = e.type || e.kind || 'note';
          const kind = KIND_MAP[rawKind] || (PROGRESS_KINDS.has(rawKind) ? rawKind : 'note');
          const rawText = e.summary || e.text || '';
          const text = sanitizePaths(rawText).slice(0, 600);
          const at = typeof e.createdAt === 'number' ? e.createdAt : (typeof e.at === 'number' ? e.at : Date.now());
          const agentId = typeof e.agentId === 'string' ? e.agentId : (typeof latestJob?.agentId === 'string' ? latestJob.agentId : undefined);
          return {
            at,
            kind,
            text,
            ...(agentId ? { agentId } : {})
          };
        });

        let report = null;
        if (task.report && typeof task.report.text === 'string') {
          report = {
            text: sanitizePaths(task.report.text).slice(0, 6000),
            at: typeof task.report.at === 'number' ? task.report.at : Date.now()
          };
        } else if (latestJob?.report && (typeof latestJob.report.summary === 'string' || typeof latestJob.report.text === 'string')) {
          const reportText = latestJob.report.summary || latestJob.report.text || '';
          report = {
            text: sanitizePaths(reportText).slice(0, 6000),
            at: typeof latestJob.report.at === 'number' ? latestJob.report.at : (typeof latestJob.updatedAt === 'number' ? latestJob.updatedAt : (typeof latestJob.createdAt === 'number' ? latestJob.createdAt : Date.now()))
          };
        }

        let review = null;
        if (task.review && (task.review.decision === 'accepted' || task.review.decision === 'rejected')) {
          review = {
            decision: task.review.decision,
            reason: task.review.reason ? sanitizePaths(task.review.reason).slice(0, 1000) : undefined,
            at: typeof task.review.at === 'number' ? task.review.at : Date.now()
          };
        } else if (latestJob?.reviewDecision && (latestJob.reviewDecision.decision === 'accepted' || latestJob.reviewDecision.decision === 'rejected' || latestJob.state === 'rejected')) {
          const decision = latestJob.reviewDecision.decision || 'rejected';
          review = {
            decision,
            reason: latestJob.reviewDecision.reason ? sanitizePaths(latestJob.reviewDecision.reason).slice(0, 1000) : undefined,
            at: typeof latestJob.reviewDecision.at === 'number' ? latestJob.reviewDecision.at : (typeof latestJob.updatedAt === 'number' ? latestJob.updatedAt : Date.now())
          };
        } else if (latestJob?.state === 'done') {
          review = {
            decision: 'accepted',
            at: typeof latestJob.updatedAt === 'number' ? latestJob.updatedAt : (typeof latestJob.createdAt === 'number' ? latestJob.createdAt : Date.now())
          };
        }

        return {
          id: task.id,
          title: sanitizePaths(task.title || ''),
          status: ['todo', 'doing', 'review', 'done'].includes(task.status) ? task.status : 'todo',
          assigneeId: typeof task.assigneeId === 'string' ? task.assigneeId : null,
          acceptance: task.acceptance ? sanitizePaths(task.acceptance) : '',
          jobState: latestJob?.state ? String(latestJob.state) : null,
          progress,
          report,
          review
        };
      });

      return {
        id: ticket.id,
        title: sanitizePaths(ticket.title || ''),
        goal: sanitizePaths(ticket.goal || ''),
        updatedAt: typeof ticket.updatedAt === 'number' ? ticket.updatedAt : Date.now(),
        participantIds: Array.isArray(ticket.participantIds) ? ticket.participantIds.filter(id => typeof id === 'string') : [],
        discussion: sanitizePaths(discussionText).slice(0, 8000),
        artifacts: sanitizePaths(artifactsText).slice(0, 8000),
        tasks
      };
    });

    return {
      schema: 'workbench-snapshot/1',
      generatedAt: Date.now(),
      tickets: formattedTickets
    };
  }
  lookup(payload,data=this.getData()) {
    const requestId=payload.requestId || (typeof payload.jobId==='string'&&payload.jobId.startsWith('mobile_job_')?payload.jobId.slice(11):null);
    if(typeof requestId!=='string'||!requestId||requestId.length>128)return fail(400,'invalid_request_id','缺少合法的请求标识');
    const ids=messageIds(requestId),user=data.messages.find(m=>m.id===ids.user),reply=data.messages.find(m=>m.id===ids.reply);
    if(!user || (!reply&&user.targetAgentId!=='@all'))return fail(404,'job_not_found','本轮聊天不存在');
    if(user.targetAgentId==='@all') {
      const replies=data.messages.filter(m=>m.requestId===requestId&&m.agentId!=='agent_owner'&&m.id.startsWith('mobile_reply_'));
      if(!replies.length)return fail(404,'job_not_found','群聊回复记录不存在');
      const running=this.active.has(requestId),failed=replies.filter(m=>m.status!=='sent');
      const state=replies.every(m=>m.status==='sent')?'done':running?'doing':'failed';
      return {status:200,body:{schema:'chat-job/1',requestId,jobId:`mobile_job_${requestId}`,state,userMessageId:user.id,...(state==='done'?{reply:{id:replies[replies.length-1].id,agentId:replies[replies.length-1].agentId,content:replies[replies.length-1].text,createdAt:iso(replies[replies.length-1].createdAt)}}:{}),...(state==='failed'?{error:{code:'group_partial_failure',message:`${failed.length} 位成员未完成回应，已收到的回复保留在客厅；刷新可查看详情。`,retryable:false}}:{})}};
    }
    const running=this.active.has(requestId),waiting=this.autonomyService?.isWaiting(requestId);
    const state=reply.status==='sent'?'done':reply.status==='streaming'&&(running||waiting)?waiting?'queued':'doing':'failed';
    return {status:200,body:{schema:'chat-job/1',requestId,jobId:`mobile_job_${requestId}`,state,userMessageId:user.id,...(state==='done'?{reply:{id:reply.id,agentId:reply.agentId,content:reply.text,createdAt:iso(reply.createdAt)}}:{}),...(state==='failed'?{error:{code:reply.error?'chat_failed':'desktop_interrupted',message:reply.error||'桌面会话已中断；原始消息保留，请用新请求重试',retryable:true}}:{})}};
  }
  async submit(payload) {
    const {requestId,conversationId,targetAgentId,text,attachments}=payload;
    if(payload.sourceChannel!==undefined&&!['luma','xiaodu'].includes(payload.sourceChannel))return fail(400,'invalid_channel','聊天通道不合法');
    const sourceChannel=channelRules.isXiaoduRequest(requestId)?'xiaodu':payload.sourceChannel||'luma';
    if(payload.sourceChannel==='xiaodu'&&!channelRules.isXiaoduRequest(requestId))return fail(400,'invalid_channel','小度请求标识须以 req_xiaodu_ 或 xiaodu_ 开头');
    if(payload.sourceChannel==='luma'&&sourceChannel==='xiaodu')return fail(400,'invalid_channel','请求标识与通道不一致');
    if(payload.eventKind!==undefined&&(payload.eventKind!=='device-event'||sourceChannel!=='xiaodu'))return fail(400,'invalid_event','设备事件仅限小度通道');
    if(payload.eventKind==='device-event'&&!/^(?:req_)?xiaodu_event_/.test(requestId))return fail(400,'invalid_event','设备事件请求标识须以 req_xiaodu_event_ 开头');
    const channelFields={sourceChannel,...(payload.eventKind?{eventKind:payload.eventKind}:{})};
    if(typeof requestId!=='string'||!requestId||requestId.length>128||!/^[-\w.]+$/.test(requestId)||typeof text!=='string'||!text.trim()||text.length>32000)return fail(400,'invalid_chat','请求标识或消息不合法');
    if(attachments!==undefined&&(!Array.isArray(attachments)||attachments.length>4||attachments.some(a=>!a||typeof a.name!=='string'||typeof a.dataBase64!=='string')))return fail(400,'invalid_chat','附件格式不合法');
    const data=this.getData(),agent=data.agents.find(a=>a.id===targetAgentId&&!a.removed&&a.kind==='ai'),conv=data.conversations.find(c=>c.id===conversationId);
    const all=targetAgentId==='@all'&&conv?.kind==='living-room';
    if(sourceChannel==='xiaodu'&&(targetAgentId!=='agent_coordinator'||conv?.kind!=='direct'))return fail(403,'ownership_mismatch','小度通道属于协调者私聊');
    if(!conv || (!all&&(!agent || !['direct','living-room'].includes(conv.kind) || (conv.kind==='direct'&&conv.agentId!==agent.id))))return fail(403,'ownership_mismatch','成员或会话归属不匹配');
    const ids=messageIds(requestId),existing=data.messages.find(m=>m.id===ids.user);
    if(existing) {
      const sameAtts=(!existing.attachments?.length&&!attachments?.length)||(existing.attachments?.length===(attachments?.length||0)&&existing.attachments.every((a,i)=>a.name===attachments[i]?.name));
      if(existing.conversationId!==conversationId||existing.targetAgentId!==targetAgentId||existing.text!==text||!sameAtts||channelRules.classify([existing]).get(existing.id)?.channel!==sourceChannel||channelRules.isDeviceEvent(existing)!==channelRules.isDeviceEvent({requestId,text,eventKind:payload.eventKind}))return fail(409,'request_id_conflict','同一请求标识不能用于不同消息');
      return this.lookup({requestId},data);
    }
    if(this.active.has(requestId)||data.messages.some(m=>m.requestId===requestId))return fail(409,'request_id_conflict','请求标识已属于另一轮桌面聊天');
    if(all)return this.submitAll(payload,data,conv);
    // A process restart cannot safely replay a possibly delivered model request.
    // Keep its user text and convert only our orphan placeholder to an explicit error.
    for(const orphan of data.messages.filter(m=>m.agentId===targetAgentId&&m.status==='streaming'&&m.id.startsWith('mobile_reply_')&&!this.active.has(m.requestId)&&!this.autonomyService?.isWaiting(m.requestId))) {
      const recovery=await this.mutate({type:'mobile-chat-events',requestId:orphan.requestId,conversationId:orphan.conversationId,messageId:orphan.id,status:'error',error:'桌面会话已中断；原始消息保留，请用新请求重试'});
      if(!recovery?.ok)return fail(503,'save_failed','中断消息的状态尚未保存',true);
    }
    if(!this.route(agent,data).available)return fail(503,'member_unavailable','成员真实聊天线路不可用',true);
    if(!this.autonomyService?.isAway(targetAgentId)&&([...this.active.values()].some(a=>a.targetAgentId===targetAgentId)||this.getData().messages.some(m=>m.agentId===targetAgentId&&m.status==='streaming')))return fail(409,'member_busy','该成员仍在回复上一轮，请稍后再发',true);

    let importedAttachments=[];
    if(Array.isArray(attachments)&&attachments.length>0){
      if(!this.attachmentsStore)return fail(503,'attachments_unavailable','桌面附件存储未就绪',true);
      try {
        for(const att of attachments){
          const imported=await this.attachmentsStore.importFile(att);
          importedAttachments.push(imported);
        }
      }catch(e){
        return fail(400,'invalid_attachment',e.message||'附件无法导入');
      }
    }

    const params={requestId,conversationId,targetAgentId,currentText:text,excludeMessageIds:[ids.user,ids.reply],...(importedAttachments.length?{attachments:importedAttachments}:{})};
    const valid=this.validateChat(params,data);
    if(!valid.ok)return fail(400,'chat_rejected',valid.reason);
    const now=Date.now();
    const result=await this.mutate({type:'mobile-chat',messages:[{id:ids.user,conversationId,agentId:'agent_owner',text,createdAt:now,status:'sent',demo:false,requestId,targetAgentId,...channelFields,...(importedAttachments.length?{attachments:importedAttachments}:{})},{id:ids.reply,conversationId,agentId:targetAgentId,text:'',createdAt:now+1,status:'streaming',demo:false,requestId,...channelFields}]});
    if(!result?.ok)return fail(503,'save_failed',result?.reason||'消息未能提交到桌面权威存储',true);
    await this.launchReply(params,ids.reply);
    return this.lookup({requestId});
  }
  async submitAll(payload,data,conv) {
    const {requestId,text,attachments}=payload;
    const agents=data.agents.filter(a=>a.kind==='ai'&&!a.removed);
    if(!agents.length)return fail(503,'member_unavailable','客厅还没有 AI 成员',true);
    for(const orphan of data.messages.filter(m=>agents.some(a=>a.id===m.agentId)&&m.status==='streaming'&&m.id.startsWith('mobile_reply_')&&!this.active.has(m.requestId))) {
      const saved=await this.mutate({type:'mobile-chat-events',requestId:orphan.requestId,conversationId:orphan.conversationId,messageId:orphan.id,status:'error',error:'桌面会话已中断，已有消息保留'});
      if(!saved?.ok)return fail(503,'save_failed','中断消息尚未保存',true);
    }
    if(this.getData().messages.some(m=>m.status==='streaming'&&agents.some(a=>a.id===m.agentId)))return fail(409,'member_busy','群里有成员仍在回复，请稍后再发',true);
    const now=Date.now(),ids=messageIds(requestId),imported=[];
    if(attachments?.length) {
      if(!this.attachmentsStore)return fail(503,'attachments_unavailable','桌面附件存储未就绪',true);
      try {for(const att of attachments)imported.push(await this.attachmentsStore.importFile(att));}
      catch(error){return fail(400,'invalid_attachment',error.message||'附件无法导入');}
    }
    const replies=agents.map((a,i)=>({id:messageIds(`${requestId}.${a.id}`).reply,conversationId:conv.id,agentId:a.id,text:'',createdAt:now+i+1,status:'streaming',demo:false,requestId}));
    const allIds=[ids.user,...replies.map(m=>m.id)];
    const rounds=agents.map((a,i)=>{
      const params={requestId:`${key(requestId)}.${i}`,conversationId:conv.id,targetAgentId:a.id,currentText:text,excludeMessageIds:allIds,...(imported.length?{attachments:imported}:{})};
      const valid=this.validateChat(params,data);
      const error=!this.route(a,data).available?'成员真实聊天线路未连接':valid.ok?undefined:valid.reason||'成员聊天校验未通过';
      return {params,reply:replies[i],error};
    });
    if(rounds.every(r=>r.error))return fail(503,'member_unavailable','群内成员的真实线路尚未可用',true);
    const saved=await this.mutate({type:'mobile-chat',messages:[{id:ids.user,conversationId:conv.id,agentId:'agent_owner',text,createdAt:now,status:'sent',demo:false,requestId,targetAgentId:'@all',...(imported.length?{attachments:imported}:{})},...replies]});
    if(!saved?.ok)return fail(503,'save_failed',saved?.reason||'群聊提问未能保存',true);
    this.active.set(requestId,{group:true,conversationId:conv.id});
    // One public question; later speakers can read the earlier public replies.
    const run=async()=>{
      for(const round of rounds) {
        if(round.error) {
          const result=await this.mutate({type:'mobile-chat-events',requestId,conversationId:conv.id,messageId:round.reply.id,status:'error',error:round.error,finalText:`（${data.agents.find(a=>a.id===round.reply.agentId)?.name||'成员'}：${round.error}）`});
          if(!result?.ok)throw Error(result?.reason||'群聊状态保存失败');
          continue;
        }
        const started=await this.launchReply(round.params,round.reply.id,requestId);
        await started.completed;
        if(started.persistenceError)throw Error(started.persistenceError);
        round.params.excludeMessageIds=round.params.excludeMessageIds.filter(id=>id!==round.reply.id);
        for(const next of rounds)next.params.excludeMessageIds=next.params.excludeMessageIds.filter(id=>id!==round.reply.id);
      }
    };
    run().catch(error=>{this.notify?.('mobile:group-error',{requestId,error:error.message});}).finally(()=>this.active.delete(requestId));
    return this.lookup({requestId});
  }
  async launchReply(params,messageId,persistedRequestId=params.requestId) {
    const {requestId,conversationId,targetAgentId}=params;
    let finish;
    const run={requestId,conversationId,targetAgentId,messageId,chain:Promise.resolve(),terminal:false,text:'',completed:new Promise(resolve=>{finish=resolve;})};
    this.active.set(requestId,run);
    const emit=(channel,event)=>{
      if(channel==='codex:thread-bound'){this.notify?.(channel,event);return;}
      if(event.requestId!==requestId||event.conversationId!==conversationId||run.terminal)return;
      const command={type:'mobile-chat-events',requestId:persistedRequestId,conversationId,messageId};
      if(channel==='chat:stream-chunk'){
        if(typeof event.delta!=='string')return;
        run.text+=event.delta;command.delta=event.delta;
      }
      else if(channel==='chat:memory-receipt'){command.receipt=event.receipt;command.updatedCheckpoints=event.updatedCheckpoints;}
      else if(['chat:stream-done','chat:stream-error','chat:stream-stopped'].includes(channel)){
        run.terminal=true;command.status=channel==='chat:stream-done'?'sent':channel==='chat:stream-stopped'?'stopped':'error';command.error=event.error;command.finalText=run.text;
      }else return;
      run.chain=run.chain.then(async()=>{
        const saved=await this.mutate(command);
        if(!saved?.ok)throw new Error(saved?.reason||'回复未能提交到桌面权威存储');
      }).catch(error=>{run.persistenceError=error.message;}).finally(()=>{if(command.status){this.active.delete(requestId);finish();}});
    };
    // The question and placeholder are already saved. Native startup (memory,
    // client connection) must not hold the relay's 12-second admission request.
    void (async()=>{
      try {
        const started=await this.startChat(params,emit);
        if(!started?.ok)emit('chat:stream-error',{requestId,conversationId,error:started?.reason||'真实聊天启动失败'});
      }catch(error){emit('chat:stream-error',{requestId,conversationId,error:error.message});}
    })();
    // Return the admitted job immediately. Stream/receipt writes continue through
    // the same authority queue; the authenticated phone polls the durable job.
    return run;
  }
}

class MobileRelay {
  constructor({dir,homeId,rpc,WebSocketImpl=globalThis.WebSocket,onStatus=()=>{}}) {
    Object.assign(this,{dir,homeId,rpc,WebSocketImpl,onStatus});this.closed=false;this.attempt=0;this.socket=null;this.timer=null;this.ready=false;
  }
  config() {
    const config=JSON.parse(fs.readFileSync(path.join(this.dir,'config.json'),'utf8'));
    const endpoint=new URL(config.endpoint);
    if(endpoint.protocol!=='wss:'||(!endpoint.hostname||endpoint.hostname.endsWith('.invalid'))||endpoint.pathname!=='/internal/relay'||endpoint.search||endpoint.username||endpoint.password||config.homeId!==this.homeId)throw new Error('relay配置未获批准或家庭身份不符');
    const tokenFile=path.resolve(config.tokenFile);
    if(path.dirname(tokenFile)!==path.resolve(this.dir))throw new Error('relay凭据必须在专用批准目录');
    const token=fs.readFileSync(tokenFile,'utf8').trim();
    if(token.length!==64)throw new Error(`relay凭据需恰好64位，当前${token.length}`);
    return {endpoint:config.endpoint,token};
  }
  start() {
    if(!fs.existsSync(path.join(this.dir,'config.json')))return false;
    this.connect();return true;
  }
  connect() {
    if(this.closed)return;
    let config;
    try{config=this.config();if(!this.WebSocketImpl)throw new Error('当前运行时没有WebSocket');}catch(error){this.onStatus('unavailable',error.message);return;}
    const socket=new this.WebSocketImpl(config.endpoint);this.socket=socket;this.ready=false;
    const authDeadline=setTimeout(()=>{
      if(this.socket===socket&&!this.ready){
        try{socket.close(4008,'auth_timeout');}catch{try{socket.close();}catch{}}
      }
    },15000);
    authDeadline.unref?.();
    clearInterval(this.heartbeat);
    this.heartbeat = setInterval(() => {
      if (this.ready && this.socket === socket && socket.readyState === 1) {
        try { socket.send(JSON.stringify({ type: 'ping' })); } catch(err) { this.onStatus('offline', err.message); }
      }
    }, 20000);
    this.heartbeat.unref?.();
    socket.addEventListener('open',()=>{
      try {
        socket.send(JSON.stringify({type:'auth',token:config.token,homeId:this.homeId}));
      } catch(err) {
        this.onStatus('offline', err.message);
      }
    });
    socket.addEventListener('message',async event=>{
      if(typeof event.data!=='string'||Buffer.byteLength(event.data)>MAX_FRAME){
        try{socket.close(4009,'frame_too_large');}catch{try{socket.close();}catch{}}
        return;
      }
      let frame;
      try{frame=JSON.parse(event.data);}catch{
        try{socket.close(4008,'invalid_json');}catch{try{socket.close();}catch{}}
        return;
      }
      if(!object(frame)){
        try{socket.close(4008,'invalid_frame_object');}catch{try{socket.close();}catch{}}
        return;
      }
      if(frame.type==='ready'){
        clearTimeout(authDeadline);
        this.ready=true;
        this.attempt=0;
        this.onStatus('ready');
        return;
      }
      if(!this.ready){
        try{socket.close(4008,'unauthorized_frame');}catch{try{socket.close();}catch{}}
        return;
      }
      if(frame.type==='ping'){
        try{socket.send(JSON.stringify({type:'pong'}));}catch(err){this.onStatus('offline',err.message);}
        return;
      }
      if(frame.type==='pong')return;
      if(frame.type!=='request'||typeof frame.id!=='string'||!frame.id||frame.id.length>128){
        try{socket.close(4008,'invalid_request');}catch{try{socket.close();}catch{}}
        return;
      }
      let response;
      try{response=await this.rpc.handle(frame.operation,frame.payload||{});}catch{response=fail(500,'desktop_error','桌面无法处理请求',true);}
      if(this.socket===socket&&socket.readyState===1){
        try{socket.send(JSON.stringify({type:'response',id:frame.id,...response}));}catch(err){this.onStatus('offline',err.message);}
      }
    });
    socket.addEventListener('error',()=>this.onStatus('offline'));
    socket.addEventListener('close',()=>{
      clearTimeout(authDeadline);
      clearInterval(this.heartbeat);
      if(this.socket===socket){
        this.ready=false;
        this.socket=null;
      }
      if(this.closed)return;
      this.onStatus('offline');
      const delay=Math.min(30000,1000*2**Math.min(this.attempt++,5));
      this.timer=setTimeout(()=>this.connect(),delay);
      this.timer.unref?.();
    });
  }
  stop(){
    this.closed=true;
    clearTimeout(this.timer);
    clearInterval(this.heartbeat);
    if(this.socket){
      try{this.socket.close(1000,'client_stopped');}catch{try{this.socket.close();}catch{}}
      this.socket=null;
    }
  }
}
module.exports={MobileRpc,MobileRelay,messageIds};
