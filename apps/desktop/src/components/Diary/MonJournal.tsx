/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * 桌面日记馆 - 使用者自己的手记 MonJournal
 */
import { useEffect, useState } from 'react';
import { ArrowLeft, Feather } from 'lucide-react';
import { CARNET, DiaryBackdrop } from './DiaryBackdrop';
import { fetchOwnerJournal, saveOwnerJournal, type OwnerJournalDraft, type OwnerJournalState } from '../../utils/diaryApi';
import { useDiaryReading } from '../../utils/diaryReading';
import './diary.css';
import './journal.css';

const today = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
const draftKey = (date: string) => 'luma-owner-journal-draft-v1:' + date;

export function MonJournal({ onBack }: { onBack: () => void }) {
  const [date, setDate] = useState(today);
  const [form, setForm] = useState<OwnerJournalDraft>({ date: '', title: '', body: '', baseVersion: 0 });
  const [catalog, setCatalog] = useState<OwnerJournalState['catalog']>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const { style } = useDiaryReading();

  useEffect(() => {
    let active = true;
    setLoading(true); setError(''); setNotice('');
    fetchOwnerJournal(date).then(state => {
      if (!active) return;
      let draft: OwnerJournalDraft | null = null;
      try {
        const value = JSON.parse(localStorage.getItem(draftKey(date)) || 'null');
        if (value?.date === date && typeof value.title === 'string' && typeof value.body === 'string' && Number.isInteger(value.baseVersion) &&
          (!state.entry || value.title !== state.entry.title || value.body !== state.entry.body)) draft = value;
      } catch { /* Saved entries remain readable without local draft storage. */ }
      setForm(draft || { date, title: state.entry?.title || '', body: state.entry?.body || '', baseVersion: state.entry?.version || 0 });
      setCatalog(state.catalog); setDirty(!!draft);
      if (draft) setNotice('已恢复这台设备上未保存的草稿');
    }).catch(reason => { if (active) setError(reason.message || '手记暂时读不到，请稍后再试'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [date]);

  useEffect(() => {
    if (!dirty || loading || form.date !== date) return;
    try { localStorage.setItem(draftKey(date), JSON.stringify(form)); }
    catch { setError('本机草稿暂时无法保存，请先点“保存手记”，不要直接关闭'); }
  }, [date, form, dirty, loading]);

  const change = (field: 'title' | 'body', value: string) => {
    setForm(current => ({ ...current, [field]: value })); setDirty(true); setNotice('');
  };
  const save = async () => {
    setSaving(true); setError('');
    try {
      const state = await saveOwnerJournal(form);
      setForm({ ...form, baseVersion: state.entry!.version }); setCatalog(state.catalog); setDirty(false);
      try { localStorage.removeItem(draftKey(date)); } catch { /* Durable save already succeeded. */ }
      setNotice('已保存到小屋');
    } catch (reason) { setError(reason instanceof Error ? reason.message : '保存失败，文字还在，请稍后重试'); }
    finally { setSaving(false); }
  };
  const reload = async () => {
    if (dirty && !window.confirm('载入已保存的版本会放弃当前未保存的草稿，继续吗？')) return;
    setLoading(true); setError('');
    try {
      const state = await fetchOwnerJournal(date);
      setForm({ date, title: state.entry?.title || '', body: state.entry?.body || '', baseVersion: state.entry?.version || 0 });
      setCatalog(state.catalog); setDirty(false); setNotice('已载入小屋里保存的版本');
      try { localStorage.removeItem(draftKey(date)); } catch { /* Local drafts are optional. */ }
    } catch (reason) { setError(reason instanceof Error ? reason.message : '暂时读不到，当前文字已保留'); }
    finally { setLoading(false); }
  };
  return (
    <div className="diary-room journal-room">
      <DiaryBackdrop variant="soft" />
      <header className="carnet-head carnet-head--reader">
        <button type="button" onClick={onBack} disabled={saving} className="carnet-float-btn" aria-label="回到花园"><ArrowLeft size={18} /></button>
        <div className="carnet-title"><h1>Mon Journal</h1><p>使用者的手记</p></div>
        <span className="carnet-float-spacer" aria-hidden="true" />
      </header>
      <div className="journal-layout">
        <aside className="journal-catalog" aria-label="我的手记目录">
          <button type="button" className="diary-pager-btn" disabled={saving || loading} onClick={() => setDate(today())}><Feather size={15} />写今天</button>
          <label>手记日期<input aria-label="手记日期" type="date" value={date} disabled={saving || loading} onChange={event => { if (event.target.value) setDate(event.target.value); }} /></label>
          <div className="journal-dates">
            {catalog.length === 0 && <p>这一本等着你慢慢写满。</p>}
            {catalog.map(entry => <button type="button" key={entry.diaryDate} aria-current={date === entry.diaryDate ? 'date' : undefined} disabled={saving || loading} onClick={() => setDate(entry.diaryDate)}>
              <strong>{entry.title || '无题'}</strong><small>{entry.diaryDate}</small>
            </button>)}
          </div>
        </aside>
        <article className="journal-sheet" style={{ ...style, backgroundImage: `url(${CARNET}page.webp)` }}>
          <input className="journal-title" aria-label="手记标题" placeholder="给今天起个名字，也可以不写" maxLength={120} value={form.title} disabled={saving || loading || form.date !== date} onChange={event => change('title', event.target.value)} />
          <textarea className="journal-body" aria-label="手记正文" placeholder={loading ? '正在翻开这一天…' : '想写什么，就写在这里。'} value={form.body} disabled={saving || loading || form.date !== date} onChange={event => change('body', event.target.value)} />
          <footer className="journal-actions">
            <span className={error ? 'journal-error' : ''} role={error ? 'alert' : 'status'}>{error || notice || (dirty ? '尚未保存 · 草稿留在这台设备' : '写给自己的片刻')}</span>
            <button type="button" className="diary-pager-btn" disabled={saving || loading} onClick={() => void reload()}>载入已保存版本</button>
            <button type="button" className="diary-pager-btn journal-save" disabled={saving || loading || !dirty || !form.body.trim()} onClick={() => void save()}>{saving ? '正在保存…' : '保存手记'}</button>
          </footer>
        </article>
      </div>
    </div>
  );
}
