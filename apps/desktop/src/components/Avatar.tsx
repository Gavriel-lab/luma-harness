import { useEffect, useState, type CSSProperties } from 'react';
import type { Agent } from '../types';
import { isAvatarDataUrl } from '../utils/avatar';

export function Avatar({ agent, className = '', style, workStatus }: { agent?: Agent; className?: string; style?: CSSProperties; workStatus?:'coordinator'|'working'|'accepted' }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [agent?.avatarDataUrl]);
  const image = !failed && isAvatarDataUrl(agent?.avatarDataUrl) ? agent.avatarDataUrl : '';
  return <span className={`avatar ${className}`} style={{ background: agent?.accent, ...style }} aria-hidden="true">
    {image ? <img className="avatar__image" src={image} alt="" onError={() => setFailed(true)} /> : (agent?.initial ?? '?')}
    {workStatus&&<i className="avatar__work-dot" data-work-status={workStatus}/>}
  </span>;
}
