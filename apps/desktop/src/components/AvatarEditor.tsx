import { useEffect, useRef, useState } from 'react';
import type { Agent } from '../types';
import type { Store } from '../ui/useAppStore';
import { importLocalAvatar } from '../utils/avatar';
import { Avatar } from './Avatar';

export function AvatarEditor({ agent, store }: { agent: Agent; store: Store }) {
  const input = useRef<HTMLInputElement>(null);
  const generation = useRef(0);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  useEffect(() => () => { generation.current++; }, []);
  const choose = async (file?: File) => {
    if (!file) return;
    const run = ++generation.current;
    setBusy(true);setNotice('');
    try {
      const image = await importLocalAvatar(file);
      if (run !== generation.current) return;
      store.dispatch({ type: 'setAgentAvatar', agentId: agent.id, avatarDataUrl: image });
      setNotice('头像已更新。');
    } catch (error) {
      if (run === generation.current) setNotice(error instanceof Error ? error.message : '图片没有读成功，请再试一次。');
    } finally { if (run === generation.current) setBusy(false); }
  };
  return <section className="member-avatar-editor" aria-label={`${agent.name}的头像`}>
    <Avatar agent={agent} style={{ width: 64, height: 64, fontSize: 24 }} />
    <div style={{ minWidth: 0 }}>
      <div className="label">{agent.name}的头像</div>
      <p className="help" style={{ margin: '4px 0 8px' }}>选一张本地图片，自动保存并同步到侧栏和聊天。图片会居中裁切；动图取静态画面。</p>
      <input ref={input} type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/avif" hidden data-testid="avatar-file-input"
        onChange={event => { const file = event.target.files?.[0];event.target.value = '';void choose(file); }} />
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
        <button className="btn btn--primary" type="button" disabled={busy} onClick={() => input.current?.click()} data-testid="avatar-choose">{busy ? '正在读取图片…' : '选择本地图片'}</button>
        <button className="btn btn--ghost" type="button" disabled={!agent.avatarDataUrl && !busy} data-testid="avatar-reset"
          onClick={() => { generation.current++;setBusy(false);store.dispatch({ type: 'setAgentAvatar', agentId: agent.id, avatarDataUrl: '' });setNotice('已恢复默认头像。'); }}>恢复默认</button>
      </div>
      <div className="help" role="status" style={{ marginTop: notice ? 6 : 0 }}>{notice}</div>
    </div>
  </section>;
}
