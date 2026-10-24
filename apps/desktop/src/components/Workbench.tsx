import { useEffect, useRef, useState } from 'react';
import { Check, ClipboardList, Plus, Trash2, X, Circle, CircleDot, Eye, CircleCheckBig, Play, CheckCircle2, RotateCcw, AlertTriangle } from 'lucide-react';
import type { Store } from '../ui/useAppStore';
import type { ConfirmRequest } from './Overlays';
import { TASK_STATUS_LABEL, type TaskStatus, type ProjectStage, type Ticket, type Agent } from '../types';
import { Avatar } from './Avatar';
import { BridgeControls, type BridgeSnapshot } from './BridgeControls';

const STATUS_ICON: Record<TaskStatus, typeof Circle> = {
  todo: Circle,
  doing: CircleDot,
  review: Eye,
  done: CircleCheckBig,
};

const STAGE_LABELS: Record<ProjectStage, string> = {
  draft: '方案草案 · 待开工',
  in_progress: '协调者统筹推进中',
  pending_user_acceptance: '自检通过 · 待使用者验收',
  completed: '已验收完成',
  revised: '方案修订中 · 待重新开工',
};

/** 交付分母来自既定方案；过程事件和重试不增加完成度。旧项目明确标出口径。 */
export function workbenchSummary(ticket: Ticket, snapshot: BridgeSnapshot | null) {
  const latest = ticket.tasks.map(task => ({ task, job: snapshot?.jobs.filter(j =>
    j.kind === 'work' && j.ticketId === ticket.id && j.taskId === task.id).at(-1),
  })).filter(({ task, job }) => !job || job.agentId === task.assigneeId);
  const resultBased = !!ticket.plan?.tasks.length && ticket.plan.tasks.every(t => !!t.deliverables?.trim() && !!t.acceptance?.trim());
  const targets = resultBased ? ticket.plan!.tasks : ticket.tasks;
  const completed = targets.filter(target => {
    const item = latest.find(x => x.task.id === target.id);
    return item?.task.status === 'done' && (item.job ? item.job.state === 'done' : !resultBased);
  }).length;
  const percent = targets.length ? Math.round(completed / targets.length * 100) : 0;
  const active = latest.filter(({ job }) => ticket.stage === 'in_progress' && job?.state === 'doing' && snapshot?.registrations.some(r => r.agentId === job.agentId && r.connected))
    .map(({ task, job }) => ({ agentId: job!.agentId, title: task.title, reviewing: false }));
  for (const job of snapshot?.jobs ?? []) {
    if (ticket.stage !== 'in_progress' || job.ticketId !== ticket.id || job.kind !== 'coordination' || job.state !== 'doing') continue;
    const item = latest.find(x => x.task.id === job.taskId && x.job?.state === 'review');
    if (item) active.push({ agentId: job.agentId, title: item.task.title, reviewing: true });
  }
  const issueLabels: Record<string, string> = { blocked: '遇到阻塞', question: '等待答复', permission_required: '等待权限', offline: '连接中断，等待恢复', failed: '执行失败', rejected: '等待返修' };
  const issue = latest.find(({ job }) => job && issueLabels[job.state]);
  const doing = latest.find(({ job }) => job?.state === 'doing');
  const review = latest.find(({ job }) => job?.state === 'review');
  const waiting = latest.find(({ job }) => job?.state === 'queued');
  const stage = ticket.stage;
  const current = stage === 'completed' ? '成果已由你确认验收。'
    : stage === 'pending_user_acceptance' ? '成果已备齐，等你看看是否满意。'
    : stage === 'draft' || stage === 'revised' ? '方案准备中，确认后由协调者安排执行。'
    : issue ? `${issue.task.title} · ${issueLabels[issue.job!.state]}`
    : doing ? `${doing.task.title} · ${active.some(a => a.agentId === doing.job?.agentId) ? '正在执行' : '执行状态待同步'}`
    : review ? `${review.task.title} · 等待协调者审核`
    : waiting ? `${waiting.task.title} · 等待领取`
    : snapshot ? '协调者正在衔接后续工作。' : '正在同步后台进展…';
  return { active, current, completed, total: targets.length, percent, resultBased, hasIssue: !!issue };
}

export function workbenchMembers(ticket: Ticket, agents: Agent[], snapshot: BridgeSnapshot | null) {
  const summary = workbenchSummary(ticket, snapshot);
  const ids = new Set(['agent_coordinator', ...ticket.participantIds, ...ticket.tasks.map(t => t.assigneeId)]);
  const labels: Record<string, string> = { queued: '等待开始', doing: '状态待同步', review: '待审核', offline: '待恢复', blocked: '遇到阻塞', question: '等待答复', permission_required: '等待权限', failed: '执行失败', rejected: '待返修', cancelling: '正在取消', cancelled: '已取消' };
  return agents.filter(a => a.kind === 'ai' && !a.removed).map(agent => {
    const participating = ids.has(agent.id);
    const activity = summary.active.filter(a => a.agentId === agent.id);
    const assigned = ticket.tasks.filter(t => t.assigneeId === agent.id);
    const jobs = assigned.map(task => snapshot?.jobs.filter(j => j.kind === 'work' && j.ticketId === ticket.id && j.taskId === task.id).at(-1))
      .filter(j => j?.agentId === agent.id);
    const issue = jobs.find(j => j && ['offline', 'blocked', 'question', 'permission_required', 'failed', 'rejected'].includes(j.state));
    const pending = jobs.find(j => j && labels[j.state]);
    const accepted = assigned.length > 0 && assigned.every(task => {
      const job = jobs.find(j => j?.taskId === task.id);
      return task.status === 'done' && (!job || job.state === 'done');
    });
    const coordinator = agent.id === 'agent_coordinator';
    const coordinating = coordinator && ticket.stage !== 'completed' && ticket.stage !== 'pending_user_acceptance';
    const state = !participating ? 'idle' : activity.length ? (activity.some(a => a.reviewing) ? 'coordinator' : 'working')
      : issue ? 'attention' : coordinating ? 'coordinator'
      : ticket.stage === 'completed' || accepted ? 'accepted' : 'idle';
    const label = !participating ? '未参与' : activity.length ? (activity.some(a => a.reviewing) ? '审核中' : '执行中')
      : issue ? labels[issue.state] : coordinating ? '统筹'
      : ticket.stage === 'completed' || accepted ? '已完成'
      : !snapshot ? '同步中' : pending ? labels[pending.state] : assigned.length ? '待开始' : '参与项目';
    return { agent, state, label, active: activity.length > 0, detail: activity.map(a => a.title).join('、') };
  });
}

export function Workbench({
  store,
  onRequestDelete,
  onCloseDrawer,
  modal,
}: {
  store: Store;
  onRequestDelete: (req: ConfirmRequest) => void;
  onCloseDrawer: () => void;
  modal: boolean;
}) {
  const { data, dispatch } = store;
  const ticket = data.tickets.find((t) => t.id === data.activeTicketId) ?? null;
  const [newTask, setNewTask] = useState('');
  const [bridgeSnapshot, setBridgeSnapshot] = useState<BridgeSnapshot | null>(null);
  const [busyAction, setBusyAction] = useState(false);
  const [reviseNote, setReviseNote] = useState('');
  const [showReviseInput, setShowReviseInput] = useState(false);
  const [actionError, setActionError] = useState('');

  const latestJob = (taskId: string) => bridgeSnapshot?.jobs.filter(j => j.kind === 'work' && j.ticketId === ticket?.id && j.taskId === taskId).at(-1);
  const locked = (taskId: string) => { const job = latestJob(taskId); return !!job && !['failed', 'cancelled'].includes(job.state); };
  const [flashId, setFlashId] = useState<string | null>(null);
  const firstRender = useRef(true);

  useEffect(() => {
    setFlashId(null);
    setShowReviseInput(false);
    setActionError('');
    firstRender.current = true;
  }, [data.activeTicketId]);

  const open = data.workbenchOpen;
  const asideRef = useRef<HTMLElement>(null);

  useEffect(() => {
    asideRef.current?.toggleAttribute('inert', !open);
  }, [open]);

  const currentStage: ProjectStage = ticket?.stage || (ticket?.userAcceptedAt ? 'completed' : 'draft');
  const planVersion = ticket?.plan?.version || 1;
  const summary = ticket ? workbenchSummary(ticket, bridgeSnapshot) : null;
  const members = ticket ? workbenchMembers(ticket, data.agents, bridgeSnapshot) : [];
  const [showArtifacts, setShowArtifacts] = useState(false);
  useEffect(() => { setShowArtifacts(false); }, [data.activeTicketId]);

  // 使用者批准开工
  const handleApprovePlan = async () => {
    if (!ticket || busyAction) return;
    setBusyAction(true);
    setActionError('');
    try {
      if (store.flushSave) {
        const saved = await store.flushSave();
        if (saved === false) {
          setActionError('保存方案失败，无法批准开工');
          return;
        }
      }
      const bridge = window.xiaowuDesktop?.bridge;
      if (!bridge?.approvePlan) {
        setActionError('当前客户端未连接或版本尚未支持协作运行时');
        return;
      }
      const res = await bridge.approvePlan(ticket.id, planVersion);
      if (res?.ok) {
        dispatch({ type: 'approvePlan', ticketId: ticket.id, planVersion });
      } else {
        setActionError(res?.reason || (res as any)?.message || '开工调度失败');
      }
    } catch (e: any) {
      setActionError(e.message || '开工批准异常');
    } finally {
      setBusyAction(false);
    }
  };

  // 使用者确认最终验收
  const handleUserAccept = async () => {
    if (!ticket || busyAction) return;
    setBusyAction(true);
    setActionError('');
    try {
      if (store.flushSave) {
        const saved = await store.flushSave();
        if (saved === false) {
          setActionError('保存失败，无法确认验收');
          return;
        }
      }
      const bridge = window.xiaowuDesktop?.bridge;
      if (!bridge?.userAccept) {
        setActionError('当前客户端未连接或版本尚未支持协作运行时');
        return;
      }
      const res = await bridge.userAccept(ticket.id);
      if (res?.ok) {
        dispatch({ type: 'userAcceptProject', ticketId: ticket.id });
      } else {
        setActionError(res?.reason || (res as any)?.message || '确认验收失败');
      }
    } catch (e: any) {
      setActionError(e.message || '确认验收异常');
    } finally {
      setBusyAction(false);
    }
  };

  // 使用者提出需要修改
  const handleUserRevise = async () => {
    if (!ticket || busyAction || !reviseNote.trim()) return;
    setBusyAction(true);
    setActionError('');
    try {
      if (store.flushSave) {
        const saved = await store.flushSave();
        if (saved === false) {
          setActionError('保存失败，无法提交修改意见');
          return;
        }
      }
      const bridge = window.xiaowuDesktop?.bridge;
      if (!bridge?.userRevise) {
        setActionError('当前客户端未连接或版本尚未支持协作运行时');
        return;
      }
      const res = await bridge.userRevise(ticket.id, reviseNote.trim());
      if (res?.ok) {
        dispatch({ type: 'userReviseProject', ticketId: ticket.id, feedback: reviseNote.trim() });
        setShowReviseInput(false);
        setReviseNote('');
      } else {
        setActionError(res?.reason || (res as any)?.message || '提交修改意见失败');
      }
    } catch (e: any) {
      setActionError(e.message || '提交修改异常');
    } finally {
      setBusyAction(false);
    }
  };

  return (
    <aside
      ref={asideRef}
      className={`panel workbench ${open ? '' : 'is-collapsed'}`}
      aria-label="工作桌"
      role={modal ? 'dialog' : undefined}
      aria-modal={modal ? true : undefined}
      aria-hidden={!open}
    >
      <div className="panel__head">
        <ClipboardList size={15} aria-hidden />
        <p className="panel__title">工作台</p>
        <div className="topbar__spacer" />
        <button
          className="btn btn--icon narrow-only"
          onClick={onCloseDrawer}
          aria-label="关闭工作桌"
        >
          <X size={16} aria-hidden />
        </button>
      </div>

      <div className="workbench__body">
        {/* 工单切换区 */}
        <section className="field">
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <label className="field__label" htmlFor="workbench-project">当前项目</label>
            <div className="topbar__spacer" />
            <button
              className="btn btn--icon"
              title="新建工单"
              aria-label="新建工单"
              onClick={() => dispatch({ type: 'createTicket' })}
            >
              <Plus size={15} aria-hidden />
            </button>
          </div>
          <select id="workbench-project" className="input" value={ticket?.id ?? ''} onChange={e => dispatch({ type: 'selectTicket', ticketId: e.target.value })}>
            {!ticket && <option value="">选择一个项目</option>}
            {data.tickets.map((t) => (
              <option key={t.id} value={t.id}>{t.title || '未命名项目'}</option>
            ))}
          </select>
        </section>

        {!ticket ? (
          <div className="demo-banner">还没有工单。点上面的 + 建一张。</div>
        ) : (
          <>
            <section className="workbench-overview" aria-label="项目进展总览">
              <h2>{ticket.title || '未命名项目'}</h2>
              <div className="workbench-overview__current" data-issue={summary?.hasIssue}>
                <span className="workbench-overview__label">现在在做什么</span>
                <p role="status">{summary?.current}</p>
              </div>
              <div className="workbench-overview__progress">
                <div><span className="workbench-overview__label">交付进度</span><strong>{summary?.percent}%</strong></div>
                <progress aria-label="交付进度" max={summary?.total || 1} value={summary?.completed || 0} />
                <small>{summary?.resultBased ? '已审核交付项' : '已完成任务（旧项目口径）'} {summary?.completed} / {summary?.total}</small>
                {currentStage === 'pending_user_acceptance' && <small>成果就绪 · 最终验收由你确认</small>}
              </div>
              <div>
                <span className="workbench-overview__label">成员状态 · 正在工作 {members.filter(m => m.active).length} 人</span>
                <div className="workbench-overview__members">
                  {members.map(({ agent, state, label, detail }) => <div key={agent.id} className="workbench-overview__member" title={[agent.name, label, detail].filter(Boolean).join(' · ')}>
                    <span className="workbench-member-avatar"><Avatar agent={agent} style={{ width: 30, height: 30 }} /><i className="workbench-member-dot" data-state={state} aria-hidden="true" /></span>
                    <div><strong>{agent.name}</strong><span>{label}</span></div>
                  </div>)}
                </div>
                <small>协调者负责统筹、巡查与最后交接</small>
              </div>
              <button className="btn workbench-overview__results" aria-expanded={showArtifacts} onClick={() => setShowArtifacts(v => !v)}>
                {showArtifacts ? '收起成果' : '查看成果'}
              </button>
              {showArtifacts && <div className="workbench-overview__artifacts">{ticket.artifacts.text || '成果还在准备中，交付后会汇总在这里。'}</div>}
            </section>
            {/* 核心中枢 1：项目方案与开工/验收协同卡片 */}
            <div className="workbench-plan-card" aria-label="项目方案与推进中枢">
              <div className="workbench-plan-card__header">
                <span className="workbench-stage-badge" data-stage={currentStage}>
                  {STAGE_LABELS[currentStage]}
                </span>
              </div>

              {actionError && (
                <div className="attachment-hint attachment-hint--error" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <AlertTriangle size={13} aria-hidden /> {actionError}
                </div>
              )}

              {/* 操作区：按阶段呈现清晰动作 */}
              <div className="workbench-plan-card__actions">
                {(currentStage === 'draft' || currentStage === 'revised') && (
                  <>
                    <button
                      className="workbench-btn-primary"
                      disabled={busyAction}
                      onClick={handleApprovePlan}
                      title="批准此方案并开始执行"
                    >
                      <Play size={14} fill="currentColor" aria-hidden /> 批准方案 · 点击开工
                    </button>
                    <small style={{ color: 'var(--ink-3)', fontSize: '11px', textAlign: 'center' }}>
                      使用者点击开工后，协调者将依据成员能力自动安排派单，无需手动分工
                    </small>
                  </>
                )}

                {currentStage === 'in_progress' && (
                  <div style={{ background: '#f2f6fb', padding: '8px 10px', borderRadius: '8px', fontSize: '12px', color: '#2b5c8f' }}>
                    <strong>协调者统筹协调中：</strong>
                    <div style={{ marginTop: 2, fontSize: '11.5px', color: '#4a6f99' }}>
                      内部执行与审核在后台汇总，成果就绪后由协调者交给你。
                    </div>
                  </div>
                )}

                {currentStage === 'pending_user_acceptance' && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <div style={{ fontSize: '12px', color: '#825910', background: '#fdf7eb', padding: '8px 10px', borderRadius: '8px' }}>
                      <strong>协调者内部自检已通过！</strong>
                      <div>各子任务均已完成，成果已在下方备齐，请使用者最终验收。</div>
                    </div>
                    <button
                      className="workbench-btn-primary workbench-btn-success"
                      disabled={busyAction}
                      onClick={handleUserAccept}
                      title="确认成果满意，完成项目"
                    >
                      <CheckCircle2 size={15} aria-hidden /> 成果满意 · 确认最终验收
                    </button>
                    {!showReviseInput ? (
                      <button
                        className="btn btn--ghost"
                        style={{ fontSize: '12px', color: 'var(--ink-2)' }}
                        disabled={busyAction}
                        onClick={() => setShowReviseInput(true)}
                      >
                        <RotateCcw size={13} aria-hidden /> 需要调整或补充要求
                      </button>
                    ) : (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4 }}>
                        <textarea
                          className="textarea"
                          style={{ minHeight: 50, fontSize: '12px' }}
                          placeholder="填写需要调整的意见，协调者将组织返修…"
                          value={reviseNote}
                          onChange={(e) => setReviseNote(e.target.value)}
                        />
                        <div style={{ display: 'flex', gap: 6 }}>
                          <button
                            className="btn btn--danger"
                            style={{ flex: 1, fontSize: '12px' }}
                            disabled={busyAction || !reviseNote.trim()}
                            onClick={handleUserRevise}
                          >
                            提交修改意见
                          </button>
                          <button
                            className="btn btn--ghost"
                            style={{ fontSize: '12px' }}
                            onClick={() => setShowReviseInput(false)}
                          >
                            取消
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {currentStage === 'completed' && (
                  <div style={{ background: '#edf7ee', padding: '8px 10px', borderRadius: '8px', fontSize: '12px', color: '#2b6f34', textAlign: 'center' }}>
                    <CheckCircle2 size={16} style={{ verticalAlign: 'middle', marginRight: 4 }} aria-hidden />
                    <strong>项目已圆满完成（使用者已验收）</strong>
                  </div>
                )}
              </div>
            </div>

            <details key={ticket.id} className="workbench-project-details">
              <summary>方案、分工与编辑</summary>
            {/* 标题与目标 */}
            <section className="field">
              <label className="field__label" htmlFor="ticket-title">
                标题
              </label>
              <input
                id="ticket-title"
                className="input"
                value={ticket.title}
                maxLength={60}
                onChange={(e) => dispatch({ type: 'patchTicket', ticketId: ticket.id, patch: { title: e.target.value } })}
              />
              <label className="field__label" htmlFor="ticket-goal" style={{ marginTop: 8 }}>
                目标与方案范围
              </label>
              <textarea
                id="ticket-goal"
                className="textarea"
                style={{ minHeight: 58 }}
                value={ticket.goal}
                maxLength={400}
                placeholder="这张工单要达成什么？"
                onChange={(e) => dispatch({ type: 'patchTicket', ticketId: ticket.id, patch: { goal: e.target.value } })}
              />
            </section>

            {/* 方案标准与交付物呈现 */}
            {ticket.plan && (
              <section className="field" style={{ background: 'rgba(0, 0, 0, 0.03)', padding: '10px 12px', borderRadius: 8 }}>
                <span className="field__label" style={{ fontWeight: 600, color: 'var(--text-primary)' }}>
                  方案规格详情（v{ticket.plan.version} · {(STAGE_LABELS as Record<string, string>)[ticket.plan.status] || ticket.plan.status}）
                </span>
                {ticket.plan.deliverables && (
                  <div style={{ fontSize: 12, marginTop: 4, color: 'var(--text-secondary)' }}>
                    <strong style={{ color: 'var(--text-primary)' }}>预期交付物：</strong>
                    {ticket.plan.deliverables}
                  </div>
                )}
                {ticket.plan.acceptanceCriteria && (
                  <div style={{ fontSize: 12, marginTop: 4, color: 'var(--text-secondary)' }}>
                    <strong style={{ color: 'var(--text-primary)' }}>验收标准：</strong>
                    {ticket.plan.acceptanceCriteria}
                  </div>
                )}
              </section>
            )}

            {/* 参与成员指示 */}
            <section className="field">
              <span className="field__label">参与成员 · 蓝：统筹 · 黄：执行中 · 绿：已验收</span>
              <div className="chips">
                {data.agents
                  .filter((a) => a.kind === 'ai' && !a.removed)
                  .map((a) => {
                    const on = ticket.participantIds.includes(a.id);
                    const assigned = ticket.tasks.filter(t => t.assigneeId === a.id).map(t => latestJob(t.id)).filter(Boolean);
                    const workStatus = on && a.id === 'agent_coordinator' ? 'coordinator' : assigned.some(j => j && !['done', 'failed', 'cancelled', 'review'].includes(j.state)) ? 'working' : assigned.length > 0 && assigned.every(j => j?.state === 'done') ? 'accepted' : undefined;
                    return (
                      <button
                        key={a.id}
                        className="chip"
                        aria-pressed={on}
                        title={workStatus === 'coordinator' ? '统筹与审计' : workStatus === 'working' ? '正在执行或等待恢复' : workStatus === 'accepted' ? '任务已验收' : '尚未执行'}
                        onClick={() =>
                          dispatch({
                            type: 'setParticipants',
                            ticketId: ticket.id,
                            agentIds: on ? ticket.participantIds.filter((x) => x !== a.id) : [...ticket.participantIds, a.id],
                          })
                        }
                      >
                        <Avatar agent={a} workStatus={workStatus} style={{ width: 18, height: 18, fontSize: 10 }} />
                        {a.name}
                      </button>
                    );
                  })}
              </div>
            </section>

            {/* 任务协同流水线看板 */}
            <section className="field">
              <span className="field__label">团队任务安排（{ticket.tasks.length}）</span>
              <div className="ticket-list">
                {ticket.tasks.map((task) => {
                  const Icon = STATUS_ICON[task.status];
                  const assignee = data.agents.find((a) => a.id === task.assigneeId);
                  const job = latestJob(task.id);
                  const deps = Array.isArray(task.dependencies) ? task.dependencies : [];
                  return (
                    <div key={task.id} className={`task ${flashId === task.id ? 'is-completing' : ''}`}>
                      <button
                        className="task__check"
                        disabled={locked(task.id)}
                        title={`状态：${TASK_STATUS_LABEL[task.status]}，点击切换`}
                        aria-label={`任务「${task.title}」当前状态 ${TASK_STATUS_LABEL[task.status]}，点击切换`}
                        onClick={() => {
                          if (task.status !== 'done') setFlashId(task.id);
                          dispatch({ type: 'cycleTaskStatus', ticketId: ticket.id, taskId: task.id });
                        }}
                      >
                        {task.status === 'done' ? <Check size={15} aria-hidden /> : <Icon size={14} aria-hidden />}
                      </button>

                      <div className="task__title">
                        <div className={task.status === 'done' ? 'is-done' : undefined}>
                          {task.title}
                          {deps.length > 0 && (
                            <span className="workbench-task-dep" title={`依赖任务: ${deps.join(', ')}`}>
                              依赖前置
                            </span>
                          )}
                        </div>
                        <div className="task__meta">
                          <span className="status-pill" data-status={task.status}>
                            {TASK_STATUS_LABEL[task.status]}
                          </span>
                          <span>负责：</span>
                          <select
                            className="status-pill"
                            style={{ background: 'transparent' }}
                            value={task.assigneeId ?? ''}
                            disabled={locked(task.id)}
                            aria-label={`为任务「${task.title}」设置负责人`}
                            onChange={(e) =>
                              dispatch({
                                type: 'patchTask',
                                ticketId: ticket.id,
                                taskId: task.id,
                                patch: { assigneeId: e.target.value === '' ? null : e.target.value },
                              })
                            }
                          >
                            <option value="">协调者统筹自动指派</option>
                            {data.agents.filter(a => !a.removed).map((a) => (
                              <option key={a.id} value={a.id}>
                                {a.name}
                              </option>
                            ))}
                          </select>
                          {assignee && <span className="nav__meta">（{job ? '后台自动执行' : '已指派'}）</span>}
                        </div>
                      </div>

                      <button
                        className="btn btn--icon btn--ghost btn--danger"
                        style={{ minHeight: 26 }}
                        aria-label={`删除任务「${task.title}」`}
                        title="删除任务"
                        disabled={locked(task.id)}
                        onClick={() => dispatch({ type: 'removeTask', ticketId: ticket.id, taskId: task.id })}
                      >
                        <Trash2 size={13} aria-hidden />
                      </button>
                    </div>
                  );
                })}
              </div>

              <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                <input
                  className="input"
                  value={newTask}
                  placeholder="添加一个子任务（可选）"
                  maxLength={80}
                  onChange={(e) => setNewTask(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && newTask.trim()) {
                      dispatch({ type: 'addTask', ticketId: ticket.id, title: newTask });
                      setNewTask('');
                    }
                  }}
                />
                <button
                  className="btn btn--icon"
                  aria-label="添加任务"
                  disabled={!newTask.trim()}
                  onClick={() => {
                    dispatch({ type: 'addTask', ticketId: ticket.id, title: newTask });
                    setNewTask('');
                  }}
                >
                  <Plus size={15} aria-hidden />
                </button>
              </div>
            </section>

            {/* 讨论区 */}
            <section className="field">
              <label className="field__label" htmlFor="ticket-discussion">
                团队讨论记录
              </label>
              <textarea
                id="ticket-discussion"
                className="textarea"
                value={ticket.discussion.text}
                placeholder="在这张工单里对齐范围与分工…"
                onChange={(e) => dispatch({ type: 'setTicketText', ticketId: ticket.id, field: 'discussion', text: e.target.value })}
              />
            </section>

            {/* 成果区 */}
            <section className="field">
              <label className="field__label" htmlFor="ticket-artifacts">
                项目交付成果
              </label>
              <textarea
                id="ticket-artifacts"
                className="textarea"
                value={ticket.artifacts.text}
                placeholder="还没有成果。做完之后各成员会将产物自动汇总于此。"
                onChange={(e) => dispatch({ type: 'setTicketText', ticketId: ticket.id, field: 'artifacts', text: e.target.value })}
              />
            </section>

            </details>

            <details className="workbench-project-details"><summary>更多项目操作</summary>
            {/* 保持挂载以持续接收状态；维护入口收在项目操作内。 */}
            <details className="workbench-advanced-details">
              <summary>维护工具（连接与调试）</summary>
              <div style={{ marginTop: 8 }}>
                <BridgeControls store={store} onSnapshot={setBridgeSnapshot} />
              </div>
            </details>

            {/* 删除工单 */}
            <div style={{ marginTop: 6 }}>
              <button
                className="btn btn--danger"
                disabled={ticket.tasks.some(t => locked(t.id) && latestJob(t.id)?.state !== 'done')}
                onClick={() =>
                  onRequestDelete({
                    title: `删除工单「${ticket.title || '未命名'}」？`,
                    body: '任务、讨论与成果都会一并删除。此操作不可撤销。',
                    confirmLabel: '删除工单',
                    danger: true,
                    onConfirm: () => dispatch({ type: 'deleteTicket', ticketId: ticket.id }),
                  })
                }
              >
                <Trash2 size={14} aria-hidden /> 删除这张工单
              </button>
            </div>
            </details>
          </>
        )}
      </div>
    </aside>
  );
}
