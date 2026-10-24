import { describe, expect, it } from 'vitest';
import { workbenchSummary, workbenchMembers } from './Workbench';
import type { Ticket, Agent } from '../types';
import type { BridgeSnapshot } from './BridgeControls';

const task = (id: string, status: 'todo' | 'doing' | 'review' | 'done' = 'todo') => ({ id, title: id, assigneeId: 'worker', status, deliverables: `${id}.md`, acceptance: '有真实证据' });
function fixture() {
  const tasks = [task('design', 'done'), task('build', 'doing')];
  const ticket: Ticket = { id: 'project', title: '交付', goal: '完整结果', tasks, participantIds: ['worker', 'agent_coordinator'],
    discussion: { text: '', updatedAt: 1 }, artifacts: { text: '', updatedAt: 1 }, updatedAt: 1, stage: 'in_progress',
    plan: { version: 1, title: '交付', goal: '完整结果', tasks: tasks.map(t => ({ ...t })), status: 'approved' } };
  const job = (id: string, state: string): BridgeSnapshot['jobs'][number] => ({ jobId: `job-${id}-${state}`, ticketId: ticket.id, taskId: id, agentId: 'worker', kind: 'work', state, workspace: 'synthetic', events: [] });
  const snapshot: BridgeSnapshot = { registrations: [{ agentId: 'worker', executorId: 'pi', connected: true, workspace: 'synthetic', manifestPath: null, chatEnabled: false }], jobs: [job('design', 'done'), job('build', 'doing')], feed: [] };
  return { ticket, snapshot, job };
}

describe('工作台按真实交付与执行状态展示', () => {
  it('成员空闲或等待时仍保留原头像与状态灯，只有真实活动计入工作人数', () => {
    const { ticket, snapshot } = fixture();
    const agents: Agent[] = ['agent_coordinator', 'worker', 'other_member'].map(id => ({ id, name: id, initial: id[0]!, kind: 'ai', accent: '#abc', statusNote: '', connected: true }));
    snapshot.jobs[1]!.state = 'queued';
    const members = workbenchMembers(ticket, agents, snapshot);
    expect(members).toHaveLength(3);
    expect(members.find(m => m.agent.id === 'other_member')).toMatchObject({ label: '未参与', state: 'idle', active: false });
    expect(members.find(m => m.agent.id === 'worker')).toMatchObject({ label: '等待开始', state: 'idle', active: false });
    expect(members[0]!.agent).toBe(agents[0]);
    expect(members.find(m => m.agent.id === 'agent_coordinator')).toMatchObject({ label: '统筹', state: 'coordinator', active: false });
    ticket.tasks.push({ ...task('coordinator-done', 'done'), assigneeId: 'agent_coordinator' });
    expect(workbenchMembers(ticket, agents, snapshot).find(m => m.agent.id === 'agent_coordinator')).toMatchObject({ label: '统筹', state: 'coordinator', active: false });
  });
  it('正在执行与已交付后成员持续可见，状态文字和灯随事实更新', () => {
    const { ticket, snapshot } = fixture();
    const agents: Agent[] = [{ id: 'worker', name: 'Worker', initial: 'W', kind: 'ai', accent: '#abc', statusNote: '', connected: true }];
    expect(workbenchMembers(ticket, agents, snapshot)[0]).toMatchObject({ label: '执行中', state: 'working', active: true });
    ticket.tasks[1]!.status = 'done';
    snapshot.jobs[1]!.state = 'done';
    ticket.stage = 'pending_user_acceptance';
    expect(workbenchMembers(ticket, agents, snapshot)[0]).toMatchObject({ label: '已完成', state: 'accepted', active: false });
    expect(workbenchMembers(ticket, agents, snapshot)[0]!.agent).toBe(agents[0]);
  });
  it('检查点、重试、额外执行步骤不扩大已约定成果的分母', () => {
    const { ticket, snapshot, job } = fixture();
    ticket.tasks.push(task('internal-check', 'done'));
    snapshot.jobs.push(job('internal-check', 'done'));
    snapshot.feed = Array.from({ length: 15 }, (_, i) => ({ id: String(i), type: 'progress', ticketId: ticket.id, taskId: 'build', agentId: 'worker', createdAt: i }));
    expect(workbenchSummary(ticket, snapshot)).toMatchObject({ completed: 1, total: 2, percent: 50, resultBased: true });
  });
  it('提交待审和旧轮次完成不能充当当前审核通过', () => {
    const { ticket, snapshot, job } = fixture();
    snapshot.jobs.push(job('design', 'rejected'));
    ticket.tasks[1]!.status = 'review';
    snapshot.jobs[1]!.state = 'review';
    expect(workbenchSummary(ticket, snapshot).completed).toBe(0);
  });
  it('排队、离线、未开始的参与成员不显示正在工作', () => {
    const { ticket, snapshot } = fixture();
    expect(workbenchSummary(ticket, snapshot).active.map(x => x.agentId)).toEqual(['worker']);
    for (const state of ['queued', 'offline', 'review', 'blocked']) {
      snapshot.jobs[1]!.state = state;
      expect(workbenchSummary(ticket, snapshot).active).toEqual([]);
    }
    snapshot.jobs[1]!.state = 'doing';
    snapshot.registrations[0]!.connected = false;
    expect(workbenchSummary(ticket, snapshot).active).toEqual([]);
  });
  it('协调者审核期间显示实际审核项，全部交付后等待用户验收', () => {
    const { ticket, snapshot, job } = fixture();
    snapshot.jobs[1]!.state = 'review';
    snapshot.jobs.push({ ...job('build', 'doing'), kind: 'coordination', agentId: 'agent_coordinator' });
    expect(workbenchSummary(ticket, snapshot).active).toEqual([{ agentId: 'agent_coordinator', title: 'build', reviewing: true }]);
    ticket.tasks[1]!.status = 'done';
    snapshot.jobs[1]!.state = 'done';
    ticket.stage = 'pending_user_acceptance';
    expect(workbenchSummary(ticket, snapshot)).toMatchObject({ percent: 100, current: '成果已备齐，等你看看是否满意。', active: [] });
    expect(ticket.userAcceptedAt).toBeUndefined();
  });
  it('旧项目明确使用任务口径，计算不修改任何持久化数据', () => {
    const { ticket, snapshot } = fixture();
    delete ticket.plan;
    const before = JSON.stringify({ ticket, snapshot });
    expect(workbenchSummary(ticket, snapshot).resultBased).toBe(false);
    expect(JSON.stringify({ ticket, snapshot })).toBe(before);
  });
});
