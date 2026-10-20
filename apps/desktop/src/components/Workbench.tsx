import { useEffect, useRef, useState } from 'react';
import { Check, ClipboardList, Plus, Trash2, X, Circle, CircleDot, Eye, CircleCheckBig } from 'lucide-react';
import type { Store } from '../ui/useAppStore';
import type { ConfirmRequest } from './Overlays';
import { TASK_STATUS_LABEL, type TaskStatus } from '../types';
import { Avatar } from './Avatar';
import { BridgeControls, type BridgeSnapshot } from './BridgeControls';

const STATUS_ICON: Record<TaskStatus, typeof Circle> = {
  todo: Circle,
  doing: CircleDot,
  review: Eye,
  done: CircleCheckBig,
};

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
  const [bridgeSnapshot,setBridgeSnapshot]=useState<BridgeSnapshot|null>(null);
  const latestJob=(taskId:string)=>bridgeSnapshot?.jobs.filter(j=>j.kind==='work'&&j.ticketId===ticket?.id&&j.taskId===taskId).at(-1);
  const locked=(taskId:string)=>{const job=latestJob(taskId);return !!job&&!['failed','cancelled'].includes(job.state);};
  const [flashId, setFlashId] = useState<string | null>(null);
  const firstRender = useRef(true);

  useEffect(() => {
    // 切换工单时收起一次性暖光，避免在别的工单上闪
    setFlashId(null);
    firstRender.current = true;
  }, [data.activeTicketId]);

  const open = data.workbenchOpen;
  const asideRef = useRef<HTMLElement>(null);

  // 收起时移出键盘焦点顺序；再次打开保留内部状态
  useEffect(() => {
    asideRef.current?.toggleAttribute('inert', !open);
  }, [open]);

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
        <p className="panel__title">工作桌</p>
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
        <BridgeControls store={store} onSnapshot={setBridgeSnapshot}/>
        <section className="field">
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span className="field__label">工单（{data.tickets.length}）</span>
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
          <div className="ticket-list">
            {data.tickets.map((t) => (
              <button
                key={t.id}
                className="ticket-item"
                aria-current={t.id === data.activeTicketId}
                onClick={() => dispatch({ type: 'selectTicket', ticketId: t.id })}
              >
                <span className="ticket-item__name">{t.title || '（未命名工单）'}</span>
                <span className="nav__meta">
                  {t.tasks.filter((x) => x.status === 'done').length}/{t.tasks.length}
                </span>
              </button>
            ))}
          </div>
        </section>

        {!ticket ? (
          <div className="demo-banner">还没有工单。点上面的 + 建一张。</div>
        ) : (
          <>
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
                目标
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

            <section className="field">
              <span className="field__label">参与成员 · 蓝：统筹 · 黄：执行中 · 绿：已验收</span>
              <div className="chips">
                {data.agents
                  .filter((a) => a.kind === 'ai' && !a.removed)
                  .map((a) => {
                    const on = ticket.participantIds.includes(a.id);
                    const assigned=ticket.tasks.filter(t=>t.assigneeId===a.id).map(t=>latestJob(t.id)).filter(Boolean);
                    const workStatus=on&&a.id==='agent_coordinator'?'coordinator':assigned.some(j=>j&&!['done','failed','cancelled','review'].includes(j.state))?'working':assigned.length>0&&assigned.every(j=>j?.state==='done')?'accepted':undefined;
                    return (
                      <button
                        key={a.id}
                        className="chip"
                        aria-pressed={on}
                        title={workStatus==='coordinator'?'统筹与审计':workStatus==='working'?'正在执行或等待恢复':workStatus==='accepted'?'任务已验收':'尚未执行'}
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

            <section className="field">
              <span className="field__label">任务（{ticket.tasks.length}）</span>
              <div className="ticket-list">
                {ticket.tasks.map((task) => {
                  const Icon = STATUS_ICON[task.status];
                  const assignee = data.agents.find((a) => a.id === task.assigneeId);
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
                        <div className={task.status === 'done' ? 'is-done' : undefined}>{task.title}</div>
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
                            <option value="">未指派</option>
                            {data.agents.filter(a => !a.removed).map((a) => (
                              <option key={a.id} value={a.id}>
                                {a.name}
                              </option>
                            ))}
                          </select>
                          {assignee && <span className="nav__meta">（{latestJob(task.id)?'状态由客户端接线回传':'仅分工，未执行'}）</span>}
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
                  placeholder="添加一个任务"
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

            <section className="field">
              <label className="field__label" htmlFor="ticket-discussion">
                讨论
              </label>
              <textarea
                id="ticket-discussion"
                className="textarea"
                value={ticket.discussion.text}
                placeholder="在这张工单里对齐范围与分工…"
                onChange={(e) => dispatch({ type: 'setTicketText', ticketId: ticket.id, field: 'discussion', text: e.target.value })}
              />
            </section>

            <section className="field">
              <label className="field__label" htmlFor="ticket-artifacts">
                成果
              </label>
                <textarea
                  id="ticket-artifacts"
                  className="textarea"
                  value={ticket.artifacts.text}
                  placeholder="还没有成果。做完之后把结果贴上来。"
                  onChange={(e) => dispatch({ type: 'setTicketText', ticketId: ticket.id, field: 'artifacts', text: e.target.value })}
                />
            </section>

            <div>
              <button
                className="btn btn--danger"
                disabled={ticket.tasks.some(t=>locked(t.id)&&latestJob(t.id)?.state!=='done')}
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
          </>
        )}
      </div>
    </aside>
  );
}
