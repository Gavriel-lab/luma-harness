/**
 * 手机工作台（只读）：午后花园里的一张旧木桌，工单像一张张卡片摊在上面。
 * 点开一张看目标、每项任务谁在做、做到哪、交了什么。不能改，派活和验收都在桌面。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, RefreshCw, ChevronDown, Loader2 } from 'lucide-react';
import { fetchMembers } from '../../utils/apiClient';
import {
  fetchWorkbench, readCachedWorkbench, ticketProgress,
  type WbSnapshot, type WbTicket, type WbTask, type WbProgressKind,
} from '../../utils/workbenchApi';
import './atelier.css';

const A = (n: string) => `${import.meta.env.BASE_URL}assets/atelier/${n}.webp`;
const CARDS = ['card-cream', 'card-rose', 'card-blue', 'card-sage', 'card-lilac'];
const PINS = ['pin-rose', 'pin-gold', 'clip-gold', 'clip-silver', 'washi'];
const TILTS = [-1.6, 1.2, -0.6, 1.8, -1.1, 0.7];

interface Member { id: string; name: string; accent: string; avatar?: string }
const MEMBER_CACHE = 'luma-workbench-members-v1';

const TASK_LABEL: Record<WbTask['status'], string> = { todo: '待办', doing: '进行中', review: '待验收', done: '完成' };
const PROGRESS_LABEL: Record<WbProgressKind, string> = {
  queued: '已派发', claimed: '领了活', progress: '进展', blocked: '卡住了', question: '有问题要问',
  permission: '等批准', reported: '交了，等协调者验收', accepted: '验收通过', rejected: '被退回',
  cancelled: '停下了', offline: '掉线了', note: '记一笔',
};

const hash = (s: string) => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return Math.abs(h); };
const clock = (ms: number) => {
  if (!ms) return '';
  const d = new Date(ms), now = new Date();
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return d.toDateString() === now.toDateString() ? hm : `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
};

/** 卡片右上角的印章：完成 / 待验收 / 进行中 / 待开始 */
function stampOf(t: WbTicket) {
  const p = ticketProgress(t);
  if (p.total > 0 && p.done === p.total) return { seal: 'seal-sage', word: '完成', state: 'done' as const };
  if (t.tasks.some((k) => k.status === 'review')) return { seal: 'seal-rose', word: '待验收', state: 'active' as const };
  if (p.active) return { seal: 'seal-rose', word: '进行中', state: 'active' as const };
  if (p.done > 0) return { seal: 'seal-lilac', word: '待续', state: 'todo' as const };
  return { seal: 'seal-lilac', word: '待开始', state: 'todo' as const };
}

const Avatar: React.FC<{ m?: Member; id: string; size?: number }> = ({ m, id, size = 22 }) => (
  <span className="wb-avatar" style={{ width: size, height: size, borderColor: m?.accent || '#c9b48a' }} title={m?.name || id}>
    {m?.avatar ? <img src={m.avatar} alt="" /> : <span style={{ fontSize: size * 0.45 }}>{(m?.name || id).slice(0, 1)}</span>}
  </span>
);

export const Workbench: React.FC<{ onBack: () => void }> = ({ onBack }) => {
  const [snapshot, setSnapshot] = useState<WbSnapshot | null>(() => readCachedWorkbench());
  const [fresh, setFresh] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [members, setMembers] = useState<Record<string, Member>>(() => {
    try { return JSON.parse(localStorage.getItem(MEMBER_CACHE) || '{}'); } catch { return {}; }
  });
  const [openId, setOpenId] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    abortRef.current?.abort();
    const ctl = new AbortController();
    abortRef.current = ctl;
    setLoading(true);
    try {
      const [snap, list] = await Promise.allSettled([fetchWorkbench(ctl.signal), fetchMembers(ctl.signal)]);
      if (ctl.signal.aborted) return;
      if (list.status === 'fulfilled' && list.value.length) {
        const map: Record<string, Member> = {};
        list.value.forEach((m) => { map[m.agentId] = { id: m.agentId, name: m.displayName, accent: m.accent || '#c9b48a', avatar: m.avatarDataUrl }; });
        setMembers(map);
        try { localStorage.setItem(MEMBER_CACHE, JSON.stringify(map)); } catch { /* ignore */ }
      }
      if (snap.status === 'fulfilled') { setSnapshot(snap.value); setFresh(true); setError(null); }
      else { setFresh(false); setError((snap.reason as Error)?.message || '桌面小屋暂时没回话'); }
    } finally {
      if (!ctl.signal.aborted) setLoading(false);
    }
  }, []);

  // 打开就取一次；页面在前台时每 30 秒再看一眼
  useEffect(() => {
    load();
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') load(); }, 30000);
    return () => { window.clearInterval(timer); abortRef.current?.abort(); };
  }, [load]);

  const tickets = useMemo(() => {
    const order = { active: 0, todo: 1, done: 2 };
    return [...(snapshot?.tickets || [])].sort((a, b) => order[stampOf(a).state] - order[stampOf(b).state] || b.updatedAt - a.updatedAt);
  }, [snapshot]);
  const open = tickets.find((t) => t.id === openId) || null;
  // 做完的收进桌角的归档盒，桌上只摊还在动的
  const [showArchive, setShowArchive] = useState(false);
  const onDesk = tickets.filter((t) => stampOf(t).state !== 'done');
  const archived = tickets.filter((t) => stampOf(t).state === 'done');

  const renderCard = (t: WbTicket, i: number) => {
    const s = stampOf(t);
    const p = ticketProgress(t);
    const h = hash(t.id);
    const workers = Array.from(new Set(t.tasks.filter((k) => k.status === 'doing' || k.status === 'review').map((k) => k.assigneeId).filter(Boolean) as string[]));
    const faces = (workers.length ? workers : t.participantIds).slice(0, 3);
    return (
      <button
        type="button"
        key={t.id}
        className={`wb-card${i % 2 ? ' wb-card-r' : ''}`}
        data-state={s.state}
        style={{ '--tilt': `${TILTS[i % TILTS.length]}deg`, '--delay': `${Math.min(i, 8) * 60}ms` } as React.CSSProperties}
        onClick={() => setOpenId(t.id)}
        aria-label={`${t.title}，${s.word}，做完 ${p.done} 项，共 ${p.total} 项`}
      >
        <img className="wb-card-paper" src={A(CARDS[h % CARDS.length])} alt="" aria-hidden="true" />
        <img className="wb-card-pin" data-kind={PINS[h % PINS.length]} src={A(PINS[h % PINS.length])} alt="" aria-hidden="true" />
        <span className="wb-card-body">
          <span className="wb-card-title">{t.title}</span>
          <span className="wb-card-goal">{t.goal}</span>
          <span className="wb-card-foot">
            <span className="wb-card-count">{p.done}/{p.total}</span>
            <span className="wb-faces">{faces.map((id) => <Avatar key={id} id={id} m={members[id]} size={18} />)}</span>
          </span>
        </span>
        <span className="wb-seal" aria-hidden="true">
          <img src={A(s.seal)} alt="" />
          <span>{s.word}</span>
        </span>
      </button>
    );
  };

  return (
    <div className="wb-root" style={{ height: 'var(--app-height, 100dvh)' }}>
      <div className="wb-table" style={{ backgroundImage: `url(${A('table')})` }} aria-hidden="true" />

      <header className="wb-head">
        <button type="button" className="wb-round" onClick={open ? () => setOpenId(null) : onBack} aria-label={open ? '回到木桌' : '回到首页'}>
          <ArrowLeft className="w-4 h-4" />
        </button>
        <div className="wb-heading">
          <h1 className="font-calligraphy">工作台</h1>
          <p>工作台 · 只看进度，派活和验收都在桌面</p>
        </div>
        <button type="button" className="wb-round" onClick={load} disabled={loading} aria-label="刷新">
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </header>

      {(!fresh && snapshot) && (
        <p className="wb-note" role="status">桌面小屋没回话，这是 {clock(snapshot.generatedAt)} 的样子</p>
      )}

      {open ? (
        <TicketDetail ticket={open} members={members} />
      ) : (
        <main className="wb-desk">
          {!snapshot ? (
            loading ? (
              <div className="wb-empty"><Loader2 className="w-5 h-5 animate-spin" /></div>
            ) : (
              <div className="wb-empty wb-paper">
                <p className="font-calligraphy wb-empty-title">暂无内容</p>
                <p>{error || '工作台还没接上桌面小屋。'}</p>
                <p className="wb-hint">桌面小屋开着、接好以后，这里就能看到工单。</p>
              </div>
            )
          ) : tickets.length === 0 ? (
            <div className="wb-empty wb-paper">
              <p className="font-calligraphy wb-empty-title">暂无工单</p>
              <p>桌上空空的，还没有工单。</p>
            </div>
          ) : (
            <>
              {onDesk.length === 0 && (
                <div className="wb-empty wb-paper wb-span">
                  <p className="font-calligraphy wb-empty-title">暂无工单</p>
                  <p>手头的活都做完了。</p>
                </div>
              )}
              {onDesk.map(renderCard)}
              {archived.length > 0 && (
                <button
                  type="button"
                  className="wb-archive wb-span"
                  onClick={() => setShowArchive((v) => !v)}
                  aria-expanded={showArchive}
                >
                  <span className="font-calligraphy">归档</span>
                  <span>已完成 {archived.length} 张 · {showArchive ? '收起' : '翻开看看'}</span>
                  <ChevronDown className={`w-4 h-4 wb-chev ${showArchive ? 'rotate-180' : ''}`} aria-hidden="true" />
                </button>
              )}
              {showArchive && archived.map((t, i) => renderCard(t, i))}
            </>
          )}
        </main>
      )}
    </div>
  );
};

/** 一张工单摊开：目标、任务、讨论、成果 */
const TicketDetail: React.FC<{ ticket: WbTicket; members: Record<string, Member> }> = ({ ticket, members }) => {
  const [expanded, setExpanded] = useState<string | null>(() => ticket.tasks.find((k) => k.status === 'doing' || k.status === 'review')?.id || null);
  const p = ticketProgress(ticket);
  const name = (id: string | null) => (id ? members[id]?.name || id : '还没人领');

  return (
    <main className="wb-detail">
      <article className="wb-sheet">
        <img className="wb-sheet-tape" src={A('washi')} alt="" aria-hidden="true" />
        <h2 className="wb-sheet-title">{ticket.title}</h2>
        <p className="wb-sheet-meta">做完 {p.done} / {p.total} 项{ticket.updatedAt ? ` · ${clock(ticket.updatedAt)} 更新` : ''}</p>

        {ticket.goal && (
          <section className="wb-sec">
            <h3><span className="font-calligraphy">But</span>目标</h3>
            <p className="wb-text">{ticket.goal}</p>
          </section>
        )}

        {ticket.participantIds.length > 0 && (
          <div className="wb-people">
            {ticket.participantIds.map((id) => (
              <span key={id} className="wb-person"><Avatar id={id} m={members[id]} size={26} />{name(id)}</span>
            ))}
          </div>
        )}

        <section className="wb-sec">
          <h3><span className="font-calligraphy">Tâches</span>任务</h3>
          {ticket.tasks.length === 0 ? <p className="wb-hint">还没拆任务。</p> : (
            <ol className="wb-tasks">
              {ticket.tasks.map((k) => {
                const isOpen = expanded === k.id;
                const hasMore = k.progress.length > 0 || !!k.report || !!k.review || !!k.acceptance;
                return (
                  <li key={k.id} className="wb-task" data-status={k.status}>
                    <button
                      type="button"
                      className="wb-task-row"
                      onClick={() => hasMore && setExpanded(isOpen ? null : k.id)}
                      aria-expanded={hasMore ? isOpen : undefined}
                      disabled={!hasMore}
                    >
                      <span className="wb-dot" aria-hidden="true" />
                      <span className="wb-task-main">
                        <span className="wb-task-title">{k.title}</span>
                        <span className="wb-task-sub">
                          {k.assigneeId && <Avatar id={k.assigneeId} m={members[k.assigneeId]} size={16} />}
                          {name(k.assigneeId)} · <em>{TASK_LABEL[k.status]}</em>
                        </span>
                      </span>
                      {hasMore && <ChevronDown className={`w-4 h-4 wb-chev ${isOpen ? 'rotate-180' : ''}`} aria-hidden="true" />}
                    </button>
                    {isOpen && (
                      <div className="wb-task-more">
                        {k.acceptance && <p className="wb-hint">验收标准：{k.acceptance}</p>}
                        {k.progress.length > 0 && (
                          <ul className="wb-notes">
                            {k.progress.map((n, i) => (
                              <li key={i} data-kind={n.kind}>
                                <span className="wb-note-time">{clock(n.at)}</span>
                                <span><b>{PROGRESS_LABEL[n.kind] || n.kind}</b>{n.text ? `：${n.text}` : ''}</span>
                              </li>
                            ))}
                          </ul>
                        )}
                        {k.report && (
                          <div className="wb-report">
                            <span className="wb-label">交付 · {clock(k.report.at)}</span>
                            <p className="wb-text">{k.report.text}</p>
                          </div>
                        )}
                        {k.review && (
                          <p className="wb-review" data-decision={k.review.decision}>
                            {k.review.decision === 'accepted' ? '协调者验收通过' : '协调者退回了'}{k.review.reason ? `：${k.review.reason}` : ''}
                          </p>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ol>
          )}
        </section>

        {ticket.discussion.trim() && (
          <details className="wb-sec wb-fold">
            <summary><span className="font-calligraphy">Discussion</span>讨论</summary>
            <p className="wb-text">{ticket.discussion}</p>
          </details>
        )}
        {ticket.artifacts.trim() && (
          <details className="wb-sec wb-fold" open>
            <summary><span className="font-calligraphy">交付</span>成果</summary>
            <p className="wb-text">{ticket.artifacts}</p>
          </details>
        )}
      </article>
    </main>
  );
};
