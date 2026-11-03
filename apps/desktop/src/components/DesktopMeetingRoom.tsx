import { useEffect, useRef, useState } from 'react';
import type { DesktopBridge } from '../store/backend';

type Action = Parameters<NonNullable<DesktopBridge['meeting']>>[0];
type Meeting = {
  id: string;
  topic: string;
  status: string;
  round: number;
  maxRounds: number;
  participants: string[];
  members: Record<string, { status: string }>;
  entries: { agent: string; round: number; phase?: string; outcome: string; text?: string }[];
  result?: string;
  notice?: string;
};

const labels: Record<string, string> = {
  preparing: '准备中', running: '讨论中', paused: '已暂停', completed: '已完成', ended: '已结束',
  ready: '就绪', speaking: '发言中', recovering: '连接恢复中', unavailable: '连接不可用', closed: '已关闭',
};

async function request(action: Action, payload: Record<string, unknown> = {}) {
  const bridge = window.xiaowuDesktop?.meeting;
  if (!bridge) throw Error('会议服务尚未就绪');
  const response = await bridge(action, payload);
  const body = response.body as { meeting: Meeting | null; error?: { message: string } };
  if (response.status !== 200) throw Error(body.error?.message || '会议操作失败');
  return body.meeting;
}

export function DesktopMeetingRoom({ agents, onBack }: {
  agents: readonly { id: string; name: string }[];
  onBack: () => void;
}) {
  const [meeting, setMeeting] = useState<Meeting | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [topic, setTopic] = useState('');
  const [note, setNote] = useState('');
  const [rounds, setRounds] = useState(3);
  const active = useRef(false);
  const revision = useRef(0);
  const retry = useRef<{ key: string; id: string }>();
  const name = (id: string) => agents.find(agent => agent.id === id)?.name || id;

  useEffect(() => {
    let mounted = true;
    let timer: number;
    const refresh = async () => {
      const version = revision.current;
      try {
        if (active.current) return;
        const result = await request('status');
        if (mounted && revision.current === version) {
          setMeeting(result);
          setReady(true);
        }
      } catch (failure) {
        if (mounted && revision.current === version) {
          setReady(false);
          setError(failure instanceof Error ? failure.message : '无法读取会议状态');
        }
      } finally {
        if (mounted) timer = window.setTimeout(refresh, 2000);
      }
    };
    void refresh();
    return () => { mounted = false; window.clearTimeout(timer); };
  }, []);

  async function command(action: Exclude<Action, 'status'>) {
    if (active.current) return;
    const payload = {
      meetingId: meeting?.id ?? null,
      ...(action === 'start' ? { text: topic.trim(), maxRounds: rounds } : {}),
      ...(action === 'resume' ? { text: note.trim() } : {}),
    };
    const key = JSON.stringify([action, payload]);
    if (retry.current?.key !== key) retry.current = { key, id: crypto.randomUUID() };
    active.current = true;
    revision.current++;
    setBusy(true);
    setError('');
    try {
      setMeeting(await request(action, {
        ...payload,
        ...(action === 'start' || action === 'resume' ? { requestId: retry.current.id } : {}),
      }));
      retry.current = undefined;
      if (action === 'start') setTopic('');
      if (action === 'start' || action === 'resume') setNote('');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '会议操作失败');
    } finally {
      active.current = false;
      setBusy(false);
    }
  }

  const open = meeting && ['preparing', 'running', 'paused'].includes(meeting.status);
  return <section className="panel" aria-label="桌面会议室" style={{ minWidth: 0, minHeight: 0, overflow: 'auto' }}>
    <header className="panel__head">
      <h1 className="panel__title">会议室</h1>
      <div className="topbar__spacer" />
      <button className="btn" onClick={onBack}>返回聊天</button>
    </header>
    <div style={{ padding: 16, overflowWrap: 'anywhere' }}>
      <p>会议由桌面主机主持，电脑与手机共享进度。结论可用于起草工作方案。</p>
      {error && <p role="alert">{error}</p>}
      <fieldset disabled={!ready || busy}>
        <legend>会议控制</legend>
        {!open ? <form onSubmit={event => { event.preventDefault(); void command('start'); }}>
          <label>主题<textarea required maxLength={8000} rows={4} value={topic}
            onChange={event => setTopic(event.target.value)} style={{ display: 'block', width: '100%' }} /></label>
          <label>轮数 <input type="number" min={1} max={10} required value={rounds}
            onChange={event => setRounds(Number(event.target.value))} /></label>{' '}
          <button className="btn" type="submit" disabled={!topic.trim()}>开始会议</button>
        </form> : <>
          {meeting.status === 'paused' ? <>
            <label>补充意见<textarea maxLength={8000} rows={3} value={note}
              onChange={event => setNote(event.target.value)} style={{ display: 'block', width: '100%' }} /></label>
            <button className="btn" onClick={() => void command('resume')}>继续会议</button>
          </> : <button className="btn" onClick={() => void command('pause')}>暂停会议</button>}{' '}
          <button className="btn" onClick={() => void command('end')}>结束会议</button>
        </>}
      </fieldset>
      {meeting && <>
        <h2>{meeting.topic}</h2>
        <p>{labels[meeting.status]} · 第 {meeting.round} / {meeting.maxRounds} 轮</p>
        {meeting.notice && <p>{meeting.notice}</p>}
        <ul>{meeting.participants.map(id => <li key={id}>{name(id)} · {labels[meeting.members[id]?.status ?? ''] || '等待'}</li>)}</ul>
        {meeting.result && <><h3>会议结论</h3><p style={{ whiteSpace: 'pre-wrap' }}>{meeting.result}</p></>}
        {!!meeting.entries.length && <h3>最近发言</h3>}
        {meeting.entries.map((entry, index) => <article key={index}>
          <b>{name(entry.agent)} · 第 {entry.round} 轮{entry.phase === 'summary' ? '总结' : ''}</b>
          <p style={{ whiteSpace: 'pre-wrap' }}>{entry.text || (entry.outcome === 'skipped' ? '跳过' : '连接失败')}</p>
        </article>)}
      </>}
    </div>
  </section>;
}
