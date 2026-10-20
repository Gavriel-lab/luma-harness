import {
  TASK_STATUS_ORDER,
  uid,
  DEFAULT_READING_PREFERENCES,
  type Agent,
  type AgentId,
  type AppData,
  type ChatProfile,
  type ConversationId,
  type FontFamilyOption,
  type MessageId,
  type TaskStatus,
  type ThemeId,
  type TicketId,
} from '../types';
import { isAvatarDataUrl } from '../utils/avatar';
import { applyAuthorityMutation, type AuthorityMutation } from './authorityMutations';
import { isAvailableAI, livingRoomResponder } from '../utils/activeAgents';

export type Action =
  | { type: 'authorityMutation'; command: AuthorityMutation }
  | { type: 'projectBridge'; snapshot: import('../components/BridgeControls').BridgeSnapshot }
  | { type: 'hydrate'; data: AppData }
  | { type: 'selectConversation'; conversationId: ConversationId }
  | { type: 'setDraft'; conversationId: ConversationId; text: string }
  | { type: 'addAttachmentDraft'; conversationId: ConversationId; attachment: import('../types').MessageAttachment }
  | { type: 'removeAttachmentDraft'; conversationId: ConversationId; attachmentId: string }
  | { type: 'clearAttachmentDrafts'; conversationId: ConversationId }
  | { type: 'appendMessage'; message: AppData['messages'][number] }
  | { type: 'patchMessage'; id: MessageId; patch: Partial<AppData['messages'][number]> }
  | { type: 'appendDelta'; messageId: MessageId; conversationId: string; requestId: string; delta: string }
  | {
      type: 'finishMessage';
      messageId: MessageId;
      conversationId: string;
      requestId: string;
      status: 'sent' | 'stopped' | 'error';
      error?: string;
    }
  | { type: 'dropMessage'; id: MessageId }
  | { type: 'setTheme'; theme: ThemeId }
  | { type: 'setMotion'; motion: boolean }
  | { type: 'setScenic'; scenic: boolean }
  | { type: 'toggleWorkbench'; open?: boolean }
  | { type: 'selectTicket'; ticketId: TicketId | null }
  | { type: 'createTicket'; ticketId?: TicketId }
  | { type: 'patchTicket'; ticketId: TicketId; patch: Partial<Pick<AppData['tickets'][number], 'title' | 'goal'>> }
  | { type: 'setParticipants'; ticketId: TicketId; agentIds: AgentId[] }
  | { type: 'addTask'; ticketId: TicketId; title: string }
  | { type: 'patchTask'; ticketId: TicketId; taskId: string; patch: Partial<{ title: string; status: TaskStatus; assigneeId: AgentId | null }> }
  | { type: 'cycleTaskStatus'; ticketId: TicketId; taskId: string }
  | { type: 'removeTask'; ticketId: TicketId; taskId: string }
  | { type: 'setTicketText'; ticketId: TicketId; field: 'discussion' | 'artifacts'; text: string }
  | { type: 'deleteTicket'; ticketId: TicketId }
  | { type: 'addAgent'; name: string }
  | { type: 'setAgentAvatar'; agentId: AgentId; avatarDataUrl: string }
  | { type: 'setAgentRemoved'; agentId: AgentId; removed: boolean }
  | { type: 'removeConversation'; conversationId: ConversationId }
  | { type: 'setLivingRoomSpeaker'; agentId: AgentId | null }
  | { type: 'updateAgentConfig'; agentId: AgentId; patch: Partial<Pick<Agent, 'mode' | 'profileId' | 'systemPrompt' | 'statusNote' | 'connected'>> }
  | { type: 'saveChatProfile'; profile: ChatProfile }
  | { type: 'deleteChatProfile'; profileId: string }
  | { type: 'saveMemory'; memory: import('../types').MemoryItem }
  | { type: 'tombstoneMemory'; memoryId: string }
  | { type: 'deleteMemoryPermanently'; memoryId: string }
  | { type: 'saveCheckpoint'; checkpoint: import('../types').ContextCheckpoint }
  | { type: 'saveCheckpoints'; checkpoints: import('../types').ContextCheckpoint[] }
  | { type: 'mergeCheckpoints'; checkpoints: import('../types').ContextCheckpoint[] }
  | { type: 'updateMemoryGatewayConfig'; config: Partial<import('../types').MemoryGatewayConfig> }
  | { type: 'enqueueOutbox'; item: import('../types').MemoryGatewayOutboxItem }
  | { type: 'ackOutbox'; id: string }
  | { type: 'updateOutboxAttempt'; id: string }
  | {
      type: 'bindCodexThread';
      conversationId: ConversationId;
      threadId: string;
      instructionSources?: string[];
      profileId?: string;
      verifiedAt?: string;
      agentId?: AgentId;
      canonicalThreadId?: string;
    }
  | { type: 'setReadingPreferences'; reading: Partial<import('../types').ReadingPreferences> }
  | { type: 'hideMessagesFromWindow'; messageIds: MessageId[] }
  | { type: 'unhideMessagesToWindow'; messageIds: MessageId[] }
  | {
      type: 'purgeMessagesPermanently';
      messageIds: MessageId[];
      affectedAgentIds?: AgentId[];
    };

const touch = (data: AppData): AppData => data;

export function reducer(state: AppData, action: Action): AppData {
  if(action.type==='authorityMutation') {
    const c=action.command;
    if ('type' in c && c.type==='mobile-message-delete') {
      const message=state.messages.find(m=>m.id===c.messageId&&m.conversationId===c.conversationId);
      if(!message||message.status==='streaming')return state;
      if(c.mode==='hide'&&c.part) {
        const part=c.part;
        if(!message.text.includes(part))return state;
        return {...state,messages:state.messages.map(m=>m.id!==message.id?m:{...m,hiddenReplyParts:[...new Set([...(m.hiddenReplyParts||[]),part])]})};
      }
      return reducer(state,{type:c.mode==='purge'?'purgeMessagesPermanently':'hideMessagesFromWindow',messageIds:[message.id]});
    }
    return applyAuthorityMutation(state,c);
  }
  switch (action.type) {
    case 'addAttachmentDraft': {
      const conv = state.conversations.find(c => c.id === action.conversationId);
      if (!conv || (conv.agentId && state.agents.find(a => a.id === conv.agentId)?.removed)) return state;
      const list = state.attachmentDrafts?.[action.conversationId] ?? [];
      if (list.length >= 4 || list.some(a => a.id === action.attachment.id)) return state;
      return { ...state, attachmentDrafts: { ...state.attachmentDrafts, [action.conversationId]: [...list, action.attachment] } };
    }
    case 'removeAttachmentDraft':
      return { ...state, attachmentDrafts: { ...state.attachmentDrafts, [action.conversationId]: (state.attachmentDrafts?.[action.conversationId] ?? []).filter(a => a.id !== action.attachmentId) } };
    case 'clearAttachmentDrafts':
      return { ...state, attachmentDrafts: { ...state.attachmentDrafts, [action.conversationId]: [] } };
    case 'setAgentRemoved': {
      const agent = state.agents.find(a => a.id === action.agentId);
      if (!agent || agent.kind !== 'ai' || !!agent.removed === action.removed) return state;
      if (action.removed && state.messages.some(m => m.status === 'streaming')) return state;
      const next = { ...state, agents: state.agents.map(a => a.id === agent.id ? { ...a, removed: action.removed } : a) };
      const active = next.conversations.find(c => c.id === next.activeConversationId);
      if (action.removed && active?.kind === 'direct' && active.agentId === agent.id) {
        next.activeConversationId = next.conversations.find(c => c.kind === 'living-room')?.id ?? next.activeConversationId;
      }
      next.livingRoomSpeakerId = livingRoomResponder(next);
      return next;
    }
    case 'setAgentAvatar': {
      if (action.avatarDataUrl !== '' && !isAvatarDataUrl(action.avatarDataUrl)) return state;
      return { ...state, agents: state.agents.map(agent => agent.id === action.agentId ? { ...agent, avatarDataUrl: action.avatarDataUrl || undefined } : agent) };
    }
    case 'hydrate': {
      // 独立持久删除日志：合并当前状态与导入备份中的墓碑，确保删除事实单调递增，永不丢失
      const existingTombstones = new Set(state.memoryTombstones ?? []);
      const importedTombstones = new Set(action.data.memoryTombstones ?? []);
      const mergedTombstones = Array.from(new Set([...existingTombstones, ...importedTombstones]));

      const existingPurgedMsgs = new Set(state.purgedMessageIds ?? []);
      const importedPurgedMsgs = new Set(action.data.purgedMessageIds ?? []);
      const mergedPurgedMsgs = Array.from(new Set([...existingPurgedMsgs, ...importedPurgedMsgs]));
      const purgedMsgSet = new Set(mergedPurgedMsgs);

      const existingPurgedThreads = new Set(state.purgedThreadIds ?? []);
      const importedPurgedThreads = new Set(action.data.purgedThreadIds ?? []);
      const mergedPurgedThreads = Array.from(new Set([...existingPurgedThreads, ...importedPurgedThreads]));
      const purgedThreadSet = new Set(mergedPurgedThreads);

      const mergedEpoch = Math.max(state.purgedMessageEpoch ?? 0, action.data.purgedMessageEpoch ?? 0);

      // 对导入的记忆进行防复活清洗：如果属于墓碑，强制标记为已删除/tombstoned，绝不复活为活跃
      const sanitizedMemories = (action.data.memories ?? [])
        .filter((m) => !m.sourceMessageId || !purgedMsgSet.has(m.sourceMessageId))
        .map((m) => {
          if (mergedTombstones.includes(m.id)) {
            return {
              ...m,
              tombstoned: true,
              status: 'deleted' as const,
              tombstonedAt: m.tombstonedAt ?? Date.now(),
            };
          }
          return m;
        });

      const sanitizedMessages = (action.data.messages ?? []).filter((m) => !purgedMsgSet.has(m.id));

      const sanitizedCheckpoints = (action.data.checkpoints ?? []).filter((cp) => {
        if (Array.isArray(cp.sourceMessageSnapshots) && cp.sourceMessageSnapshots.some((s) => purgedMsgSet.has(s.id))) {
          return false;
        }
        return true;
      });

      const sanitizedOutbox = (action.data.memoryGatewayOutbox ?? []).filter((item) => {
        return !Array.isArray(item.messageIds) || !item.messageIds.some((id) => purgedMsgSet.has(id));
      });

      const sanitizedAgents = (action.data.agents ?? []).map((a) => {
        if (a.canonicalCodexThreadId && purgedThreadSet.has(a.canonicalCodexThreadId)) {
          const copy = { ...a };
          delete copy.canonicalCodexThreadId;
          return copy;
        }
        return a;
      });

      const sanitizedConversations = (action.data.conversations ?? []).map((c) => {
        if (c.codexThreadId && purgedThreadSet.has(c.codexThreadId)) {
          const copy = { ...c };
          delete copy.codexThreadId;
          return copy;
        }
        return c;
      });

      const sanitizedProfiles = (action.data.chatProfiles ?? []).map((p) => {
        let copy = { ...p };
        let mod = false;
        if (copy.codexThreadId && purgedThreadSet.has(copy.codexThreadId)) {
          delete copy.codexThreadId;
          mod = true;
        }
        if (copy.canonicalCodexThreadId && purgedThreadSet.has(copy.canonicalCodexThreadId)) {
          delete copy.canonicalCodexThreadId;
          mod = true;
        }
        return mod ? copy : p;
      });

      const importedActive = sanitizedConversations.find(c => c.id === action.data.activeConversationId);
      const importedActiveRemoved = importedActive?.kind === 'direct' && sanitizedAgents.find(a => a.id === importedActive.agentId)?.removed;
      return {
        ...action.data,
        activeConversationId: importedActiveRemoved ? sanitizedConversations.find(c => c.kind === 'living-room')?.id ?? action.data.activeConversationId : action.data.activeConversationId,
        livingRoomSpeakerId: sanitizedAgents.find(a => a.id === action.data.livingRoomSpeakerId)?.removed ? livingRoomResponder({ ...action.data, agents: sanitizedAgents }) : action.data.livingRoomSpeakerId,
        messages: sanitizedMessages,
        memories: sanitizedMemories,
        checkpoints: sanitizedCheckpoints,
        memoryGatewayOutbox: sanitizedOutbox,
        agents: sanitizedAgents,
        conversations: sanitizedConversations,
        chatProfiles: sanitizedProfiles,
        memoryTombstones: mergedTombstones,
        purgedMessageIds: mergedPurgedMsgs,
        purgedThreadIds: mergedPurgedThreads,
        purgedMessageEpoch: mergedEpoch,
      };
    }

    case 'selectConversation':
      if (!state.conversations.some((c) => c.id === action.conversationId)) return state;
      if (state.conversations.some(c => c.id === action.conversationId && c.kind === 'direct' && state.agents.find(a => a.id === c.agentId)?.removed)) return state;
      return { ...state, activeConversationId: action.conversationId };

    case 'setDraft':
      return { ...state, drafts: { ...state.drafts, [action.conversationId]: action.text } };

    case 'appendMessage': {
      const messages = [...state.messages, action.message];
      return { ...state, messages };
    }

    /**
     * 工单 08-R3：消息文本修订记录编辑版本时间（editedAt）。
     * 过去请求（cutoffTime）遇到 editedAt 晚于边界的消息将明确排除——
     * 没有当时版本证明，就不能在旧时间戳下让未来改写的内容进入 payload。
     */
    case 'patchMessage': {
      const target = state.messages.find((m) => m.id === action.id);
      const recordEdit =
        target &&
        action.patch.text !== undefined &&
        action.patch.text !== target.text &&
        target.status === 'sent';
      return {
        ...state,
        messages: state.messages.map((m) =>
          m.id === action.id
            ? recordEdit
              ? { ...m, ...action.patch, editedAt: Date.now() }
              : { ...m, ...action.patch }
            : m,
        ),
      };
    }

    /**
     * 写入增量文本的硬门：消息必须存在、属于同一会话、且请求 ID 一致。
     * 任一不符就直接丢弃整个 action —— 这是「迟到的回复不污染新会话」的最后一道闸。
     */
    case 'appendDelta': {
      const target = state.messages.find((m) => m.id === action.messageId);
      if (!target) return state;
      if (target.conversationId !== action.conversationId) return state;
      if (target.requestId !== action.requestId) return state;
      if (target.status !== 'streaming') return state;
      return {
        ...state,
        messages: state.messages.map((m) =>
          m.id === action.messageId ? { ...m, text: m.text + action.delta, status: 'streaming' as const } : m,
        ),
      };
    }

    case 'finishMessage': {
      const target = state.messages.find((m) => m.id === action.messageId);
      if (!target) return state;
      if (target.conversationId !== action.conversationId) return state;
      if (target.requestId !== action.requestId) return state;
      const updatedReceipt = target.memoryReceipt
        ? {
            ...target.memoryReceipt,
            status: action.status === 'sent' ? ('completed' as const) : action.status === 'stopped' ? ('cancelled' as const) : ('failed' as const),
            error: action.error,
          }
        : undefined;
      return {
        ...state,
        messages: state.messages.map((m) =>
          m.id === action.messageId
            ? { ...m, status: action.status, error: action.error, memoryReceipt: updatedReceipt }
            : m,
        ),
      };
    }


    case 'dropMessage':
      return { ...state, messages: state.messages.filter((m) => m.id !== action.id) };

    case 'setTheme':
      return { ...state, preferences: { ...state.preferences, theme: action.theme } };

    case 'setMotion':
      return { ...state, preferences: { ...state.preferences, motion: action.motion } };

    case 'setScenic':
      return { ...state, preferences: { ...state.preferences, scenic: action.scenic } };

    case 'toggleWorkbench':
      return { ...state, workbenchOpen: action.open ?? !state.workbenchOpen };

    case 'selectTicket':
      return { ...state, activeTicketId: action.ticketId };

    case 'createTicket': {
      const id = action.ticketId ?? uid('ticket');
      const now = Date.now();
      const ticket: AppData['tickets'][number] = {
        id,
        title: '新工单',
        goal: '',
        participantIds: [],
        tasks: [],
        discussion: { updatedAt: now, text: '' },
        artifacts: { updatedAt: now, text: '' },
        updatedAt: now,
      };
      return { ...state, tickets: [...state.tickets, ticket], activeTicketId: id };
    }

    case 'patchTicket':
      return {
        ...state,
        tickets: state.tickets.map((t) => (t.id === action.ticketId ? { ...t, ...action.patch, updatedAt: Date.now() } : t)),
      };

    case 'setParticipants': {
      const agentIds = action.agentIds.filter((id) => state.agents.some((a) => a.id === id));
      return {
        ...state,
        tickets: state.tickets.map((t) =>
          t.id === action.ticketId ? { ...t, participantIds: agentIds, updatedAt: Date.now() } : t,
        ),
      };
    }

    case 'addTask': {
      const title = action.title.trim();
      if (!title) return state;
      return {
        ...state,
        tickets: state.tickets.map((t) =>
          t.id === action.ticketId
            ? {
                ...t,
                tasks: [...t.tasks, { id: uid('task'), title, status: 'todo', assigneeId: null }],
                updatedAt: Date.now(),
              }
            : t,
        ),
      };
    }

    case 'patchTask':
      return {
        ...state,
        tickets: state.tickets.map((t) =>
          t.id === action.ticketId
            ? {
                ...t,
                tasks: t.tasks.map((task) => (task.id === action.taskId ? { ...task, ...action.patch } : task)),
                updatedAt: Date.now(),
              }
            : t,
        ),
      };

    case 'cycleTaskStatus': {
      return {
        ...state,
        tickets: state.tickets.map((t) => {
          if (t.id !== action.ticketId) return t;
          return {
            ...t,
            tasks: t.tasks.map((task) => {
              if (task.id !== action.taskId) return task;
              const idx = TASK_STATUS_ORDER.indexOf(task.status);
              const next = TASK_STATUS_ORDER[(idx + 1) % TASK_STATUS_ORDER.length] ?? 'todo';
              return { ...task, status: next };
            }),
            updatedAt: Date.now(),
          };
        }),
      };
    }

    case 'removeTask':
      return {
        ...state,
        tickets: state.tickets.map((t) =>
          t.id === action.ticketId ? { ...t, tasks: t.tasks.filter((task) => task.id !== action.taskId), updatedAt: Date.now() } : t,
        ),
      };

    case 'setTicketText':
      return {
        ...state,
        tickets: state.tickets.map((t) =>
          t.id === action.ticketId
            ? { ...t, [action.field]: { updatedAt: Date.now(), text: action.text }, updatedAt: Date.now() }
            : t,
        ),
      };

    case 'projectBridge': {
      const labels:Record<string,string>={dispatch:'已明确派发',resume:'已确认停止旧客户端，按检查点续接',started:'已开始执行',progress:'已有进度',question:'提出了问题，请查看工作桌',permission_required:'等待权限，请查看工作桌',blocked:'遇到阻塞，请查看工作桌',failed:'执行失败，请查看工作桌',submitted:'已提交成果，等待验收',cancel:'正在取消',accepted:'成果已验收'};
      const known=new Set([...state.messages.map(m=>m.id), ...(state.purgedMessageIds ?? [])]);
      const newMessages=action.snapshot.feed.filter(f=>!known.has(f.id)).map(f=>({id:f.id,conversationId:'conv_living_room',agentId:f.agentId,text:'[工单 '+f.ticketId+'/'+f.taskId+'] '+(labels[f.type]||f.type),createdAt:f.createdAt,status:'sent' as const,demo:false,requestId:null}));
      let changed=newMessages.length>0;
      const tickets=state.tickets.map(t=>{
        let artifactsText=t.artifacts.text;
        for(const job of action.snapshot.jobs.filter(j=>j.kind==='work'&&j.ticketId===t.id&&j.report&&t.tasks.some(task=>task.id===j.taskId&&task.assigneeId===j.agentId))){
          const report=job.report!;const marker=`【客户端交付 ${job.jobId}/${report.reportId}】`;
          if(!artifactsText.includes(marker)){
            artifactsText=[artifactsText,marker,report.summary,...report.artifacts.map(a=>a.path),report.unknowns.length?'未验证：'+report.unknowns.join('；'):''].filter(Boolean).join('\n');changed=true;
          }
        }
        return {...t,artifacts:artifactsText===t.artifacts.text?t.artifacts:{...t.artifacts,text:artifactsText,updatedAt:Date.now()},tasks:t.tasks.map(task=>{
        const job=action.snapshot.jobs.filter(j=>j.kind==='work'&&j.ticketId===t.id&&j.taskId===task.id).at(-1);
        if(job&&job.agentId!==task.assigneeId)return task;
        const status:TaskStatus|undefined=job?.state==='done'?'done':job?.state==='review'?'review':job&&['failed','cancelled','rejected'].includes(job.state)?'todo':job&&['doing','offline','blocked','question','permission_required','cancelling'].includes(job.state)?'doing':undefined;
        if(!status||status===task.status)return task;changed=true;return {...task,status};
      })};});
      return changed?{...state,tickets,messages:[...state.messages,...newMessages]}:state;
    }
    case 'deleteTicket': {
      const tickets = state.tickets.filter((t) => t.id !== action.ticketId);
      const nextTickets = tickets;
      const activeTicketId = state.activeTicketId === action.ticketId ? (nextTickets[0]?.id ?? null) : state.activeTicketId;
      return { ...state, tickets: nextTickets, activeTicketId };
    }

    case 'addAgent': {
      const name = action.name.trim();
      if (!name) return state;
      const id = uid('agent');
      const agent = {
        id,
        name,
        initial: name.slice(0, 1),
        kind: 'ai' as const,
        connected: false,
        statusNote: '演示模式：未连接真实服务',
        accent: '#7a6a8a',
      };
      return {
        ...state,
        agents: [...state.agents, agent],
        conversations: [
          ...state.conversations,
          { id: uid('conv'), kind: 'direct' as const, agentId: id, title: name, createdAt: Date.now() },
        ],
      };
    }

    case 'removeConversation': {
      const target = state.conversations.find((c) => c.id === action.conversationId);
      if (!target || target.kind === 'living-room') return state;
      const drafts = { ...state.drafts };
      delete drafts[action.conversationId];
      const conversations = state.conversations.filter((c) => c.id !== action.conversationId);
      return {
        ...state,
        conversations,
        messages: state.messages.filter((m) => m.conversationId !== action.conversationId),
        drafts,
        activeConversationId:
          state.activeConversationId === action.conversationId ? conversations[0]!.id : state.activeConversationId,
      };
    }

    case 'setLivingRoomSpeaker':
      if (action.agentId !== null && !isAvailableAI(state, action.agentId)) return state;
      return { ...state, livingRoomSpeakerId: action.agentId };

    case 'updateAgentConfig':
      return {
        ...state,
        agents: state.agents.map((a) => (a.id === action.agentId ? { ...a, ...action.patch } : a)),
      };

    case 'saveChatProfile': {
      const existing = state.chatProfiles ?? [];
      const idx = existing.findIndex((p) => p.id === action.profile.id);
      let nextProfiles: ChatProfile[];
      if (idx >= 0) {
        nextProfiles = existing.map((p, i) => (i === idx ? action.profile : p));
      } else {
        nextProfiles = [...existing, action.profile];
      }
      return { ...state, chatProfiles: nextProfiles };
    }

    case 'deleteChatProfile': {
      const existing = state.chatProfiles ?? [];
      const nextProfiles = existing.filter((p) => p.id !== action.profileId);
      const nextAgents = state.agents.map((a) =>
        a.profileId === action.profileId ? { ...a, profileId: null, mode: 'demo' as const } : a,
      );
      return { ...state, chatProfiles: nextProfiles, agents: nextAgents };
    }

    case 'saveMemory': {
      const existing = state.memories ?? [];
      const tombstones = state.memoryTombstones ?? [];
      const targetId = action.memory.id;
      const idx = existing.findIndex((m) => m.id === targetId);
      const isAlreadyTombstoned =
        tombstones.includes(targetId) ||
        (idx >= 0 && existing[idx]?.tombstoned === true);

      // 如果该条记忆已被标记删除或在墓碑记录中，saveMemory 绝对不可复活！
      const memoryToSave: import('../types').MemoryItem = isAlreadyTombstoned
        ? {
            ...action.memory,
            tombstoned: true,
            status: 'deleted',
            tombstonedAt: (idx >= 0 ? existing[idx]?.tombstonedAt : undefined) || Date.now(),
          }
        : {
            ...action.memory,
            version: (idx >= 0 && existing[idx]?.version ? existing[idx]!.version! + 1 : 1),
            updatedAt: Date.now(),
            status: action.memory.status || 'active',
          };

      let nextMemories: import('../types').MemoryItem[];
      if (idx >= 0) {
        const old = existing[idx]!;
        const prevHistory = (old as any).history ?? [];
        const nextHistory =
          old.content !== action.memory.content
            ? [...prevHistory, { content: old.content, updatedAt: old.updatedAt || old.createdAt }]
            : prevHistory;
        const memoryWithHistory = {
          ...memoryToSave,
          history: nextHistory,
        };
        nextMemories = existing.map((m, i) => (i === idx ? memoryWithHistory : m));
      } else {
        nextMemories = [memoryToSave, ...existing];
      }
      return {
        ...state,
        memories: nextMemories,
        memoryTombstones: isAlreadyTombstoned && !tombstones.includes(targetId)
          ? [...tombstones, targetId]
          : tombstones,
      };
    }

    case 'tombstoneMemory': {
      const existing = state.memories ?? [];
      const tombstones = state.memoryTombstones ?? [];
      const now = Date.now();
      const nextTombstones = tombstones.includes(action.memoryId)
        ? tombstones
        : [...tombstones, action.memoryId];
      return {
        ...state,
        memoryTombstones: nextTombstones,
        memories: existing.map((m) =>
          m.id === action.memoryId
            ? { ...m, tombstoned: true, tombstonedAt: now, status: 'deleted' as const, updatedAt: now }
            : m,
        ),
      };
    }

    case 'deleteMemoryPermanently': {
      const existing = state.memories ?? [];
      const tombstones = state.memoryTombstones ?? [];
      const nextTombstones = tombstones.includes(action.memoryId)
        ? tombstones
        : [...tombstones, action.memoryId];
      return {
        ...state,
        memoryTombstones: nextTombstones,
        memories: existing.filter((m) => m.id !== action.memoryId),
      };
    }

    case 'saveCheckpoint': {
      const existing = state.checkpoints ?? [];
      const idx = existing.findIndex((c) => c.id === action.checkpoint.id);
      let nextCheckpoints: import('../types').ContextCheckpoint[];
      if (idx >= 0) {
        nextCheckpoints = existing.map((c, i) => (i === idx ? action.checkpoint : c));
      } else {
        nextCheckpoints = [...existing, action.checkpoint];
      }
      return { ...state, checkpoints: nextCheckpoints };
    }

    case 'saveCheckpoints': {
      return { ...state, checkpoints: action.checkpoints };
    }

    /**
     * 工单 08-R3：主进程权威派生的检查点合并进本地状态——按会话收敛：
     * - 收据涉及的会话：整体替换为本批（权威派生每会话只保留最新检查点），
     *   但仅当本批最新代次不早于本地最新（迟到的旧收据不得把更晚的本地提交覆盖回去）；
     * - 未涉及的会话完全不动；不删除原始聊天。
     */
    case 'mergeCheckpoints': {
      const incoming = action.checkpoints;
      const current = state.checkpoints ?? [];
      const incomingConvSet = new Set(incoming.map((c) => c.conversationId));
      const incomingConvs = Array.from(incomingConvSet);
      const merged: import('../types').ContextCheckpoint[] = [];
      for (const conv of incomingConvs) {
        const localForConv = current.filter((c) => c.conversationId === conv);
        const incomingForConv = incoming.filter((c) => c.conversationId === conv);
        const localLatest = localForConv.length > 0
          ? localForConv.reduce((a, b) => (b.createdAt > a.createdAt ? b : a))
          : null;
        const incomingLatest = incomingForConv.length > 0
          ? incomingForConv.reduce((a, b) => (b.createdAt > a.createdAt ? b : a))
          : null;
        if (!localLatest || (incomingLatest && incomingLatest.createdAt >= localLatest.createdAt)) {
          merged.push(...incomingForConv);
        } else {
          // 迟到收据：保留本地更晚的检查点
          merged.push(...localForConv);
        }
      }
      const untouched = current.filter((c) => !incomingConvSet.has(c.conversationId));
      const next = [...untouched, ...merged].sort((a, b) => a.createdAt - b.createdAt);
      return { ...state, checkpoints: next };
    }

    case 'updateMemoryGatewayConfig': {
      const cur = state.memoryGatewayConfig ?? {
        enabled: false,
        baseUrl: 'http://127.0.0.1:8787',
        credentialRef: 'cred_memoryGateway',
        defaultNamespace: 'xiaowu-memory',
      };
      return {
        ...state,
        memoryGatewayConfig: { ...cur, ...action.config },
      };
    }

    case 'enqueueOutbox': {
      const existing = state.memoryGatewayOutbox ?? [];
      return {
        ...state,
        memoryGatewayOutbox: [...existing, action.item],
      };
    }

    case 'ackOutbox': {
      const existing = state.memoryGatewayOutbox ?? [];
      return {
        ...state,
        memoryGatewayOutbox: existing.filter((item) => item.id !== action.id),
      };
    }

    case 'updateOutboxAttempt': {
      const existing = state.memoryGatewayOutbox ?? [];
      return {
        ...state,
        memoryGatewayOutbox: existing.map((item) =>
          item.id === action.id ? { ...item, attempts: item.attempts + 1 } : item,
        ),
      };
    }

    case 'bindCodexThread': {
      const targetConv = state.conversations.find((c) => c.id === action.conversationId);
      const targetAgentId = action.agentId || targetConv?.agentId;
      const targetAgent = state.agents.find((a) => a.id === targetAgentId);
      const targetProfileId = action.profileId || targetAgent?.profileId;
      const verifiedAt = action.verifiedAt || new Date().toISOString();
      const effectiveThreadId = action.canonicalThreadId || action.threadId;

      return {
        ...state,
        agents: state.agents.map((a) =>
          a.id === targetAgentId
            ? {
                ...a,
                canonicalCodexThreadId: effectiveThreadId,
                instructionSources: Array.isArray(action.instructionSources)
                  ? action.instructionSources
                  : (a.instructionSources || []),
              }
            : a,
        ),
        conversations: state.conversations.map((c) => {
          if (c.kind === 'living-room') return c;
          if (c.id === action.conversationId || (targetAgentId && c.kind === 'direct' && c.agentId === targetAgentId)) {
            return {
              ...c,
              codexThreadId: effectiveThreadId,
              instructionSources: Array.isArray(action.instructionSources)
                ? action.instructionSources
                : (c.instructionSources || []),
            };
          }
          return c;
        }),
        chatProfiles: state.chatProfiles?.map((p) =>
          p.id === targetProfileId || (!targetProfileId && p.providerType === 'codex-app-server')
            ? {
                ...p,
                codexThreadId: effectiveThreadId,
                canonicalCodexThreadId: effectiveThreadId,
                instructionSources: Array.isArray(action.instructionSources)
                  ? action.instructionSources
                  : (p.instructionSources || []),
                lastVerifiedAt: verifiedAt,
                lastVerifiedStatus: 'success',
                lastVerifiedError: null,
              }
            : p,
        ),
      };
    }

    case 'setReadingPreferences': {
      const cur = state.preferences.reading || DEFAULT_READING_PREFERENCES;
      const validFamily: FontFamilyOption[] = ['system', 'sans-serif', 'serif', 'monospace'];
      const rawFamily = action.reading.fontFamily;
      const nextFamily = rawFamily !== undefined
        ? ((rawFamily && validFamily.includes(rawFamily)) ? rawFamily : 'system')
        : cur.fontFamily;

      const rawSize = action.reading.fontSize;
      const nextSize = (typeof rawSize === 'number' && Number.isFinite(rawSize))
        ? Math.max(12, Math.min(22, Math.round(rawSize)))
        : cur.fontSize;

      const rawLh = action.reading.lineHeight;
      const nextLh = (typeof rawLh === 'number' && Number.isFinite(rawLh))
        ? Math.max(1.3, Math.min(2.0, Number(rawLh.toFixed(2))))
        : cur.lineHeight;

      const rawSpacing = action.reading.messageSpacing;
      const nextSpacing = (typeof rawSpacing === 'number' && Number.isFinite(rawSpacing))
        ? Math.max(4, Math.min(24, Math.round(rawSpacing)))
        : cur.messageSpacing;

      return {
        ...state,
        preferences: {
          ...state.preferences,
          reading: {
            fontFamily: nextFamily,
            fontSize: nextSize,
            lineHeight: nextLh,
            messageSpacing: nextSpacing,
            customFontCss: typeof action.reading.customFontCss === 'string' ? action.reading.customFontCss : cur.customFontCss,
            customFontStyle: typeof action.reading.customFontStyle === 'string' ? action.reading.customFontStyle : cur.customFontStyle,
          },
        },
      };
    }

    case 'hideMessagesFromWindow': {
      const targetSet = new Set(action.messageIds);
      return {
        ...state,
        messages: state.messages.map((m) =>
          targetSet.has(m.id) ? { ...m, hiddenFromWindow: true } : m
        ),
      };
    }

    case 'unhideMessagesToWindow': {
      const targetSet = new Set(action.messageIds);
      return {
        ...state,
        messages: state.messages.map((m) =>
          targetSet.has(m.id) ? { ...m, hiddenFromWindow: false } : m
        ),
      };
    }

    case 'purgeMessagesPermanently': {
      const targetSet = new Set(action.messageIds);
      if (targetSet.size === 0) return state;

      // 1. 物理过滤被删消息
      const remainingMessages = state.messages.filter((m) => !targetSet.has(m.id));

      // 2. 墓碑持久记录（不含正文，防止旧备份/流式迟到复活）
      const prevPurged = Array.isArray(state.purgedMessageIds) ? state.purgedMessageIds : [];
      const newPurgedSet = new Set(prevPurged);
      for (const id of action.messageIds) newPurgedSet.add(id);
      const purgedMessageIds = Array.from(newPurgedSet);
      const purgedMessageEpoch = (state.purgedMessageEpoch || 0) + 1;

      // 3. 关联长时记忆清理（派生自被删消息的记忆彻底清除）
      const remainingMemories = (state.memories || []).filter((mem) => {
        if (mem.sourceMessageId && targetSet.has(mem.sourceMessageId)) return false;
        return true;
      });

      // 4. 关联上下文检查点清理（被删消息快照受影响的检查点彻底清除）
      const remainingCheckpoints = (state.checkpoints || []).filter((cp) => {
        if (Array.isArray(cp.sourceMessageSnapshots)) {
          const hasPurged = cp.sourceMessageSnapshots.some((s) => targetSet.has(s.id));
          if (hasPurged) return false;
        }
        return true;
      });

      // 5. 关联 MemoryGateway outbox 清理
      const remainingOutbox = (state.memoryGatewayOutbox || []).filter((item) => {
        if (Array.isArray(item.messageIds)) {
          return !item.messageIds.some((id) => targetSet.has(id));
        }
        return true;
      });

      // 6. 受影响成员的 Codex 专属 Thread 清除（断开被污染旧 thread，确保下次从干净记忆新建）
      const affectedAgents = new Set(action.affectedAgentIds || []);
      for (const m of state.messages) {
        if (targetSet.has(m.id)) {
          const conv = state.conversations.find((c) => c.id === m.conversationId);
          if (conv?.kind === 'direct' && conv.agentId) {
            affectedAgents.add(conv.agentId);
          } else if (conv?.kind === 'living-room') {
            for (const ag of state.agents) {
              if (ag.kind === 'ai' && (ag.canonicalCodexThreadId || ag.profileId)) {
                affectedAgents.add(ag.id);
              }
            }
          }
        }
      }

      const prevPurgedThreads = Array.isArray(state.purgedThreadIds) ? state.purgedThreadIds : [];
      const newPurgedThreadSet = new Set(prevPurgedThreads);

      for (const ag of state.agents) {
        if (affectedAgents.has(ag.id) && ag.canonicalCodexThreadId) {
          newPurgedThreadSet.add(ag.canonicalCodexThreadId);
        }
      }
      for (const c of state.conversations) {
        if (c.codexThreadId && (c.kind === 'living-room' || (c.kind === 'direct' && c.agentId && affectedAgents.has(c.agentId)))) {
          newPurgedThreadSet.add(c.codexThreadId);
        }
      }
      for (const p of state.chatProfiles || []) {
        const isAffected = state.agents.some((a) => affectedAgents.has(a.id) && a.profileId === p.id);
        if (isAffected) {
          if (p.codexThreadId) newPurgedThreadSet.add(p.codexThreadId);
          if (p.canonicalCodexThreadId) newPurgedThreadSet.add(p.canonicalCodexThreadId);
        }
      }

      const nextAgents = state.agents.map((a) => {
        if (affectedAgents.has(a.id)) {
          const copy = { ...a };
          delete copy.canonicalCodexThreadId;
          return copy;
        }
        return a;
      });

      const nextConversations = state.conversations.map((c) => {
        if (c.kind === 'direct' && c.agentId && affectedAgents.has(c.agentId)) {
          const copy = { ...c };
          delete copy.codexThreadId;
          return copy;
        }
        if (c.kind === 'living-room') {
          const copy = { ...c };
          delete copy.codexThreadId;
          return copy;
        }
        return c;
      });

      const nextProfiles = (state.chatProfiles || []).map((p) => {
        const isAffected = state.agents.some((a) => affectedAgents.has(a.id) && a.profileId === p.id);
        if (isAffected) {
          const copy = { ...p };
          delete copy.codexThreadId;
          delete copy.canonicalCodexThreadId;
          return copy;
        }
        return p;
      });

      return {
        ...state,
        messages: remainingMessages,
        purgedMessageIds,
        purgedMessageEpoch,
        purgedThreadIds: Array.from(newPurgedThreadSet),
        memories: remainingMemories,
        checkpoints: remainingCheckpoints,
        memoryGatewayOutbox: remainingOutbox,
        agents: nextAgents,
        conversations: nextConversations,
        chatProfiles: nextProfiles,
      };
    }

    default:
      return touch(state);
  }
}
