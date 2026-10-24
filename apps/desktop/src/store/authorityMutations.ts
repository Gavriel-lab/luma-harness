import type { AppData, Ticket, Message, ContextCheckpoint, TaskItem, ProjectPlan } from '../types';

export type AuthorityMutation =
  | { operation: 'create-ticket'; requestId: string; ticket: Ticket }
  | { operation: 'reject-review'; requestId: string; ticketId: string; taskId: string; assigneeId: string; jobId: string; decision: NonNullable<Ticket['reviewDecisions']>[number] }
  | { operation: 'ticket-origin-reported'; requestId: string; ticketId: string }
  | { operation: 'approve-plan'; requestId: string; ticketId: string; planVersion: number; approvedAt: number; approvedBy: 'user' }
  | { operation: 'user-accept-project'; requestId: string; ticketId: string; userAcceptedAt: number; userAcceptedBy: 'user'; feedback?: string }
  | { operation: 'user-revise-project'; requestId: string; ticketId: string; feedback: string; scopeExpansion?: boolean; scopeDecision?: NonNullable<Ticket['scopeDecisions']>[number] }
  | { operation: 'patch-task'; requestId: string; ticketId: string; taskId: string; patch: Partial<TaskItem> }
  | { operation: 'update-plan'; requestId: string; ticketId: string; plan: ProjectPlan }
  | { type: 'mobile-chat'; messages: Message[] }
  | { type: 'companion-message'; message: Message }
  | { type: 'mobile-message-delete'; conversationId: string; messageId: string; mode: 'hide' | 'purge'; part?: string }
  | { type: 'mobile-chat-events'; requestId: string; conversationId: string; messageId: string; delta?: string; finalText?: string; receipt?: Message['memoryReceipt']; updatedCheckpoints?: ContextCheckpoint[]; status?: 'sent' | 'error' | 'stopped'; error?: string };

/** Main-process commands only. This function cannot patch persona, permissions,
 * settings or arbitrary messages; it preserves all unrelated current state. */
export function applyAuthorityMutation(state: AppData, command: AuthorityMutation): AppData {
  if ('operation' in command && command.operation === 'approve-plan') {
    const ticket = state.tickets.find(t => t.id === command.ticketId);
    if (!ticket) return state;
    if (ticket.plan && ticket.plan.version !== command.planVersion) return state;
    const plan = ticket.plan ? {
      ...ticket.plan,
      status: 'approved' as const,
      approvedAt: command.approvedAt,
      approvedBy: 'user' as const,
    } : undefined;
    const goal = (plan && plan.goal) ? plan.goal : ticket.goal;
    const tasks = (plan && Array.isArray(plan.tasks) && plan.tasks.length > 0) ? plan.tasks.map(t => ({
      id: t.id,
      title: t.title,
      assigneeId: t.assigneeId ?? null,
      status: 'todo' as const,
      acceptance: t.acceptance,
      dependencies: Array.isArray(t.dependencies) ? t.dependencies : [],
      deliverables: t.deliverables
    })) : ticket.tasks;
    return {
      ...state,
      tickets: state.tickets.map(t => t.id === ticket.id ? {
        ...t,
        stage: 'in_progress' as const,
        approvedPlanVersion: command.planVersion,
        plan,
        goal,
        tasks,
        updatedAt: command.approvedAt,
      } : t),
    };
  }
  if ('operation' in command && command.operation === 'user-accept-project') {
    const ticket = state.tickets.find(t => t.id === command.ticketId);
    if (!ticket) return state;
    return {
      ...state,
      tickets: state.tickets.map(t => t.id === ticket.id ? {
        ...t,
        stage: 'completed' as const,
        userAcceptedAt: command.userAcceptedAt,
        userAcceptedBy: 'user' as const,
        userFeedback: command.feedback || t.userFeedback,
        updatedAt: command.userAcceptedAt,
      } : t),
    };
  }
  if ('operation' in command && command.operation === 'user-revise-project') {
    const ticket = state.tickets.find(t => t.id === command.ticketId);
    if (!ticket) return state;
    const isUnapprovedDraft = ticket.plan ? (ticket.stage === 'draft' || ticket.approvedPlanVersion === undefined || ticket.plan.status === 'draft') : false;
    const isExpanded = command.scopeExpansion === true;

    if (isUnapprovedDraft) {
      // 未批准草案的修改反馈：保持 draft 状态，绝不自动批准
      const plan = ticket.plan ? {
        ...ticket.plan,
        status: 'draft' as const,
      } : undefined;
      return {
        ...state,
        tickets: state.tickets.map(t => t.id === ticket.id ? {
          ...t,
          stage: 'draft' as const,
          plan,
          userFeedback: command.feedback,
          scopeDecisions: command.scopeDecision ? [...(t.scopeDecisions || []), command.scopeDecision] : t.scopeDecisions,
          updatedAt: Date.now(),
        } : t),
      };
    }

    if (isExpanded) {
      // 已批准项目的实质扩范围：升为新版草案并等待重新批准，撤销旧授权
      const plan = ticket.plan ? {
        ...ticket.plan,
        version: (ticket.plan.version || 1) + 1,
        status: 'draft' as const,
        approvedAt: undefined,
        approvedBy: undefined,
      } : undefined;
      return {
        ...state,
        tickets: state.tickets.map(t => t.id === ticket.id ? {
          ...t,
          stage: 'draft' as const,
          plan,
          approvedPlanVersion: undefined,
          userFeedback: command.feedback,
          scopeDecisions: command.scopeDecision ? [...(t.scopeDecisions || []), command.scopeDecision] : t.scopeDecisions,
          updatedAt: Date.now(),
        } : t),
      };
    }

    // 已批准范围内的微调：保持 in_progress 推进，递增修订轮次
    const plan = ticket.plan ? {
      ...ticket.plan,
      status: 'approved' as const,
    } : undefined;
    const revisionRound = (ticket.revisionRound || 0) + 1;
    const isArrayAffected = Array.isArray(command.scopeDecision?.affectedTaskIds);
    const affectedSet = isArrayAffected ? new Set(command.scopeDecision!.affectedTaskIds) : null;
    return {
      ...state,
      tickets: state.tickets.map(t => t.id === ticket.id ? {
        ...t,
        stage: 'in_progress' as const,
        originReported: false,
        revisionRound,
        plan,
        userFeedback: command.feedback,
        scopeDecisions: command.scopeDecision ? [...(t.scopeDecisions || []), command.scopeDecision] : t.scopeDecisions,
        tasks: t.tasks.map(k => (affectedSet ? affectedSet.has(k.id) : true) ? { ...k, status: 'todo' as const } : k),
        updatedAt: Date.now(),
      } : t),
    };
  }
  if ('operation' in command && command.operation === 'patch-task') {
    const ticket = state.tickets.find(t => t.id === command.ticketId);
    if (!ticket) return state;
    return {
      ...state,
      tickets: state.tickets.map(t => t.id === ticket.id ? {
        ...t,
        tasks: t.tasks.map(k => k.id === command.taskId ? { ...k, ...command.patch } : k),
        updatedAt: Date.now(),
      } : t),
    };
  }
  if ('operation' in command && command.operation === 'update-plan') {
    const ticket = state.tickets.find(t => t.id === command.ticketId);
    if (!ticket) return state;
    const isDraft = command.plan.status === 'draft';
    const isNewVersion = ticket.approvedPlanVersion === undefined || command.plan.version !== ticket.approvedPlanVersion;
    const shouldInvalidateAuth = ticket.stage === 'in_progress' && (isDraft || isNewVersion);
    const newStage = shouldInvalidateAuth ? 'draft' as const : ticket.stage;
    return {
      ...state,
      tickets: state.tickets.map(t => t.id === ticket.id ? {
        ...t,
        plan: command.plan,
        stage: newStage,
        updatedAt: Date.now(),
      } : t),
    };
  }
  if ('type' in command && command.type === 'companion-message') {
    const m = command.message;
    const conv = state.conversations.find(c => c.id === m?.conversationId && ((c.kind === 'direct' && c.agentId === m.agentId) || c.kind === 'living-room'));
    if (!conv || m.sourceChannel !== 'luma' || !m.requestId || !m.text.trim() || m.status !== 'sent' || m.demo || !Number.isFinite(m.createdAt)) return state;
    if (!state.agents.some(a => a.id === m.agentId && a.kind === 'ai' && !a.removed) || state.messages.some(x => x.id === m.id) || state.purgedMessageIds?.includes(m.id)) return state;
    return { ...state, messages: [...state.messages, m] };
  }
  if ('operation' in command && command.operation === 'ticket-origin-reported') {
    const ticket = state.tickets.find(t => t.id === command.ticketId);
    if (!ticket || ticket.originReported) return state;
    return {
      ...state,
      tickets: state.tickets.map(t => t.id === ticket.id ? { ...t, originReported: true, stage: 'pending_user_acceptance' as const, updatedAt: Date.now() } : t)
    };
  }
  if ('operation' in command && command.operation === 'create-ticket') {
    const ticket=command.ticket;
    if(state.tickets.some(t=>t.id===ticket.id))return state;
    if(!ticket.tasks.length||ticket.tasks.some(task=>task.status!=='todo'||!state.agents.some(a=>a.id===task.assigneeId&&a.kind==='ai'&&!a.removed)))return state;
    if(state.tickets.some(t=>t.tasks.some(x=>ticket.tasks.some(y=>y.id===x.id))))return state;
    return {...state,tickets:[...state.tickets,ticket],activeTicketId:ticket.id};
  }
  if ('operation' in command && command.operation === 'reject-review') {
    const ticket=state.tickets.find(t=>t.id===command.ticketId),task=ticket?.tasks.find(t=>t.id===command.taskId);
    if(!ticket||!task||task.assigneeId!==command.assigneeId||task.status==='done'||ticket.reviewDecisions?.some(d=>d.requestId===command.requestId))return state;
    const decision={...command.decision,jobId:command.jobId,taskId:command.taskId};
    const marker=`【审查退回 ${command.jobId}/${decision.reportId}】`;
    return {...state,tickets:state.tickets.map(t=>t.id!==ticket.id?t:{...t,updatedAt:decision.at,reviewDecisions:[...(t.reviewDecisions||[]),decision],discussion:{updatedAt:decision.at,text:[t.discussion.text,marker,decision.reason].filter(Boolean).join('\n')},tasks:t.tasks.map(k=>k.id===task.id?{...k,status:'todo'}:k)})};
  }
  if ('type' in command && command.type==='mobile-chat') {
    if(!Array.isArray(command.messages)||command.messages.length<2)return state;
    const [user,...replies]=command.messages;
    if(!user||replies.length>state.agents.filter(a=>a.kind==='ai'&&!a.removed).length)return state;
    const conv=state.conversations.find(c=>c.id===user.conversationId);
    if(!conv||!['direct','living-room'].includes(conv.kind)||user.agentId!=='agent_owner'||!user.requestId||new Set(command.messages.map(m=>m.id)).size!==command.messages.length||new Set(replies.map(m=>m.agentId)).size!==replies.length)return state;
    if(conv.kind==='direct'&&(replies.length!==1||replies[0]?.agentId!==conv.agentId))return state;
    if(replies.some(m=>m.conversationId!==conv.id||m.requestId!==user.requestId||!state.agents.some(a=>a.id===m.agentId&&a.kind==='ai'&&!a.removed)))return state;
    if(state.messages.some(m=>command.messages.some(n=>n.id===m.id))||state.purgedMessageIds?.some(id=>command.messages.some(m=>m.id===id)))return state;
    return {...state,messages:[...state.messages,...command.messages]};
  }
  if ('type' in command && command.type==='mobile-chat-events') {
    const target=state.messages.find(m=>m.id===command.messageId&&m.requestId===command.requestId&&m.conversationId===command.conversationId&&m.status==='streaming');
    if(!target)return state;
    const checkpoints=command.updatedCheckpoints?.filter(cp=>cp.conversationId===command.conversationId&&!(cp.sourceMessageSnapshots||[]).some(s=>state.purgedMessageIds?.includes(s.id)));
    const receipt=command.receipt||target.memoryReceipt;
    const memoryReceipt=receipt&&command.status?{...receipt,status:command.status==='sent'?'completed' as const:command.status==='stopped'?'cancelled' as const:'failed' as const,error:command.error}:receipt;
    return {...state,messages:state.messages.map(m=>m.id!==target.id?m:{...m,text:command.status&&typeof command.finalText==='string'?command.finalText:m.text+(command.delta||''),...(memoryReceipt?{memoryReceipt}:{}),...(command.status?{status:command.status,error:command.error}: {})}),...(checkpoints?{checkpoints:[...(state.checkpoints||[]).filter(cp=>!checkpoints.some(n=>n.id===cp.id)),...checkpoints]}:{})};
  }
  return state;
}
