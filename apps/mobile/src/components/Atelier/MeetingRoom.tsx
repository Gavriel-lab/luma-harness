import { useEffect, useRef, useState } from 'react';
import { fetchMembers, parseJsonResponse } from '../../utils/apiClient';

type Action = 'start' | 'pause' | 'resume' | 'end';
type Meeting = {
  id: string;
  topic: string;
  status: 'preparing' | 'running' | 'paused' | 'completed' | 'ended';
  round: number;
  maxRounds: number;
  participants: string[];
  members: Record<string, { status: string }>;
  entries: Array<{ agent: string; round: number; phase?: string; outcome: string; text?: string }>;
  result?: string;
  notice?: string;
};
const statusLabel: Record<string, string> = {
  preparing: '准备中', running: '讨论中', paused: '已暂停', completed: '已完成', ended: '已结束',
  ready: '就绪', speaking: '发言中', unavailable: '连接不可用', recovering: '连接恢复中', closed: '已关闭',
};

export function MeetingRoom() {
  const [meeting, setMeeting] = useState<Meeting | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [names, setNames] = useState<Record<string, string>>({});
  const [topic, setTopic] = useState('');
  const [note, setNote] = useState('');
  const [rounds, setRounds] = useState(3);
  const [busy, setBusy] = useState(false);
  const [statusError, setStatusError] = useState('');
  const [actionError, setActionError] = useState('');
  const activeAction = useRef(false);
  const revision = useRef(0);
  const retry = useRef<{ key: string; id: string } | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let timer: number;
    const refresh = async () => {
      const before = revision.current;
      try {
        if (!activeAction.current) {
          const response = await fetch('/api/meeting', { signal: controller.signal });
          const result = await parseJsonResponse<{ meeting: Meeting | null }>(response);
          if (!controller.signal.aborted && before === revision.current) {
            setMeeting(result.meeting);
            setLoaded(true);
            setStatusError('');
          }
        }
      } catch (error) {
        if (!controller.signal.aborted && before === revision.current) {
          setStatusError(error instanceof Error ? error.message : '无法读取会议状态');
        }
      } finally {
        if (!controller.signal.aborted) timer = window.setTimeout(refresh, 2500);
      }
    };
    void refresh();
    void fetchMembers().then(members => {
      if (!controller.signal.aborted) setNames(Object.fromEntries(members.map(member => [member.agentId, member.displayName])));
    }).catch(() => {});
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, []);

  async function command(action: Action) {
    if (activeAction.current) return;
    const payload = {
      meetingId: meeting?.id ?? null,
      ...(action === 'start' ? { text: topic.trim(), maxRounds: rounds } : {}),
      ...(action === 'resume' ? { text: note.trim() } : {}),
    };
    const key = JSON.stringify([action, payload]);
    if (retry.current?.key !== key) retry.current = { key, id: crypto.randomUUID() };
    const requestId = retry.current.id;
    activeAction.current = true;
    revision.current++;
    setBusy(true);
    setActionError('');
    try {
      const response = await fetch('/api/meeting/' + action, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...payload, ...(['start', 'resume'].includes(action) ? { requestId } : {}) }),
      });
      const result = await parseJsonResponse<{ meeting: Meeting | null }>(response);
      setMeeting(result.meeting);
      setStatusError('');
      retry.current = null;
      if (action === 'start') { setTopic(''); setNote(''); }
      if (action === 'resume') setNote('');
    } catch (error) {
      setActionError(error instanceof Error ? error.message : '无法执行会议操作');
    } finally {
      activeAction.current = false;
      setBusy(false);
    }
  }

  const closed = !meeting || meeting.status === 'completed' || meeting.status === 'ended';
  return <section style={{ maxWidth: 680, margin: '0 auto', padding: 16, overflowWrap: 'anywhere' }}>
    <h1>会议室</h1>
    <p>桌面主机主持讨论。会议结论可供你整理成工作方案。</p>
    {statusError && <p role="alert">{statusError}</p>}
    {actionError && <p role="alert">{actionError}</p>}
    {!loaded && !statusError && <p>正在读取会议状态…</p>}
    <fieldset disabled={!loaded || busy || !!statusError}>
      <legend>会议控制</legend>
      {closed ? <form onSubmit={event => { event.preventDefault(); void command('start'); }}>
        <label>主题<textarea required maxLength={8000} rows={4} value={topic}
          onChange={event => setTopic(event.target.value)} style={{ display: 'block', width: '100%' }} /></label>
        <label>轮数 <input type="number" min={1} max={10} required value={rounds}
          onChange={event => setRounds(Number(event.target.value))} /></label>{' '}
        <button type="submit" disabled={!topic.trim()}>开始会议</button>
      </form> : <>
        {meeting.status === 'paused' ? <>
          <label>补充意见<textarea maxLength={8000} rows={3} value={note}
            onChange={event => setNote(event.target.value)} style={{ display: 'block', width: '100%' }} /></label>
          <button onClick={() => void command('resume')}>继续会议</button>
        </> : <button onClick={() => void command('pause')}>暂停会议</button>}{' '}
        <button onClick={() => void command('end')}>结束会议</button>
      </>}
    </fieldset>
    {meeting && <>
      <h2>{meeting.topic}</h2>
      <p>{statusLabel[meeting.status]} · 第 {meeting.round} / {meeting.maxRounds} 轮</p>
      {meeting.notice && <p>{meeting.notice}</p>}
      <ul>{meeting.participants.map(id => <li key={id}>
        {names[id] || id} · {statusLabel[meeting.members[id]?.status] || '等待'}
      </li>)}</ul>
      {meeting.result && <><h3>会议结论</h3><p style={{ whiteSpace: 'pre-wrap' }}>{meeting.result}</p></>}
      {!!meeting.entries.length && <h3>最近发言</h3>}
      {meeting.entries.map((entry, index) => <article key={index}>
        <b>{names[entry.agent] || entry.agent} · 第 {entry.round} 轮{entry.phase === 'summary' ? '总结' : ''}</b>
        <p style={{ whiteSpace: 'pre-wrap' }}>{entry.text || (entry.outcome === 'skipped' ? '跳过' : '连接失败')}</p>
      </article>)}
    </>}
  </section>;
}
