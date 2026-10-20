import React, { useEffect, useId, useRef, useState } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { X, Wind } from 'lucide-react';
import type { GardenMemoryDetailDto, GardenMemorySummaryDto, GardenRelatedMemoryDto } from '../../types';
import type { PetalBox } from './petalGeometry';

interface Props {
  summary: GardenMemorySummaryDto;
  originBox: PetalBox | null;
  detail: GardenMemoryDetailDto | null;
  related: GardenRelatedMemoryDto[];
  isLoadingDetail: boolean;
  isLoadingRelated: boolean;
  error: string | null;
  onClose(): void;
  onSelectRelated(key: string): void;
}

function dateLabel(iso?: string) {
  if (!iso) return '';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
}

export const PetalReaderModal: React.FC<Props> = ({ summary, originBox, detail, related, isLoadingDetail, isLoadingRelated, error, onClose, onSelectRelated }) => {
  const dialog = useRef<HTMLElement>(null), copy = useRef<HTMLDivElement>(null);
  const [showSources, setShowSources] = useState(false), titleId = useId();
  const reduced = useReducedMotion();
  const record = detail?.key === summary.key ? detail : null;
  const content = record?.content || summary.preview || '';
  const sources = record?.sources || [];
  const offset = originBox ? { x: originBox.x + originBox.width / 2 - innerWidth / 2, y: originBox.y + originBox.height / 2 - innerHeight / 2 } : { x: 0, y: 0 };
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.focus({ preventScroll: true });
    return () => { if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, []);
  useEffect(() => { if (copy.current) copy.current.scrollTop = 0; }, [summary.key]);

  const handleKey = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') { event.preventDefault(); onClose(); }
    if (event.key !== 'Tab') return;
    const nodes = Array.from(dialog.current?.querySelectorAll<HTMLButtonElement>('button:not([disabled])') || []);
    const first = nodes[0], last = nodes.at(-1), active = document.activeElement;
    if (event.shiftKey && (active === first || active === dialog.current)) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && (active === last || active === dialog.current)) { event.preventDefault(); first?.focus(); }
  };

  return <motion.div className="rose-reader" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: reduced ? 0 : .5 }}>
    <button className="rose-reader-backdrop" onClick={onClose} aria-label="让花瓣飘回花园" tabIndex={-1} />
    <motion.section className="rose-memory-petal" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} ref={dialog} onKeyDown={handleKey}
      initial={reduced ? false : { ...offset, scale: .08, rotate: -18 }} animate={{ x: 0, y: 0, scale: 1, rotate: 0 }}
      exit={reduced ? { opacity: 0 } : { ...offset, scale: .06, rotate: 32, opacity: 0 }}
      transition={{ duration: reduced ? 0 : .65, ease: [.18, .8, .23, 1] }} onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
      <button className="rose-reader-close" onClick={onClose} aria-label="收起这片记忆"><X size={15} /></button>
      <div className="rose-memory-copy" ref={copy}>
        <p className="rose-memory-meta">{record?.scopeName || summary.scopeName} · {dateLabel(record?.date || summary.date)}</p>
        <h2 id={titleId}>{record?.title || summary.title || '一片记忆'}</h2>
        <div className="rose-memory-body">{content.split(/\n\s*\n/).map((paragraph, index) => <p key={index}>{paragraph.trim()}</p>)}</div>
        {isLoadingDetail && <p className="rose-reader-note" role="status">正在翻阅完整记忆…</p>}
        {error && <p className="rose-reader-note" role="status">{error}</p>}
        <p className="rose-reader-note">{isLoadingRelated ? '正在寻找花间的呼应…' : related.length ? `${related.length} 段记忆，正在花间呼应` : '这片记忆，安静地留在这里。'}</p>
        {!!related.length && <div className="rose-related-links">{related.map(item => <button key={item.key} onClick={() => onSelectRelated(item.key)}>{item.title}</button>)}</div>}
        {!!sources.length && <>
          <button className="rose-sources-toggle" onClick={() => setShowSources(value => !value)} aria-expanded={showSources}>原话来源 · {sources.length} 条</button>
          {showSources && <div className="rose-sources">{sources.map((source, i) => <blockquote key={source.messageId || i}><small>{source.speaker} {dateLabel(source.createdAt)}</small><p>{source.text}</p></blockquote>)}</div>}
        </>}
        <button className="rose-release" onClick={onClose}>让它随风飘回去 <Wind size={13} /></button>
      </div>
    </motion.section>
  </motion.div>;
};
