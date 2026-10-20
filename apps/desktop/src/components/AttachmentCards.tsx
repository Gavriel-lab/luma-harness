import { useEffect, useState } from 'react';
import { FileText, X, Download } from 'lucide-react';
import type { MessageAttachment } from '../types';
import { useModalFocus } from '../ui/useModalFocus';
type Preview = { ok: boolean; dataUrl?: string; text?: string; reason?: string };

export function AttachmentCards({ attachments, onRemove }: { attachments: MessageAttachment[]; onRemove?: (id: string) => void }) {
  return <div className="attachment-cards">{attachments.map(a => <AttachmentCard key={a.id} attachment={a} onRemove={onRemove} />)}</div>;
}
function AttachmentCard({ attachment: a, onRemove }: { attachment: MessageAttachment; onRemove?: (id: string) => void }) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState('');
  const [fullImage, setFullImage] = useState<string>();
  useModalFocus('.attachment-preview', open);
  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); setOpen(false); } };
    document.addEventListener('keydown', closeOnEscape, true);
    return () => document.removeEventListener('keydown', closeOnEscape, true);
  }, [open]);
  useEffect(() => {
    let live = true;
    if (open && a.kind === 'image') window.xiaowuDesktop?.attachments?.preview(a.id, true).then(r => { if (live && r.ok) setFullImage(r.dataUrl); }).catch(() => { if (live) setError('照片读取失败'); });
    return () => { live = false; };
  }, [open, a.id, a.kind]);
  useEffect(() => {
    let live = true;
    window.xiaowuDesktop?.attachments?.preview(a.id).then(r => { if (live) setPreview(r); }).catch(() => { if (live) setPreview({ ok: false, reason: '附件读取失败' }); });
    return () => { live = false; };
  }, [a.id]);
  const exportFile = async () => {
    try { const r = await window.xiaowuDesktop?.attachments?.exportFile(a.id); if (!r?.ok) setError(r?.reason || '保存副本失败'); } catch { setError('保存副本失败'); }
  };
  return <>
    <div className="attachment-card" data-attachment-id={a.id}>
      <button className="attachment-card__preview" onClick={() => setOpen(true)} title={`预览 ${a.name}`}>
        {preview?.dataUrl ? <img src={preview.dataUrl} alt={a.name} /> : <FileText size={24} aria-hidden />}
        <span><strong>{a.name}</strong><small>{Math.max(1, Math.round(a.size / 1024))} KB{a.truncated ? ' · 模型读取前 12000 字' : ''}</small></span>
      </button>
      {onRemove && <button className="btn btn--icon btn--ghost" onClick={() => onRemove(a.id)} title={`移除附件 ${a.name}`} aria-label={`移除附件 ${a.name}`}><X size={14} /></button>}
    </div>
    {open && <div className="modal-backdrop" onClick={() => setOpen(false)}>
      <div className="modal attachment-preview" role="dialog" aria-modal="true" aria-label={a.name} onClick={e => e.stopPropagation()}>
        <div className="modal__head"><h2 className="modal__title">{a.name}</h2><button className="btn btn--icon" aria-label="关闭附件预览" onClick={() => setOpen(false)}><X size={16} /></button></div>
        <div className="modal__body">{preview?.dataUrl ? <img className="attachment-preview__image" src={fullImage || preview.dataUrl} alt={a.name} /> : <pre>{preview?.text ?? preview?.reason ?? '正在读取…'}</pre>}{a.truncated && <p className="hint">文件较长，本轮模型读取前 12000 字；完整原文件保存在本地。</p>}{error && <p role="alert">{error}</p>}</div>
        <div className="modal__foot"><button className="btn btn--ghost" onClick={exportFile}><Download size={14} /> 保存副本</button></div>
      </div>
    </div>}
  </>;
}
