/**
 * 手机工作台：只读。数据来自桌面小屋的工单快照（GET /api/workbench）。
 * 桌面没开时显示上一次拿到的样子，并标明是什么时候的。
 */
import { LumaApiError } from './apiClient';

export type WbTaskStatus = 'todo' | 'doing' | 'review' | 'done';
export type WbProgressKind =
  | 'queued' | 'claimed' | 'progress' | 'blocked' | 'question' | 'permission'
  | 'reported' | 'accepted' | 'rejected' | 'cancelled' | 'offline' | 'note';

export interface WbProgress { at: number; kind: WbProgressKind; text: string; agentId?: string }

export interface WbTask {
  id: string;
  title: string;
  status: WbTaskStatus;
  assigneeId: string | null;
  acceptance?: string;
  /** 桌面执行记录里这项任务当前的状态（没有派发过就为空） */
  jobState?: string | null;
  progress: WbProgress[];
  report?: { text: string; at: number } | null;
  review?: { decision: 'accepted' | 'rejected'; reason?: string; at: number } | null;
}

export interface WbTicket {
  id: string;
  title: string;
  goal: string;
  updatedAt: number;
  participantIds: string[];
  tasks: WbTask[];
  discussion: string;
  artifacts: string;
}

export interface WbSnapshot { schema: 'workbench-snapshot/1'; generatedAt: number; tickets: WbTicket[] }

const CACHE_KEY = 'luma-workbench-cache-v1';

export function readCachedWorkbench(): WbSnapshot | null {
  try {
    const raw = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
    return raw && Array.isArray(raw.tickets) ? raw : null;
  } catch {
    return null;
  }
}

function cache(snapshot: WbSnapshot) {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(snapshot)); } catch { /* 存不下就算了 */ }
}

const str = (v: unknown, max = 4000) => (typeof v === 'string' ? v.slice(0, max) : '');
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const STATUSES: WbTaskStatus[] = ['todo', 'doing', 'review', 'done'];

/** 桌面传来的东西先过一遍，字段缺了也不至于把页面弄崩 */
function normalize(raw: any): WbSnapshot {
  const tickets: WbTicket[] = (Array.isArray(raw?.tickets) ? raw.tickets : []).map((t: any) => ({
    id: str(t?.id, 200),
    title: str(t?.title, 300) || '未命名工单',
    goal: str(t?.goal),
    updatedAt: num(t?.updatedAt),
    participantIds: Array.isArray(t?.participantIds) ? t.participantIds.filter((x: unknown) => typeof x === 'string') : [],
    discussion: str(t?.discussion, 8000),
    artifacts: str(t?.artifacts, 8000),
    tasks: (Array.isArray(t?.tasks) ? t.tasks : []).map((k: any) => ({
      id: str(k?.id, 200),
      title: str(k?.title, 300),
      status: STATUSES.includes(k?.status) ? k.status : 'todo',
      assigneeId: typeof k?.assigneeId === 'string' ? k.assigneeId : null,
      acceptance: str(k?.acceptance, 1000) || undefined,
      jobState: typeof k?.jobState === 'string' ? k.jobState : null,
      progress: (Array.isArray(k?.progress) ? k.progress : []).slice(-30).map((p: any) => ({
        at: num(p?.at), kind: typeof p?.kind === 'string' ? p.kind : 'note', text: str(p?.text, 600),
        agentId: typeof p?.agentId === 'string' ? p.agentId : undefined,
      })),
      report: k?.report && typeof k.report.text === 'string' ? { text: str(k.report.text, 6000), at: num(k.report.at) } : null,
      review: k?.review && (k.review.decision === 'accepted' || k.review.decision === 'rejected')
        ? { decision: k.review.decision, reason: str(k.review.reason, 1000) || undefined, at: num(k.review.at) } : null,
    })),
  })).filter((t: WbTicket) => t.id);
  return { schema: 'workbench-snapshot/1', generatedAt: num(raw?.generatedAt) || Date.now(), tickets };
}

export async function fetchWorkbench(signal?: AbortSignal): Promise<WbSnapshot> {
  const res = await fetch('/api/workbench', { headers: { Accept: 'application/json' }, signal });
  const text = await res.text();
  if (/^\s*<(!doctype|html)/i.test(text)) {
    throw new LumaApiError('登录过期了，重新登录一下小屋再看。', 'authentication_required', false, res.status);
  }
  let data: any;
  try { data = JSON.parse(text); } catch {
    throw new LumaApiError('工作台还没接上桌面小屋。', 'invalid_response', true, res.status);
  }
  if (!res.ok) {
    const e = data?.error || {};
    throw new LumaApiError(e.message || `请求失败 (${res.status})`, e.code || 'request_failed', e.retryable ?? res.status >= 500, res.status);
  }
  const snapshot = normalize(data);
  cache(snapshot);
  return snapshot;
}

/** 卡片上那一行进度：做完几项 / 一共几项 */
export function ticketProgress(t: WbTicket) {
  const done = t.tasks.filter((k) => k.status === 'done').length;
  return { done, total: t.tasks.length, active: t.tasks.some((k) => k.status === 'doing' || k.status === 'review') };
}
